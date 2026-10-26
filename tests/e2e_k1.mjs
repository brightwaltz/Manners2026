// 課題1の通しの検査：node tests/e2e_k1.mjs
// 依存なし。python3 -m http.server と headless Chrome を立て、Chrome DevTools Protocol で操作する。
// k1/index.html で 3 つのゲームを data/k1.json の正解どおりに解き（満点）、わざと間違えた回も解き、
// 作る1・作る2 を書いて点検を ○ にし、提出ファイルを作って形を確かめる。
// E2E_SHOT_DIR を指定すると、375px で各段（学ぶ・問題画面・判定後・結果・作る・提出）の画面を PNG で保存する。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const S = require(join(ROOT, "assets/js/scoring.js"));
const DATA = JSON.parse(readFileSync(join(ROOT, "data/k1.json"), "utf8"));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FORBIDDEN = /名前|氏名|学籍番号|メールアドレス|name|e-?mail/i;
const PAGE = "/k1/index.html";
const GAME_IDS = ["find", "choice", "channel"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(msg) { results.push(["○", msg]); console.log("○ " + msg); }

/* ---------- 起動 ---------- */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`時間切れ：${what}${last ? "（" + last.message + "）" : ""}`);
}

const procs = [];
let profileDir = null;
function cleanup() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch {} }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function startServer() {
  const port = await freePort();
  const p = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", ROOT], { stdio: "ignore" });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(base + "/index.html")).ok, 10000, "http.server の起動");
  return base;
}

async function startChrome(useArm64) {
  profileDir = mkdtempSync(join(tmpdir(), "mn2026-e2e-k1-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    "--disable-background-networking", "--disable-component-update", "--hide-scrollbars", "about:blank"];
  const p = useArm64 ? spawn("arch", ["-arm64", CHROME, ...args], { stdio: "ignore" }) : spawn(CHROME, args, { stdio: "ignore" });
  procs.push(p);
  const portFile = join(profileDir, "DevToolsActivePort");
  const port = await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0], 40000, "Chrome の起動");
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return ver.webSocketDebuggerUrl;
}

/* ---------- CDP ---------- */

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((l) => l(msg));
      }
    };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
}

