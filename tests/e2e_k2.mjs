// 課題2の通しの検査：node tests/e2e_k2.mjs
// 依存なし。起動と CDP の部分は tests/e2e.mjs と同じ。
// k2/index.html で 3 つのゲームを data/k2.json の正解どおりに解き（幅 375px）、わざと間違い混じりでも解き（幅 1280px）、
// 作る1・2 の点検、提出ファイル、横スクロール、JS のエラーまで確かめる。
// E2E_SHOT_DIR を指定すると、375px の各段（学ぶ・問題・判定後・結果・作る・提出）を PNG で保存する。
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
const K2 = JSON.parse(readFileSync(join(ROOT, "data/k2.json"), "utf8"));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FORBIDDEN = /名前|氏名|学籍番号|メールアドレス|name|e-?mail/i;

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
  profileDir = mkdtempSync(join(tmpdir(), "mn2026-e2e-"));
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
      // data/kN.json がまだ無いときの 404 と、ブラウザが自動で取りに行く favicon.ico の 404 は想定どおり
      if (!(e.source === "network" && /\/data\/k\d\.json$|\/favicon\.ico$/.test(e.url || ""))) page.errors.push("Log：" + e.text + " " + (e.url || ""));
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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
  };
  page.goto = async (path) => {
    const n = page.loaded;
    await cdp.send("Page.navigate", { url: base + path }, sessionId);
    await waitFor(() => page.loaded > n, 15000, path + " の読み込み");
    await sleep(300);
  };
  // E2E_SHOT_DIR を指定すると、横スクロールを確かめるたびに画面を PNG で保存する（目視用）
  let shotN = 0;
  page.shot = async (label) => {
    if (!process.env.E2E_SHOT_DIR) return;
    label = String(++shotN).padStart(2, "0") + "_" + label;
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    writeFileSync(join(process.env.E2E_SHOT_DIR, label.replace(/[^\w.-]+/g, "_") + ".png"), Buffer.from(r.data, "base64"));
  };
  // 要素だけを撮る（段ごとの目視用）
  page.shotSel = async (sel, label) => {
    if (!process.env.E2E_SHOT_DIR) return;
    const r = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
      const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: Math.max(1, b.width), height: Math.max(1, b.height) }; })()`);
    if (!r) throw new Error("撮る要素がありません：" + sel);
    label = String(++shotN).padStart(2, "0") + "_" + label;
    const s = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...r, scale: 1 } }, sessionId);
    writeFileSync(join(process.env.E2E_SHOT_DIR, label.replace(/[^\w.-]+/g, "_") + ".png"), Buffer.from(s.data, "base64"));
  };
  page.noHScroll = async (label) => {
    await page.shot(label);
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

function pageOverflow() {
  return document.documentElement.scrollWidth > innerWidth ? document.documentElement.scrollWidth : 0;
}

function pageStartGame(gid) {
  const box = document.querySelector(`[data-game="${gid}"]`);
  box.querySelector('[data-action="start"],[data-action="retry"]').click();
  const card = box.querySelector("[data-item-id]");
  if (!card) throw new Error("問題が表示されていません");
  box.scrollIntoView({ block: "start" });
  return card.getAttribute("data-item-id");
}

// いま出ている 1 問に答える。wrong なら間違える
function pageAnswer(gameDef, wrong) {
  const S = window.MNScoring;
  const box = document.querySelector(`[data-game="${gameDef.id}"]`);
  const card = box.querySelector("[data-item-id]");
  const id = card.getAttribute("data-item-id");
  const item = gameDef.items.find((x) => x.id === id);
  const out = { id };
  if (gameDef.type === "find") {
    const map = S.findChunkMap(item);
    const positions = Object.keys(map).filter((p) => card.querySelector(`[data-chunk="${p}"]`));
    // note（読んだ資料）のかたまりはタップできない
    out.noteTappable = !!card.querySelector("[data-note] [data-chunk], [data-note][data-chunk]");
    out.missingBoxes = card.querySelectorAll("[data-missing]").length;
    const errs = item.errors.map((e) => e.id);
    const picked = [];
    for (const e of wrong ? errs.slice(0, 1) : errs) {
      for (const p of positions.filter((p) => map[p] === e).slice(0, 1)) picked.push(p);
    }
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
    out.answer = {
      picked: Object.keys(map).filter((p) => picked.includes(p)).sort(),
      missing: item.missing_options.map((o) => o.id).filter((m) => missing.includes(m))
    };
    card.querySelector('[data-action="judge"]').click();
  } else if (gameDef.type === "choice") {
    const btns = Array.from(card.querySelectorAll("[data-opt]"));
    out.optIds = btns.map((b) => b.getAttribute("data-opt"));
    out.optTexts = btns.map((b) => b.textContent);
    const choose = wrong ? item.options.find((o) => o.id !== item.answer).id : item.answer;
    card.querySelector(`[data-opt="${choose}"]`).click();
    out.answer = choose;
  } else if (gameDef.type === "order") {
    const judge = card.querySelector('[data-action="judge"]');
    const initial = Array.from(card.querySelectorAll('[data-zone="pool"] [data-piece]')).map((b) => b.getAttribute("data-piece"));
    out.initialIsAnswer = initial.join() === item.answer.join();
    const seq = wrong ? item.answer.slice().reverse() : item.answer.slice();
    seq.forEach((p) => card.querySelector(`[data-zone="pool"] [data-piece="${p}"]`).click());
    out.judgeEnabled = !judge.disabled;
    judge.click();
    out.answer = seq;
  }
  const fb = card.querySelector('[data-role="feedback"]');
  out.feedback = !!fb;
  out.marks = card.querySelectorAll(".mark-ok, .mark-ng").length;
  out.feedbackText = fb ? fb.textContent : "";
  const next = card.querySelector('[data-action="next"],[data-action="finish"]');
  out.last = next.getAttribute("data-action") === "finish";
  return out;
}

function pageNext(gid) {
  const box = document.querySelector(`[data-game="${gid}"]`);
  box.querySelector('[data-action="next"],[data-action="finish"]').click();
  const res = box.querySelector('[data-role="result"]');
  if (!res) return null;
  return {
    score: Number(res.querySelector("[data-result-score]").textContent),
    max: Number(res.querySelector("[data-result-max]").textContent),
    rank: res.querySelector("[data-result-rank]").textContent
  };
}

// 作るの欄に値を入れ（キーは "フォームid.欄id"）、各フォームの点検の ○ を返す
function pageFill(values) {
  for (const key of Object.keys(values)) {
    const [fid, field] = key.split(".");
    const e = document.querySelector(`[data-compose="${fid}"] [data-field="${field}"]`);
    if (!e) throw new Error("欄がありません：" + key);
    e.value = values[key];
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const checks = {};
  document.querySelectorAll("[data-compose]").forEach((f) => {
    checks[f.getAttribute("data-compose")] = Object.fromEntries(
      Array.from(f.querySelectorAll("[data-check]")).map((li) => [li.getAttribute("data-check"), li.classList.contains("on")]));
  });
  return checks;
}

function pageComposeInfo() {
  return Array.from(document.querySelectorAll("[data-compose]")).map((f) => ({
    id: f.getAttribute("data-compose"),
    title: f.querySelector("h3") ? f.querySelector("h3").textContent : "",
    intro: f.querySelector("p") ? f.querySelector("p").textContent : "",
    fields: Array.from(f.querySelectorAll("[data-field]")).map((e) => ({
      id: e.getAttribute("data-field"),
      tag: e.tagName,
      // radio は fieldset の legend が見出し
      label: e.tagName === "FIELDSET" ? e.querySelector("legend").textContent : (e.labels && e.labels[0] ? e.labels[0].textContent : ""),
      max: e.getAttribute("maxlength"),
      rows: e.getAttribute("rows"),
      placeholder: e.getAttribute("placeholder"),
      options: e.tagName === "SELECT" ? Array.from(e.options).map((o) => o.value)
        : e.tagName === "FIELDSET" ? Array.from(e.querySelectorAll('input[type="radio"]')).map((r) => r.value) : null,
      value: e.value
    })),
    checks: Array.from(f.querySelectorAll("[data-check]")).map((li) => li.getAttribute("data-check"))
  }));
}

function pageExport() {
  const box = document.getElementById("submit");
  box.querySelector('[data-choice="consent:yes"]').click();
  box.querySelector('[data-choice="ai:no"]').click();
  box.querySelector('[data-action="export"]').click();
  return {
    text: box.querySelector('[data-role="export-text"]').value,
    warnings: Array.from(box.querySelectorAll('[data-role="submit-warning"]')).map((e) => e.textContent),
    status: Array.from(box.querySelectorAll(".status-table tr")).map((tr) => [tr.querySelector("th").textContent, tr.querySelector("td").textContent])
  };
}

/* ---------- 入力する値 ---------- */

const BOOK = "山本花子（2022）『眠りの科学入門』みどり書房.";
const PAPER = "佐々木一郎（2021）「通学時間と学習時間の関係」『教育データ研究』12巻3号, pp.20-31.";
const WEB = "みどり市環境課（2025）「ごみの分け方と出し方」みどり市ホームページ, https://www.example.jp/gomi/（閲覧日：2026年11月10日）";
const NEWS = "「大学生の睡眠、平日は6時間台」『みどり新聞』2026年5月10日, 朝刊, 23面.";
const FILL = {
  "cite.theme": "T2",
  "cite.src1_kind": "book",
  "cite.src1_ref": BOOK,
  "cite.src1_quote": "「睡眠時間が6時間を下回る日が続くと、翌日の記憶テストの成績が下がる傾向がある。」",
  "cite.src1_use": "山本（2022）は「睡眠時間が6時間を下回る日が続くと、翌日の記憶テストの成績が下がる傾向がある」と述べている（45ページ）。レポートの締切前に徹夜をすると、かえって学習の効率が落ちると考える。",
  "cite.src2_kind": "paper",
  "cite.src2_ref": PAPER,
  "cite.src2_quote": "「通学時間が長い学生ほど、自宅での学習時間が短くなる傾向が見られた。」",
  "cite.src2_use": "佐々木（2021）によれば、通学時間が長い学生ほど、自宅での学習時間は短くなる傾向がある。だからこそ、通学中の時間の使い方を工夫することが大切だと考える。",
  "judgemake.scene": "授業で配られたスライドの図を、自分の発表スライドにそのまま貼り、出典を書いた。その発表スライドを、あとで自分の SNS に公開した。",
  "judgemake.answer": "cond",
  "judgemake.reason": "授業の中での利用は著作権法35条で認められるが、SNS への公開は授業の外になる。図を本文で論じる必然性があり、自分の文章が主で、出典が書かれていれば引用として使える。"
};
const CITE_FIELDS = ["theme", "src1_kind", "src1_ref", "src1_quote", "src1_use", "src2_kind", "src2_ref", "src2_quote", "src2_use"];
const CITE_CHECKS = ["theme", "src1_year", "src2_year", "src1_form", "src2_form", "src1_quote", "src2_quote", "src1_use", "src2_use"];
const JM_FIELDS = ["scene", "answer", "reason"];
const JM_CHECKS = ["scene", "answer", "reason"];
const allOn = (ids) => Object.fromEntries(ids.map((id) => [id, true]));
const allOff = (ids) => Object.fromEntries(ids.map((id) => [id, false]));

/* ---------- 本体 ---------- */

async function main() {
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
  const games = K2.games;
  assert.deepEqual(games.map((g) => g.id), ["judge", "cite", "where"]);
  const allAttempts = {}; // gid → [{ answers, score }]

  async function checkFields(label) {
    const fields = await page.call(pageFormFields);
    for (const f of fields) {
      assert.ok(!FORBIDDEN.test(f.attrs) && !FORBIDDEN.test(f.labels), `${label}：入力欄に個人情報を求める語があります ${JSON.stringify(f)}`);
    }
    return fields.length;
  }

  async function playGame(g, mode, shoot) {
    const overflow = [];
    const answers = {};
    let n = 0;
    await page.call(pageStartGame, g.id);
    for (;;) {
      const wrong = mode === "mixed" && n % 2 === 0; // 1 問おきに間違える
      if (shoot && n === 0) await page.shotSel(`[data-game="${g.id}"]`, `375_game_${g.id}_question`);
      if (await page.call(pageOverflow)) overflow.push(n + ":question");
      const r = await page.call(pageAnswer, g, wrong);
      const item = g.items.find((x) => x.id === r.id);
      assert.ok(r.feedback && r.marks > 0, `${g.id} ${r.id}：判定の表示（○×）がありません`);
      if (g.type === "choice") {
        // fixed_order：毎問 OK／NG／条件つきでOK の順
        assert.deepEqual(r.optIds, ["ok", "ng", "cond"], `${g.id} ${r.id}：選択肢の順`);
        assert.deepEqual(r.optTexts, ["OK", "NG", "条件つきでOK"], `${g.id} ${r.id}：選択肢の文字`);
        assert.ok(r.feedbackText.includes(item.explain), `${g.id} ${r.id}：解説が出ていません`);
      }
      if (g.type === "order") {
        assert.equal(r.initialIsAnswer, false, `${g.id} ${r.id}：最初の並びが正解と同じです`);
        assert.equal(r.judgeEnabled, true);
      }
      if (g.type === "find") {
        assert.equal(r.noteTappable, false, `${g.id} ${r.id}：読んだ資料（note）がタップできます`);
        assert.equal(r.missingBoxes, item.missing_options.length, `${g.id} ${r.id}：足りないものの欄の数`);
      }
      if (shoot && n === 0) await page.shotSel(`[data-game="${g.id}"]`, `375_game_${g.id}_judged`);
      if (await page.call(pageOverflow)) overflow.push(n + ":judged");
      answers[r.id] = r.answer;
      n++;
      const res = await page.call(pageNext, g.id);
      if (r.last) {
        assert.ok(res, `${g.id}：結果が出ません`);
        if (shoot) await page.shotSel(`[data-game="${g.id}"]`, `375_game_${g.id}_result`);
        if (await page.call(pageOverflow)) overflow.push("result");
        return { ...res, answers, count: n, overflow };
      }
    }
  }

  // 1 回目：幅 375px、正解だけ（作る・提出も）
  // 2 回目：幅 1280px、わざと間違い混じり（もう一度提出し、挑戦が 2 回ずつ入る）
  const passes = [
    { width: 375, mode: "correct" },
    { width: 1280, mode: "mixed" }
  ];
  for (let pi = 0; pi < passes.length; pi++) {
    const { width, mode } = passes[pi];
    const shoot = pi === 0;
    await page.width(width);
    await page.goto("/k2/index.html");
    await waitFor(() => page.eval(`document.querySelectorAll("[data-game]").length === 3 && document.querySelectorAll("[data-compose]").length === 2 && !!document.querySelector('[data-action="export"]')`), 10000, "課題2の組み立て");
    await page.noHScroll(`k2 ${width}px 読み込み直後`);
    const nFields = await checkFields(`k2 ${width}px`);
    ok(`k2（${width}px）：組み立て・入力欄 ${nFields} 個に個人情報を求める語なし・横スクロールなし`);

    if (pi === 0) {
      // リードと ① 学ぶ
      const head = await page.eval(`({ lead: document.querySelector(".site-head h1 + p")?.textContent || "", pending: document.querySelectorAll(".pending").length })`);
      assert.equal(head.lead, "レポートや発表では、他人の文章・図・データを使う場面がたくさんあります。決まったルールを守れば使えますが、守らないと盗用（剽窃）になり、研究でも仕事でも信用を失います。");
      assert.equal(head.pending, 0, "準備中の表示が残っています");
      const learn = await page.eval(`Array.from(document.querySelectorAll("#learn .learn-card")).map(c => ({
        h: c.querySelector("h3").textContent,
        text: c.textContent,
        order: Array.from(c.children).map(e => e.tagName + (e.className ? "." + e.className : "")),
        links: Array.from(c.querySelectorAll("a")).map(a => a.getAttribute("href"))
      }))`);
      assert.equal(learn.length, K2.learn.length, "学ぶのカードの数");
      let num = 0;
      K2.learn.forEach((sec, i) => {
        // num: false のカードは番号なし、数え方からも外す
        assert.equal(learn[i].h, sec.num === false ? sec.h : `${++num}. ${sec.h}`);
        for (const s of [...(sec.p || []), ...(sec.ul || []), ...(sec.after || []), ...(sec.ex || [])]) assert.ok(learn[i].text.includes(s), `学ぶ「${sec.h}」に「${s}」が出ていません`);
        assert.deepEqual(learn[i].links, (sec.links || []).map((l) => new URL(l.href).href), `学ぶ「${sec.h}」のリンク`);
      });
      const hs = learn.map((c) => c.h);
      assert.deepEqual(hs.slice(-3), ["10. 参考文献の一覧の書き方（このサイトの形式）", "11. 資料の探し方", "根拠にした資料"]);
      const rule = learn[hs.indexOf("2. 引用のルール")];
      assert.deepEqual(rule.order, ["H3", "P", "UL.learn-ul", "P.learn-after"], "引用のルールの表示順");
      assert.ok(rule.text.endsWith("さらに、引用した部分を勝手に書き換えません（著作権法20条）。"));
      assert.deepEqual(learn[hs.indexOf("11. 資料の探し方")].links, ["https://cir.nii.ac.jp/", "https://www.jstage.jst.go.jp/", "https://ndlsearch.ndl.go.jp/"]);
      await page.shotSel("#learn-sec", "375_learn");
      for (const [i, name] of [[hs.indexOf("2. 引用のルール"), "rule"], [hs.indexOf("11. 資料の探し方"), "search"], [hs.indexOf("根拠にした資料"), "sources"]]) {
        await page.shotSel(`#learn [data-learn="${i + 1}"]`, "375_learn_" + name);
      }
      ok(`リードと ① 学ぶ（カード ${learn.length} 枚、本文・箇条・例・リンク ${learn[learn.length - 1].links.length} 件）を表示`);

      // ③ 作る：欄の定義
      const info = await page.call(pageComposeInfo);
      assert.deepEqual(info.map((f) => f.id), ["cite", "judgemake"]);
      assert.deepEqual(info[0].fields.map((f) => f.id), CITE_FIELDS);
      assert.deepEqual(info[1].fields.map((f) => f.id), JM_FIELDS);
      assert.deepEqual(info[0].checks, CITE_CHECKS);
      assert.deepEqual(info[1].checks, JM_CHECKS);
      const fd = Object.fromEntries(info[0].fields.map((f) => [f.id, f]));
      assert.deepEqual([fd.theme.tag, fd.theme.label], ["FIELDSET", "課題3のテーマ"]);
      assert.deepEqual(fd.theme.options, ["T1", "T2", "T3", "T4", "T5"]);
      assert.deepEqual(info[0].fields.slice(1).map((f) => f.label.split("：")[0] + "：" + f.label.split("：")[1].slice(0, 4)),
        [1, 2].flatMap((n) => [`資料${n}：種類`, `資料${n}：出典（こ`, `資料${n}：引用する`, `資料${n}：その引用`]));
      assert.equal(fd.src1_ref.placeholder, "例：山本花子（2022）『眠りの科学入門』みどり書房.");
      assert.equal(fd.src2_ref.placeholder, "例：佐々木一郎（2021）「通学時間と学習時間の関係」『教育データ研究』12巻3号, pp.20-31.");
      for (const n of [1, 2]) {
        assert.deepEqual(fd[`src${n}_kind`].options, ["", "book", "paper", "web", "news"]);
        assert.deepEqual([fd[`src${n}_ref`].tag, fd[`src${n}_ref`].rows, fd[`src${n}_ref`].max], ["TEXTAREA", "2", "300"]);
        assert.deepEqual([fd[`src${n}_quote`].rows, fd[`src${n}_quote`].max], ["3", "300"]);
        assert.deepEqual([fd[`src${n}_use`].rows, fd[`src${n}_use`].max], ["4", "500"]);
      }
      const jd = Object.fromEntries(info[1].fields.map((f) => [f.id, f]));
      assert.deepEqual([jd.scene.rows, jd.scene.max, jd.reason.rows, jd.reason.max], ["4", "300", "4", "400"]);
      assert.deepEqual(jd.answer.options, ["", "ok", "ng", "cond"]);
      assert.equal(info[0].intro, "課題3で書くレポートのテーマを選び、そのテーマについて実際の資料を2つ探して、引用の練習をします。ここで書いた出典は、課題3のレポートに読み込めます。資料の探し方は「① 学ぶ」の「資料の探し方」にあります。");
      // テーマは必須：未選択なら進み具合に欄名が出る
      const st0 = await page.eval(`(() => { document.querySelector('[data-action="refresh-status"]').click();
        return Array.from(document.querySelectorAll("#submit .status-table tr")).map(tr => tr.querySelector("td").textContent); })()`);
      assert.equal(st0[3], "× まだ（必須の欄：課題3のテーマ）");
      // 何も入れていないときは、点検はすべて −
      const empty = await page.call(pageFill, {});
      assert.deepEqual(empty, { cite: allOff(CITE_CHECKS), judgemake: allOff(JM_CHECKS) });
      ok("作る：欄・選択肢・字数の上限・点検の項目が原稿どおり、未入力では点検がすべて −");
    }

    for (const g of games) {
      const r = await playGame(g, mode, shoot);
      assert.deepEqual(r.overflow, [], `${g.id}（${width}px）：横スクロール ${r.overflow}`);
      assert.equal(r.count, g.items.length);
      const re = S.scoreGame(g, r.answers);
      assert.equal(r.score, re.score, `${g.id}：画面の点数 ${r.score} と再計算 ${re.score} が違います`);
      assert.equal(r.max, re.max);
      assert.equal(r.rank, S.rank(re.score, re.max));
      if (mode === "correct") assert.equal(r.score, r.max, `${g.id}：正解どおりなのに満点ではありません`);
      else assert.ok(r.score < r.max, `${g.id}：間違い混じりなのに満点です`);
      (allAttempts[g.id] ||= []).push({ answers: r.answers, score: r.score });
      ok(`k2（${width}px）${g.id}：${mode === "correct" ? "正解どおり" : "間違い混じり"} ${r.score} / ${r.max}（${r.rank}）画面＝再計算${g.type === "choice" ? "、選択肢は毎問 OK／NG／条件つきでOK の順" : ""}`);
    }

    if (pi === 0) {
      // 作る1・2：全部 ○ になる
      let c = await page.call(pageFill, FILL);
      assert.deepEqual(c, { cite: allOn(CITE_CHECKS), judgemake: allOn(JM_CHECKS) }, "全部入れたのに ○ にならない点検があります");
      ok("作る1・2：原稿の条件を満たす入力で、点検がすべて ○");

      // 種類を変えると形式の点検が変わる（資料ごと・種類ごと）
      const formCases = [
        ["book", BOOK, true], ["paper", BOOK, false], ["web", BOOK, false], ["news", BOOK, false],
        ["paper", PAPER, true], ["book", PAPER, true],
        ["web", WEB, true], ["web", WEB.replace("（閲覧日：2026年11月10日）", ""), false], ["news", WEB, false],
        ["news", NEWS, true], ["news", NEWS.replace("2026年5月10日", "2026/5/10"), false], ["book", NEWS, true], ["paper", NEWS, true],
        ["", BOOK, false]
      ];
      for (const n of [1, 2]) {
        for (const [kind, ref, want] of formCases) {
          c = await page.call(pageFill, { [`cite.src${n}_kind`]: kind, [`cite.src${n}_ref`]: ref });
          assert.equal(c.cite[`src${n}_form`], want, `資料${n} 種類「${kind}」・出典「${ref}」：形式の点検が ${want ? "○" : "−"} になりません`);
          assert.equal(c.cite[`src${3 - n}_form`], true, `資料${n} を変えたら資料${3 - n} の形式の点検が変わりました`);
        }
        await page.call(pageFill, { [`cite.src${n}_kind`]: FILL[`cite.src${n}_kind`], [`cite.src${n}_ref`]: FILL[`cite.src${n}_ref`] });
      }
      // ほかの点検が − になる例
      c = await page.call(pageFill, {
        "cite.src1_ref": "山本花子『眠りの科学入門』みどり書房.", "cite.src1_kind": "book",
        "cite.src2_quote": "睡眠は大切である。", "cite.src2_use": "短い。",
        "judgemake.scene": "短い場面。", "judgemake.answer": "", "judgemake.reason": "短い理由。"
      });
      assert.deepEqual(c.cite, { ...allOn(CITE_CHECKS), src1_year: false, src2_quote: false, src2_use: false });
      assert.deepEqual(c.judgemake, allOff(JM_CHECKS));
      c = await page.call(pageFill, { "cite.src1_ref": "山本花子（２０２２）『眠りの科学入門』みどり書房.", "cite.theme": "" });
      assert.equal(c.cite.src1_year, true, "全角の年が数えられていません");
      assert.equal(c.cite.theme, false);
      // 元の入力に戻す
      c = await page.call(pageFill, FILL);
      assert.deepEqual(c, { cite: allOn(CITE_CHECKS), judgemake: allOn(JM_CHECKS) });
      await page.noHScroll(`k2 ${width}px 作る入力後`);
      await page.shotSel("#compose-sec", "375_compose");
      ok("作る1：種類（本・論文・Webページ・新聞記事・未選択）を変えると形式の点検が資料ごとに変わる。年・「」・字数・テーマ・作る2 の点検も − になる");
    } else {
      // 再読み込み後も入力が残っている
      const info = await page.call(pageComposeInfo);
      const vals = Object.fromEntries(info.flatMap((f) => f.fields.map((x) => [f.id + "." + x.id, x.value])));
      assert.deepEqual(vals, FILL, "再読み込みで作るの入力が消えました");
      ok("作る：再読み込みしても入力が残る");
    }

    // ④ 提出
    const ex = await page.call(pageExport);
    assert.ok(ex.text, "提出ファイルの中身がありません");
    assert.deepEqual(ex.warnings, [], "警告が出ました：" + ex.warnings.join(" / "));
    assert.deepEqual(ex.status.map((s) => s[1].slice(0, 1)), ["○", "○", "○", "○", "○"], "進み具合：" + JSON.stringify(ex.status));
    assert.deepEqual(ex.status.map((s) => s[0]), ["ゲーム「引用ジャッジ」", "ゲーム「出典パズル」", "ゲーム「どこに出典が要る？」", "作る「作る1 引用してみる」", "作る「作る2 ジャッジ問題を作る」"]);
    const sub = JSON.parse(ex.text);
    assert.equal(ex.text, JSON.stringify(sub, null, 2) + "\n", "2 スペースの整形ではありません");
    const v = S.validateSubmission(sub);
    assert.ok(v.ok, "validateSubmission 不合格：" + v.errors.join(" / "));
    assert.equal(sub.kadai, 2);
    assert.equal(sub.data_version, K2.version);
    assert.deepEqual(Object.keys(sub.games), ["judge", "cite", "where"]);
    for (const g of games) {
      const atts = sub.games[g.id].attempts;
      assert.equal(atts.length, pi + 1, `${g.id} の挑戦の数`);
      atts.forEach((a, i) => {
        const re = S.scoreGame(g, a.answers);
        assert.equal(a.score, re.score, `${g.id} 挑戦${i + 1}：ファイルの点数と再計算が違います`);
        assert.equal(a.max, re.max);
        assert.equal(a.score, allAttempts[g.id][i].score, `${g.id} 挑戦${i + 1}：画面の点数と違います`);
        const norm = (ans) => g.type !== "find" ? ans : Object.fromEntries(Object.entries(ans).map(([id, x]) => [id, { picked: [...x.picked].sort(), missing: [...x.missing].sort() }]));
        assert.deepEqual(norm(a.answers), norm(allAttempts[g.id][i].answers), `${g.id} 挑戦${i + 1}：解答の記録が操作と違います`);
      });
    }
    assert.deepEqual(Object.keys(sub.creative), ["cite", "judgemake"]);
    assert.deepEqual(Object.keys(sub.creative.cite), CITE_FIELDS);
    assert.deepEqual(Object.keys(sub.creative.judgemake), JM_FIELDS);
    for (const key of Object.keys(FILL)) {
      const [fid, f] = key.split(".");
      assert.equal(sub.creative[fid][f], FILL[key], `creative.${key}`);
    }
    // 課題3から読めるように、保存値が MN.compose.read で取れる
    const read = await page.eval(`MN.compose.read(2, "cite")`);
    assert.deepEqual(read, Object.fromEntries(CITE_FIELDS.map((f) => [f, FILL["cite." + f]])));
    assert.equal(await page.eval(`MN.compose.read(2, "nothing")`), null);
    await page.noHScroll(`k2 ${width}px 提出ファイル作成後`);
    if (shoot) await page.shotSel("#submit-sec", "375_submit");
    ok(`提出（${width}px）：validateSubmission 合格、kadai 2、全挑戦の点数＝scoring.js の再計算、creative に cite・judgemake、MN.compose.read(2, "cite") で保存値が読める、横スクロールなし`);
  }
  if (process.env.E2E_SHOT_DIR) {
    await page.width(375);
    await page.goto("/k2/index.html");
    await page.shot("375_k2_full");
  }

  // localStorage のキーはすべて mn2026. で始まる
  const keys = await page.eval(`Object.keys(localStorage)`);
  assert.ok(keys.length > 0 && keys.every((k) => k.startsWith("mn2026.")), "mn2026. 以外のキー：" + keys);
  ok(`localStorage のキー ${keys.length} 個はすべて mn2026. で始まる`);

  // トップの進み具合
  await page.goto("/index.html");
  const st = await page.eval(`document.querySelector('[data-status="2"]').textContent`);
  assert.equal(st, "提出ファイル作成済み");
  ok("トップ：課題2は「提出ファイル作成済み」");

  // 外部への通信がない（学ぶのリンクは押さない）
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