async function newPage(cdp, base) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = { sessionId, errors: [], requests: [], loaded: 0 };
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") page.errors.push("例外：" + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") page.errors.push("console.error：" + m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      const e = m.params.entry;
      // ブラウザが自動で取りに行く favicon.ico の 404 は想定どおり（data/k1.json の 404 はエラーとして扱う）
      if (!(e.source === "network" && /\/favicon\.ico$/.test(e.url || ""))) page.errors.push("Log：" + e.text + " " + (e.url || ""));
    }
    if (m.method === "Network.requestWillBeSent") page.requests.push(m.params.request.url);
    if (m.method === "Page.loadEventFired") page.loaded++;
  });
  for (const d of ["Runtime", "Log", "Page", "Network"]) await cdp.send(d + ".enable", {}, sessionId);
  page.eval = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error("評価エラー：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  page.call = (fn, ...args) => page.eval(`(${fn})(...${JSON.stringify(args)})`);
  page.width = async (w) => {
    page.w = w;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
  };
  page.goto = async (path) => {
    const n = page.loaded;
    await cdp.send("Page.navigate", { url: base + path }, sessionId);
    await waitFor(() => page.loaded > n, 15000, path + " の読み込み");
    await sleep(300);
  };
  // E2E_SHOT_DIR を指定すると、要素（selector）の範囲を PNG で保存する（目視用。selector が無いときは撮らない）
  let shotN = 0;
  page.shot = async (label, selector) => {
    if (!process.env.E2E_SHOT_DIR || !selector) return;
    await sleep(400); // scrollIntoView の smooth スクロールが落ち着くのを待つ
    const name = String(++shotN).padStart(2, "0") + "_" + page.w + "px_" + label.replace(/[^\w-]+/g, "_");
    const params = { format: "png", captureBeyondViewport: true };
    const clip = await page.eval(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: 0, y: Math.max(0, b.top + scrollY - 8), width: innerWidth, height: Math.ceil(b.height + 16), scale: 1 };
    })()`);
    if (clip) params.clip = clip;
    const r = await cdp.send("Page.captureScreenshot", params, sessionId);
    writeFileSync(join(process.env.E2E_SHOT_DIR, name + ".png"), Buffer.from(r.data, "base64"));
  };
  page.noHScroll = async (label, selector) => {
    await page.shot(label, selector);
    const r = await page.eval(`({ sw: document.documentElement.scrollWidth, iw: innerWidth })`);
    assert.ok(r.sw <= r.iw, `${label}：横スクロールが出ています（scrollWidth ${r.sw} > innerWidth ${r.iw}）`);
  };
  return page;
}

/* ---------- ページの中で動かす関数 ---------- */

// 入力欄の属性とラベルに、個人情報を求める語がないか
function pageFormFields() {
  return Array.from(document.querySelectorAll("input, textarea, select")).map((e) => ({
    tag: e.tagName,
    attrs: ["name", "id", "placeholder", "aria-label", "title", "autocomplete"].map((a) => e.getAttribute(a) || "").join(" "),
    labels: Array.from(e.labels || []).map((l) => l.textContent).join(" ")
  }));
}

// 1 つのゲームの今の問題に答える（判定はまだ押さない。choice は選んだ時点で判定される）。
// mode は "correct" か "mixed"。mixed では n が偶数の問題をわざと間違える
function pageAnswer(gameDef, mode, n) {
  const S = window.MNScoring;
  const box = document.querySelector(`[data-game="${gameDef.id}"]`);
  const card = box.querySelector("[data-item-id]");
  if (!card) throw new Error("問題が表示されていません");
  const id = card.getAttribute("data-item-id");
  const item = gameDef.items.find((x) => x.id === id);
  const wrong = mode === "mixed" && n % 2 === 0;
  let answer;
  if (gameDef.type === "find") {
    const map = S.findChunkMap(item);
    const positions = Object.keys(map).filter((p) => card.querySelector(`[data-chunk="${p}"]`));
    // note のかたまりはタップできない
    if (card.querySelector("[data-note] [data-chunk], [data-note][data-chunk]")) throw new Error("find：note がタップできます");
    const errs = item.errors.map((e) => e.id);
    const picked = [];
    for (const e of wrong ? errs.slice(0, 1) : errs) picked.push(...positions.filter((p) => map[p] === e));
    if (wrong) {
      const extra = positions.find((p) => !map[p]);
      if (extra) picked.push(extra);
    }
    picked.forEach((p) => card.querySelector(`[data-chunk="${p}"]`).click());
    let missing = item.missing_answer.slice();
    if (wrong) {
      const bad = item.missing_options.map((o) => o.id).find((m) => !item.missing_answer.includes(m));
      missing = missing.slice(1);
      if (bad) missing.push(bad);
    }
    missing.forEach((m) => card.querySelector(`[data-missing="${m}"]`).click());
    answer = {
      picked: Object.keys(map).filter((p) => picked.includes(p)).sort(),
      missing: item.missing_options.map((o) => o.id).filter((m) => missing.includes(m))
    };
  } else {
    answer = wrong ? item.options.find((o) => o.id !== item.answer).id : item.answer;
    card.querySelector(`[data-opt="${answer}"]`).click();
    const fb = card.querySelector('[data-role="feedback"]');
    if (!fb || !fb.textContent.includes(answer === item.answer ? "○" : "×")) throw new Error("choice：○× の表示がありません");
  }
  return { id, answer };
}

// find の判定を押す
function pageJudge(gid) {
  const card = document.querySelector(`[data-game="${gid}"] [data-item-id]`);
  card.querySelector('[data-action="judge"]').click();
  if (!card.querySelector('[data-role="feedback"]')) throw new Error("find：判定の表示がありません");
  if (card.querySelectorAll(".mark-ok, .mark-ng").length === 0) throw new Error("find：○× がありません");
  return true;
}

// 「次へ」か「結果を見る」を押す。最後なら結果を返す
function pageNext(gid) {
  const box = document.querySelector(`[data-game="${gid}"]`);
  const next = box.querySelector('[data-item-id] [data-action="next"], [data-item-id] [data-action="finish"]');
  const last = next.getAttribute("data-action") === "finish";
  next.click();
  if (!last) return null;
  const res = box.querySelector('[data-role="result"]');
  return {
    score: Number(res.querySelector("[data-result-score]").textContent),
    max: Number(res.querySelector("[data-result-max]").textContent),
    rank: res.querySelector("[data-result-rank]").textContent
  };
}

function pageStart(gid) {
  const box = document.querySelector(`[data-game="${gid}"]`);
  box.querySelector('[data-action="start"],[data-action="retry"]').click();
  return !!box.querySelector("[data-item-id]");
}

function pageSet(fid, field, value) {
  const e = document.querySelector(`[data-compose="${fid}"] [data-field="${field}"]`);
  e.value = value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
  return e.value;
}

function pageChecks(fid) {
  return Object.fromEntries(Array.from(document.querySelectorAll(`[data-compose="${fid}"] [data-check]`))
    .map((li) => [li.getAttribute("data-check"), li.classList.contains("on")]));
}

function pageExport(aiUsed) {
  const box = document.getElementById("submit");
  const out = {};
  const anyChecked = Array.from(box.querySelectorAll('input[type="radio"]')).some((r) => r.checked);
  if (!anyChecked) {
    box.querySelector('[data-action="export"]').click();
    out.blocked = !!box.querySelector('[data-role="submit-blocked"]');
  }
  box.querySelector('[data-choice="consent:yes"]').click();
  box.querySelector(`[data-choice="ai:${aiUsed ? "yes" : "no"}"]`).click();
  if (aiUsed) {
    const d = box.querySelector('[data-field="ai-detail"]');
    d.value = "作る3で、生成AIにメールの下書きを書かせた";
    d.dispatchEvent(new Event("input", { bubbles: true }));
  }
  box.querySelector('[data-action="export"]').click();
  out.anyway = !!box.querySelector('[data-action="export-anyway"]');
  out.text = box.querySelector('[data-role="export-text"]').value;
  out.warnings = Array.from(box.querySelectorAll('[data-role="submit-warning"]')).map((e) => e.textContent);
  out.status = Array.from(box.querySelectorAll(".status-table td")).map((e) => e.textContent);
  out.msg = box.querySelector('[data-role="submit-msg"]').textContent;
  return out;
}

// 進み具合を更新して、各行の [見出し, 状態] を返す
function pageStatus() {
  const box = document.getElementById("submit");
  box.querySelector('[data-action="refresh-status"]').click();
  return Array.from(box.querySelectorAll(".status-table tr")).map((tr) => [tr.querySelector("th").textContent, tr.querySelector("td").textContent]);
}

// 作る1の場面（radio）と宛先の placeholder の様子
function pageMailForm() {
  const g = document.querySelector('[data-compose="mail"] [data-field="scene"]');
  const labels = Array.from(g.querySelectorAll("label"));
  return {
    tag: g.tagName,
    legend: g.querySelector("legend").textContent,
    options: labels.map((l) => l.querySelector("input").value),
    texts: labels.map((l) => l.textContent),
    heights: labels.map((l) => l.getBoundingClientRect().height),
    // 文が切れずに折り返している（横にはみ出していない）
    clipped: labels.filter((l) => l.scrollWidth > l.clientWidth + 1).length,
    vertical: labels.every((l, i) => i === 0 || l.getBoundingClientRect().top >= labels[i - 1].getBoundingClientRect().bottom),
    value: g.value,
    placeholder: document.querySelector('[data-compose="mail"] [data-field="to"]').getAttribute("placeholder"),
    bodyValue: document.querySelector('[data-compose="mail"] [data-field="body"]').value
  };
}

// 場面の選択肢をタップして、保存された値を返す
function pagePickScene(id) {
  document.querySelector(`[data-compose="mail"] [data-field="scene"] input[value="${id}"]`).closest("label").click();
  return {
    value: document.querySelector('[data-compose="mail"] [data-field="scene"]').value,
    saved: JSON.parse(localStorage.getItem("mn2026.k1.creative.mail") || "{}").scene
  };
}

// find の決まった 1 問を先頭に出して始める（記録には残らない。最後にページを読み直して捨てる）
function pageFindItem(itemId) {
  const orig = MN.shuffle;
  MN.shuffle = (a) => { const r = orig(a); r.sort((x, y) => (y.id === itemId) - (x.id === itemId)); return r; };
  const box = document.querySelector('[data-game="find"]');
  box.querySelector('[data-action="start"],[data-action="retry"]').click();
  MN.shuffle = orig;
  const card = box.querySelector("[data-item-id]");
  box.scrollIntoView({ block: "start" });
  return { id: card.getAttribute("data-item-id"), br: card.querySelectorAll(".doc br").length };
}

function pageFindJudge(item) {
  const card = document.querySelector('[data-game="find"] [data-item-id]');
  const map = window.MNScoring.findChunkMap(item);
  const first = Object.keys(map).find((p) => map[p]);
  card.querySelector(`[data-chunk="${first}"]`).click();
  card.querySelector('[data-action="judge"]').click();
  return { br: card.querySelectorAll(".doc br").length, feedback: !!card.querySelector('[data-role="feedback"]') };
}

/* ---------- 入力の例 ---------- */

const MAIL = {
  scene: "A",
  to: "momose@example.ac.jp",
  subject: "レポート課題の締切延長のお願い（情報リテラシー 木曜2限）",
  body: [
    "百瀬先生",
    "",
    "お世話になっております。工学部1年の玉川みらいです。",
    "情報リテラシーのレポート課題（締切 11月20日）について、締切の延長をお願いしたくご連絡しました。",
    "体調を崩してしまい、締切までの提出が難しくなりました。",
    "11月23日まで延ばしていただくことはできますでしょうか。",
    "ご迷惑をおかけし申し訳ありません。",
    "",
    "よろしくお願いいたします。",
    "",
    "工学部 1年 玉川 みらい（学籍番号 99Z9999）",
    "mirai.tamagawa@example.ac.jp"
  ].join("\n")
};

const NGMAIL = {
  scene: "1年生が、ゼミの先生に面談の日程を決めてもらうために送るメール",
  subject: "お願い",
  body: [
    "九条さん",
    "",
    "面談の件ですが、来週ならいつでもいいです。",
    "決まったら今日中に返事ください。",
    "あと資料も全部送ってください。",
    "よろしく",
    "",
    "工学部 1年 玉川 みらい（学籍番号 99Z9999）",
    "mirai.tamagawa@example.ac.jp",
    "（この本文はわざと間違いを入れています。100 字を超えるように少し足しています。）"
  ].join("\n"),
  answer1: "宛名が「九条さん」になっている。先生には「先生」を付けるので「九条先生」と書く。",
  answer2: "件名が「お願い」だけで用件が分からない。「面談日程のご相談（工学部1年 玉川みらい）」と書く。",
  answer3: "「今日中に返事ください」と期限を押しつけている。候補日を3つ示し、お願いの形で書く。",
  answer4: ""
};

/* ---------- 本体 ---------- */

async function main() {
  // 前提：data/k1.json の game は find・choice・channel の順
  assert.deepEqual(DATA.games.map((g) => g.id), GAME_IDS, "data/k1.json の games の順");

  const base = await startServer();
  ok("http.server を起動：" + base);
  let wsUrl;
  try {
    wsUrl = await startChrome(false);
  } catch (e) {
    console.log("Chrome の起動に失敗したので arch -arm64 で試します：" + e.message);
    const chrome = procs.pop();
    try { chrome.kill("SIGKILL"); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    wsUrl = await startChrome(true);
  }
  const cdp = new CDP(wsUrl);
  await cdp.open();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
  ok("headless Chrome を起動");

  const page = await newPage(cdp, base);
  const allAttempts = {}; // gid → [{ answers, score }]

  async function load() {
    await page.goto(PAGE);
    await waitFor(() => page.eval(`document.querySelectorAll("[data-game]").length === ${DATA.games.length} && document.querySelectorAll("[data-compose]").length === 3 && !!document.querySelector('[data-action="export"]')`), 10000, "k1 の組み立て");
  }

  async function checkFields(label) {
    const fields = await page.call(pageFormFields);
    for (const f of fields) {
      assert.ok(!FORBIDDEN.test(f.attrs) && !FORBIDDEN.test(f.labels), `${label}：入力欄に個人情報を求める語があります ${JSON.stringify(f)}`);
    }
    return fields.length;
  }

  // 1 つのゲームを最後まで解く。shots が true なら第 1 問の問題画面と判定後、結果を撮る
  async function play(g, mode, shots) {
    assert.ok(await page.call(pageStart, g.id), `${g.id}：開始できません`);
    const answers = {};
    let res = null;
    for (let n = 0; !res; n++) {
      if (shots && n === 0) await page.noHScroll(`${g.id}_question`, `[data-game="${g.id}"]`);
      else await page.noHScroll(`${g.id} 第${n + 1}問`);
      const a = await page.call(pageAnswer, g, mode, n);
      answers[a.id] = a.answer;
      if (g.type === "find") await page.call(pageJudge, g.id);
      if (shots && n === 0) await page.noHScroll(`${g.id}_judged`, `[data-game="${g.id}"]`);
      else await page.noHScroll(`${g.id} 第${n + 1}問 判定後`);
      res = await page.call(pageNext, g.id);
    }
    if (shots) await page.noHScroll(`${g.id}_result`, `[data-game="${g.id}"]`);
    assert.equal(Object.keys(answers).length, g.items.length, `${g.id}：解いた問題の数`);
    return { answers, ...res };
  }

  async function verifySubmission(text, expectAttempts) {
    const sub = JSON.parse(text);
    assert.equal(text, JSON.stringify(sub, null, 2) + "\n", "2 スペースの整形ではありません");
    const v = S.validateSubmission(sub);
    assert.ok(v.ok, "validateSubmission 不合格：" + v.errors.join(" / "));
    assert.equal(sub.kadai, 1);
    assert.equal(sub.data_version, DATA.version);
    const ua = await page.eval("navigator.userAgent");
    assert.ok(!text.includes(ua) && !/Mozilla|Chrome\/|userAgent|platform/i.test(text), "端末情報が入っています");
    assert.deepEqual(Object.keys(sub.games).sort(), [...GAME_IDS].sort(), "games のキー");
    for (const g of DATA.games) {
      const atts = sub.games[g.id].attempts;
      assert.equal(atts.length, expectAttempts, `${g.id} の挑戦の数`);
      atts.forEach((a, i) => {
        const re = S.scoreGame(g, a.answers);
        assert.equal(a.score, re.score, `${g.id} 挑戦${i + 1}：ファイルの点数と再計算が違います`);
        assert.equal(a.max, re.max, `${g.id} 挑戦${i + 1}：満点が違います`);
        assert.equal(a.score, allAttempts[g.id][i].score, `${g.id} 挑戦${i + 1}：画面の点数と再計算が違います`);
        const norm = (ans) => g.type !== "find" ? ans : Object.fromEntries(Object.entries(ans).map(([id, v]) => [id, { picked: [...v.picked].sort(), missing: [...v.missing].sort() }]));
        assert.deepEqual(norm(a.answers), norm(allAttempts[g.id][i].answers), `${g.id} 挑戦${i + 1}：解答の記録が操作と違います`);
      });
    }
    // 作るは mail・ngmail（必須）と aimail（任意、空のまま）
    assert.deepEqual(Object.keys(sub.creative).sort(), ["aimail", "mail", "ngmail"]);
    for (const [k, val] of Object.entries(MAIL)) assert.equal(sub.creative.mail[k], val, `creative.mail.${k}`);
    for (const [k, val] of Object.entries(NGMAIL)) assert.equal(sub.creative.ngmail[k], val, `creative.ngmail.${k}`);
    return sub;
  }

  // 1 回目：幅 375px、正解だけ（画面を撮る）
  // 2 回目：幅 1280px、わざと間違い混じり
  const passes = [
    { width: 375, mode: "correct", aiUsed: false, shots: true },
    { width: 1280, mode: "mixed", aiUsed: true, shots: false }
  ];
  for (let pi = 0; pi < passes.length; pi++) {
    const { width, mode, aiUsed, shots } = passes[pi];
    await page.width(width);
    await load();
    await page.noHScroll(`読み込み直後`);
    const nFields = await checkFields(`k1 ${width}px`);

    // 題の下のリードと、学ぶ（10 枚）
    const top = await page.eval(`({
      lead: (document.querySelector(".site-head .lead") || {}).textContent,
      pending: document.querySelectorAll("main .pending").length,
      learn: Array.from(document.querySelectorAll("#learn [data-learn] h3")).map(e => e.textContent),
      ex: document.querySelectorAll("#learn [data-role=learn-ex]").length,
      games: Array.from(document.querySelectorAll("[data-game] h3")).map(e => e.textContent),
      compose: Array.from(document.querySelectorAll("[data-compose]")).map(e => e.getAttribute("data-compose"))
    })`);
    assert.equal(top.lead, "先生や会社に送るメールには、決まった形があります。形を覚えると、相手に早く正確に伝わり、返事ももらいやすくなります。");
    assert.equal(top.pending, 0, "準備中の表示が残っています");
    assert.deepEqual(top.learn, DATA.learn.map((s, i) => `${i + 1}. ${s.h}`));
    assert.deepEqual(top.games, DATA.games.map((g) => g.title));
    assert.deepEqual(top.compose, ["mail", "ngmail", "aimail"]);
    await page.noHScroll("learn", shots && "#learn-sec");
    ok(`k1（${width}px）：リード、学ぶ ${top.learn.length} 枚（例の枠 ${top.ex} 個）、ゲーム 3 つ、作る 3 つ、入力欄 ${nFields} 個に個人情報を求める語なし、横スクロールなし`);

    for (const g of DATA.games) {
      const r = await play(g, mode, shots);
      const re = S.scoreGame(g, r.answers);
      assert.equal(r.score, re.score, `${g.id}：画面の点数 ${r.score} と再計算 ${re.score} が違います`);
      assert.equal(r.max, re.max);
      assert.equal(r.rank, S.rank(re.score, re.max));
      if (mode === "correct") assert.equal(r.score, r.max, `${g.id}：正解どおりなのに満点ではありません`);
      else assert.ok(r.score < r.max, `${g.id}：間違い混じりなのに満点です`);
      (allAttempts[g.id] ||= []).push({ answers: r.answers, score: r.score });
      ok(`k1（${width}px）${g.id}：${mode === "correct" ? "正解どおり" : "間違い混じり"} ${r.score} / ${r.max}（${r.rank}）画面＝scoring.js の再計算`);
    }

    if (pi === 0) {
      // 作る1：場面は縦に並んだ radio（必須）、宛先の placeholder、本文は空（署名も自分で書く）
      const mf = await page.call(pageMailForm);
      assert.equal(mf.tag, "FIELDSET");
      assert.equal(mf.legend, "場面");
      assert.deepEqual(mf.options, ["A", "B", "C", "D"]);
      assert.ok(mf.texts[2].startsWith("C：会社（株式会社サンプル工業 人事部 一ノ瀬様）") && mf.texts[2].endsWith("日程の変更をお願いする。"), "場面 C の全文：" + mf.texts[2]);
      assert.ok(mf.heights.every((h) => h >= 44), "場面の行の高さ：" + mf.heights);
      assert.equal(mf.clipped, 0, "場面の文が横にはみ出しています");
      assert.equal(mf.vertical, true, "場面の選択肢が縦に並んでいません");
      assert.equal(mf.value, "");
      assert.equal(mf.placeholder, "例：momose@example.ac.jp");
      assert.equal(mf.bodyValue, "", "本文に最初の文が入っています");
      let st = await page.call(pageStatus);
      assert.deepEqual(st.find((r) => r[0] === "作る「メールを書く」"), ["作る「メールを書く」", "× まだ（必須の欄：場面）"]);
      const pick = await page.call(pagePickScene, "B");
      assert.deepEqual(pick, { value: "B", saved: "B" }, "場面をタップしても保存されません");
      await page.noHScroll("compose_mail_radio", '[data-compose="mail"]');
      st = await page.call(pageStatus);
      assert.deepEqual(st.find((r) => r[0] === "作る「メールを書く」"), ["作る「メールを書く」", "○ 記入あり"]);
      ok("作る1：場面は縦に並んだ radio（4 つ、各行 44px 以上、全文を折り返して表示、選ぶと保存）、未選択なら進み具合に「× まだ（必須の欄：場面）」、宛先の placeholder、本文は空");

      // 何も書いていないとき
      const c0 = await page.call(pageChecks, "mail");
      assert.equal(c0.subject_len, false);
      assert.equal(c0.greeting, false);
      assert.equal(c0.self_intro, false);
      assert.equal(c0.closing, false);
      assert.equal(c0.signature, false);
      assert.equal(c0.body_len, false);
      // 点検が誤りに反応すること
      await page.call(pageSet, "mail", "body", MAIL.body.replace("百瀬先生", "百瀬先生様"));
      let c = await page.call(pageChecks, "mail");
      assert.equal(c.no_double, false, "「先生様」で × になりません");
      await page.call(pageSet, "mail", "body", "こんにちは\nはじめまして\nこんばんは\n" + MAIL.body);
      c = await page.call(pageChecks, "mail");
      assert.equal(c.greeting, false, "宛名が最初の 3 行にないのに ○ です");
      await page.call(pageSet, "mail", "body", "\n  \n株式会社サンプル工業\n人事部 一ノ瀬様\n\n" + MAIL.body.split("\n").slice(2).join("\n"));
      c = await page.call(pageChecks, "mail");
      assert.equal(c.greeting, true, "会社あてを 2 行に書いた宛名で ○ になりません");
      await page.call(pageSet, "mail", "body", MAIL.body.replace("工学部1年の玉川みらいです。", "工学部1年です。\n\n\n"));
      c = await page.call(pageChecks, "mail");
      assert.equal(c.self_intro, false, "名乗りが最初の 5 行にない（署名にだけある）のに ○ です");
      await page.call(pageSet, "mail", "body", MAIL.body.replace("株式会社", "").replace("百瀬先生", "一ノ瀬様　御中"));
      c = await page.call(pageChecks, "mail");
      assert.equal(c.no_double, false, "「様　御中」で × になりません");
      await page.call(pageSet, "mail", "body", MAIL.body + "\n\n\n（追記）");
      c = await page.call(pageChecks, "mail");
      assert.equal(c.signature, false, "署名が最後の 3 行にないのに ○ です");
      // 正しい入力
      for (const [k, val] of Object.entries(MAIL)) await page.call(pageSet, "mail", k, val);
      c = await page.call(pageChecks, "mail");
      assert.deepEqual(c, { subject_len: true, greeting: true, no_double: true, self_intro: true, closing: true, signature: true, body_len: true });
      ok("作る1：点検 7 つが誤りに反応し（宛名は最初の 3 行、名乗りは最初の 5 行。会社あての 2 行の宛名は ○）、正しい入力ですべて ○");

      await page.call(pageSet, "ngmail", "answer3", "短い");
      c = await page.call(pageChecks, "ngmail");
      assert.equal(c.answers, false, "答えが 2 つなのに ○ です");
      for (const [k, val] of Object.entries(NGMAIL)) await page.call(pageSet, "ngmail", k, val);
      c = await page.call(pageChecks, "ngmail");
      assert.deepEqual(c, { scene_len: true, body_len: true, answers: true });
      assert.deepEqual(await page.call(pageChecks, "aimail"), { fixes: false });
      ok("作る2：点検 3 つが ○（答えが 2 つのときは −）、作る3 は空のまま");
      await page.noHScroll("compose", "#compose-sec");
    }

    const ex = await page.call(pageExport, aiUsed);
    if (pi === 0) {
      assert.equal(ex.blocked, true, "同意を選ばなくても作れてしまいます");
      ok("提出：同意と生成AIを選ぶ前は作れない");
    }
    // 架空の人物の学籍番号と example のアドレスだけなので、個人情報の警告は出ずにそのまま作られる
    assert.equal(ex.anyway, false, "個人情報の警告が出ました：" + ex.warnings.join(" / "));
    assert.deepEqual(ex.warnings, [], "注意が出ています：" + ex.warnings.join(" / "));
    assert.ok(ex.text, "提出ファイルの中身がありません");
    assert.equal(ex.status.length, 5, "進み具合の行数");
    assert.ok(ex.status.every((s) => s.startsWith("○")), "進み具合に × があります：" + ex.status.join(" / "));
    assert.ok(ex.msg.includes("○ ダウンロードを始めました。保存したファイルが見つからないときは、下の「提出ファイルの中身」をコピーして、メモ帳などで「マナー課題1_提出.txt」として保存してください。"), "作成後の案内：" + ex.msg);
    assert.ok(!ex.msg.includes("ダウンロードしました"), "「ダウンロードしました」が残っています");
    const sub = await verifySubmission(ex.text, pi + 1);
    assert.equal(sub.consent_showcase, true);
    assert.equal(sub.ai_use.used, aiUsed);
    await page.noHScroll("submit", shots && "#submit-sec");
    ok(`提出（${width}px）：validateSubmission 合格、kadai 1、全挑戦の点数＝scoring.js の再計算、creative に mail・ngmail（aimail は空）、進み具合すべて ○、横スクロールなし`);
  }

  // find の f1・f5（375px）：空白・改行だけのかたまりも <br> になり、段落が分かれて見える
  await page.width(375);
  await load();
  const findDef = DATA.games.find((g) => g.id === "find");
  const before = await page.eval(`localStorage.getItem("mn2026.k1.game.find")`);
  for (const id of ["f1", "f5"]) {
    const item = findDef.items.find((x) => x.id === id);
    // 期待する <br> の数：note・ふつうのかたまり・空白だけのかたまりの改行すべて（header には改行がない）
    const want = item.chunks.reduce((n, c) => n + (c.t.match(/\n/g) || []).length, 0);
    await load();
    const q = await page.call(pageFindItem, id);
    assert.equal(q.id, id);
    assert.equal(q.br, want, `${id}：改行の数（<br>）が ${q.br}、期待は ${want}`);
    await page.noHScroll(`find_${id}_question`, '[data-game="find"]');
    const j = await page.call(pageFindJudge, item);
    assert.ok(j.feedback);
    assert.equal(j.br, want, `${id}：判定後の改行の数`);
    await page.noHScroll(`find_${id}_judged`, '[data-game="find"]');
  }
  await load();
  assert.equal(await page.eval(`localStorage.getItem("mn2026.k1.game.find")`), before, "撮影用の途中の挑戦が記録されました");
  ok("find f1・f5（375px）：空白・改行だけのかたまり（\"\\n\\n\" など）も <br> になり段落が分かれる（判定後も同じ）、途中でやめた挑戦は記録されない");

  const keys = await page.eval(`Object.keys(localStorage)`);
  assert.ok(keys.length > 0 && keys.every((k) => k.startsWith("mn2026.")), "mn2026. 以外のキー：" + keys);
  ok(`localStorage のキー ${keys.length} 個はすべて mn2026. で始まる`);

  const external = page.requests.filter((u) => !u.startsWith(base) && !/^(data|blob|about):/.test(u));
  assert.deepEqual(external, [], "外部への通信：" + external.join(", "));
  ok(`通信はすべて ${base} の中（${page.requests.length} 件）`);

  assert.deepEqual(page.errors, [], "JS のエラー：\n" + page.errors.join("\n"));
  ok("JS のエラーなし");
  console.log(`\n合格（${results.length} 項目）`);
}

main().then(() => { cleanup(); process.exit(0); }, (e) => {
  console.error("\n× 不合格：" + (e && e.stack || e));
  cleanup();
  process.exit(1);
});
