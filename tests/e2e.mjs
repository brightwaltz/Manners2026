// 通しの検査：node tests/e2e.mjs
// 依存なし。python3 -m http.server と headless Chrome を立て、Chrome DevTools Protocol で操作する。
// demo/index.html で各ゲームを最後まで解き（正解だけ・わざと間違い混じり）、作る・提出まで通す。
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
const DEMO = JSON.parse(readFileSync(join(ROOT, "data/demo.json"), "utf8"));
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

// 1 つのゲームを 1 回最後まで解く。mode は "correct" か "mixed"
function pagePlay(gameDef, mode) {
  const S = window.MNScoring;
  const box = document.querySelector(`[data-game="${gameDef.id}"]`);
  const overflow = [];
  const checkOverflow = (where) => {
    if (document.documentElement.scrollWidth > innerWidth) overflow.push(where + ":" + document.documentElement.scrollWidth);
  };
  box.querySelector('[data-action="start"],[data-action="retry"]').click();
  const answers = {};
  let n = 0;
  for (;;) {
    const card = box.querySelector("[data-item-id]");
    if (!card) throw new Error("問題が表示されていません");
    const id = card.getAttribute("data-item-id");
    const item = gameDef.items.find((x) => x.id === id);
    const wrong = mode === "mixed" && n % 2 === 0; // 間違い混じりでは 1 問おきに間違える
    checkOverflow(id);
    if (gameDef.type === "find") {
      const map = S.findChunkMap(item);
      const positions = Object.keys(map).filter((p) => card.querySelector(`[data-chunk="${p}"]`));
      const picked = [];
      const errs = item.errors.map((e) => e.id);
      const useErrs = wrong ? errs.slice(0, 1) : errs;
      for (const e of useErrs) {
        const ps = positions.filter((p) => map[p] === e);
        // 同じ err のかたまりが 2 つ以上あれば両方タップする（重複の扱いを確かめる）
        for (const p of ps.slice(0, wrong ? 1 : 2)) picked.push(p);
      }
      if (wrong) {
        const extra = positions.find((p) => !map[p]);
        if (extra) picked.push(extra);
        // 一度タップして取り消す（取り消しが記録に残らないことを確かめる）
        const extra2 = positions.filter((p) => !map[p])[1];
        if (extra2) { card.querySelector(`[data-chunk="${extra2}"]`).click(); card.querySelector(`[data-chunk="${extra2}"]`).click(); }
      }
      picked.forEach((p) => card.querySelector(`[data-chunk="${p}"]`).click());
      let missing = item.missing_answer.slice();
      if (wrong) {
        const bad = item.missing_options.map((o) => o.id).find((m) => !item.missing_answer.includes(m));
        missing = missing.slice(1);
        if (bad) missing.push(bad);
      }
      missing.forEach((m) => card.querySelector(`[data-missing="${m}"]`).click());
      answers[id] = {
        picked: Object.keys(map).filter((p) => picked.includes(p)).sort(),
        missing: item.missing_options.map((o) => o.id).filter((m) => missing.includes(m))
      };
      card.querySelector('[data-action="judge"]').click();
      if (!card.querySelector('[data-role="feedback"]')) throw new Error("find：判定の表示がありません");
      if (card.querySelectorAll(".mark-ok, .mark-ng").length === 0) throw new Error("find：○× がありません");
    } else if (gameDef.type === "choice") {
      const choose = wrong ? item.options.find((o) => o.id !== item.answer).id : item.answer;
      card.querySelector(`[data-opt="${choose}"]`).click();
      answers[id] = choose;
      const fb = card.querySelector('[data-role="feedback"]');
      if (!fb || !fb.textContent.includes(choose === item.answer ? "○" : "×")) throw new Error("choice：○× の表示がありません");
    } else if (gameDef.type === "order") {
      const judge = card.querySelector('[data-action="judge"]');
      const initial = Array.from(card.querySelectorAll('[data-zone="pool"] [data-piece]')).map((b) => b.getAttribute("data-piece"));
      if (initial.join() === item.answer.join()) throw new Error("order：最初の並びが正解と同じです");
      const seq = wrong ? item.answer.slice().reverse() : item.answer.slice();
      // 1 つ置いて戻す操作も確かめる
      card.querySelector(`[data-zone="pool"] [data-piece="${seq[0]}"]`).click();
      card.querySelector(`[data-zone="answer"] [data-piece="${seq[0]}"]`).click();
      if (!judge.disabled) throw new Error("order：全部置く前に判定できます");
      seq.forEach((p) => card.querySelector(`[data-zone="pool"] [data-piece="${p}"]`).click());
      if (judge.disabled) throw new Error("order：全部置いても判定できません");
      judge.click();
      answers[id] = seq;
    }
    checkOverflow(id + "-judged");
    n++;
    const next = card.querySelector('[data-action="next"],[data-action="finish"]');
    const last = next.getAttribute("data-action") === "finish";
    next.click();
    if (last) break;
  }
  const res = box.querySelector('[data-role="result"]');
  checkOverflow("result");
  return {
    answers,
    count: n,
    score: Number(res.querySelector("[data-result-score]").textContent),
    max: Number(res.querySelector("[data-result-max]").textContent),
    rank: res.querySelector("[data-result-rank]").textContent,
    overflow
  };
}

function pageFillForms(subjectLen) {
  const set = (sel, v) => {
    const e = document.querySelector(sel);
    e.value = v;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return e;
  };
  const subj = set('[data-compose="mail"] [data-field="subject"]', "第3回レポートの提出形式についての質問".padEnd(subjectLen, "あ"));
  const body = document.querySelector('[data-compose="mail"] [data-field="body"]');
  set('[data-compose="mail"] [data-field="body"]', body.value + "\nよろしくお願いいたします。\n学籍番号 24A1234");
  set('[data-compose="mail"] [data-field="kind"]', "q");
  set('[data-compose="memo"] [data-field="text"]', "長".repeat(6100));
  const checks = Array.from(document.querySelectorAll('[data-compose="mail"] [data-check]')).map((li) => [li.getAttribute("data-check"), li.classList.contains("on")]);
  return {
    subject: subj.value,
    memoLen: document.querySelector('[data-compose="memo"] [data-field="text"]').value.length,
    count: document.querySelector('[data-compose="mail"] [data-count="subject"]').textContent,
    checks
  };
}

function pageExport(aiUsed) {
  const box = document.getElementById("submit");
  const out = {};
  // 同意を選ぶ前は作れない
  const radios = box.querySelectorAll('input[type="radio"]');
  const anyChecked = Array.from(radios).some((r) => r.checked);
  if (!anyChecked) {
    box.querySelector('[data-action="export"]').click();
    out.blocked = !!box.querySelector('[data-role="submit-blocked"]');
  }
  box.querySelector('[data-choice="consent:yes"]').click();
  box.querySelector(`[data-choice="ai:${aiUsed ? "yes" : "no"}"]`).click();
  if (aiUsed) {
    const d = box.querySelector('[data-field="ai-detail"]');
    d.value = "作るの本文で、敬語の言い回しを直させた";
    d.dispatchEvent(new Event("input", { bubbles: true }));
  }
  box.querySelector('[data-action="export"]').click();
  // 学籍番号らしい数字があるので、まず警告だけが出て、まだ作られない
  out.warnedFirst = !!box.querySelector('[data-role="submit-warning"]') && box.querySelector('[data-role="export-text"]').value === "";
  const anyway = box.querySelector('[data-action="export-anyway"]');
  if (anyway) anyway.click();
  out.text = box.querySelector('[data-role="export-text"]').value;
  out.warnings = Array.from(box.querySelectorAll('[data-role="submit-warning"]')).map((e) => e.textContent);
  out.status = Array.from(box.querySelectorAll(".status-table td")).map((e) => e.textContent);
  return out;
}

/* ---------- 本体 ---------- */

async function main() {
  const base = await startServer();
  ok("http.server を起動：" + base);
  let wsUrl;
  try {
    wsUrl = await startChrome(false);
  } catch (e) {
    console.log("Chrome の起動に失敗したので arch -arm64 で試します：" + e.message);
    // http.server は残し、Chrome とプロファイルだけ片付ける
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
  const games = DEMO.games;
  const allAttempts = {}; // gid → [{ answers, score }]

  async function checkFields(label) {
    const fields = await page.call(pageFormFields);
    for (const f of fields) {
      assert.ok(!FORBIDDEN.test(f.attrs) && !FORBIDDEN.test(f.labels), `${label}：入力欄に個人情報を求める語があります ${JSON.stringify(f)}`);
    }
    return fields.length;
  }

  async function verifySubmission(text, expectAttempts) {
    const sub = JSON.parse(text);
    assert.equal(text, JSON.stringify(sub, null, 2) + "\n", "2 スペースの整形ではありません");
    const v = S.validateSubmission(sub);
    assert.ok(v.ok, "validateSubmission 不合格：" + v.errors.join(" / "));
    assert.equal(sub.kadai, 0);
    assert.equal(sub.data_version, DEMO.version);
    assert.match(sub.first_visit_at, /[+-]\d{2}:\d{2}$/);
    assert.match(sub.exported_at, /[+-]\d{2}:\d{2}$/);
    // 識別子になりそうなものが入っていない
    const ua = await page.eval("navigator.userAgent");
    assert.ok(!text.includes(ua) && !/Mozilla|Chrome\/|userAgent|platform/i.test(text), "端末情報が入っています");
    for (const g of games) {
      const atts = sub.games[g.id].attempts;
      assert.equal(atts.length, expectAttempts, `${g.id} の挑戦の数`);
      atts.forEach((a, i) => {
        const re = S.scoreGame(g, a.answers);
        assert.equal(a.score, re.score, `${g.id} 挑戦${i + 1}：ファイルの点数と再計算が違います`);
        assert.equal(a.max, re.max, `${g.id} 挑戦${i + 1}：満点が違います`);
        assert.equal(a.score, allAttempts[g.id][i].score, `${g.id} 挑戦${i + 1}：画面の点数と再計算が違います`);
        // find の picked はタップの順で記録されるので、集合として比べる
        const norm = (ans) => g.type !== "find" ? ans : Object.fromEntries(Object.entries(ans).map(([id, v]) => [id, { picked: [...v.picked].sort(), missing: [...v.missing].sort() }]));
        assert.deepEqual(norm(a.answers), norm(allAttempts[g.id][i].answers), `${g.id} 挑戦${i + 1}：解答の記録が操作と違います`);
      });
    }
    return sub;
  }

  // 1 回目：幅 375px、正解だけ
  // 2 回目：幅 1280px、わざと間違い混じり
  const passes = [
    { width: 375, mode: "correct", aiUsed: false },
    { width: 1280, mode: "mixed", aiUsed: true }
  ];
  for (let pi = 0; pi < passes.length; pi++) {
    const { width, mode, aiUsed } = passes[pi];
    await page.width(width);
    await page.goto("/demo/index.html");
    await waitFor(() => page.eval(`document.querySelectorAll("[data-game]").length === ${games.length} && !!document.querySelector('[data-action="export"]')`), 10000, "デモの組み立て");
    await page.noHScroll(`demo ${width}px 読み込み直後`);
    const nFields = await checkFields(`demo ${width}px`);
    ok(`demo（${width}px）：組み立て・入力欄 ${nFields} 個に個人情報を求める語なし・横スクロールなし`);

    for (const g of games) {
      const r = await page.call(pagePlay, g, mode);
      assert.deepEqual(r.overflow, [], `${g.id}（${width}px）：横スクロール ${r.overflow}`);
      assert.equal(r.count, g.items.length);
      const re = S.scoreGame(g, r.answers);
      assert.equal(r.score, re.score, `${g.id}：画面の点数 ${r.score} と再計算 ${re.score} が違います`);
      assert.equal(r.max, re.max);
      assert.equal(r.rank, S.rank(re.score, re.max));
      if (mode === "correct") assert.equal(r.score, r.max, `${g.id}：正解だけなのに満点ではありません`);
      else assert.ok(r.score < r.max, `${g.id}：間違い混じりなのに満点です`);
      (allAttempts[g.id] ||= []).push({ answers: r.answers, score: r.score });
      ok(`demo（${width}px）${g.id}：${mode === "correct" ? "正解だけ" : "間違い混じり"} ${r.score} / ${r.max}（${r.rank}）画面＝再計算`);
    }

    if (pi === 0) {
      const f = await page.call(pageFillForms, 100);
      assert.equal(f.subject.length, 80, "件名が 80 字で止まりません");
      assert.equal(f.memoLen, 6000, "長い文章が 6000 字で止まりません");
      assert.equal(f.count, "80 / 80 字");
      assert.deepEqual(f.checks, [["has_subject", true], ["has_sign", true], ["polite_end", true]]);
      ok("作る：上限で止まる（80 字・6000 字）、字数表示、ライブ点検 ○");
    }

    const ex = await page.call(pageExport, aiUsed);
    if (pi === 0) {
      assert.equal(ex.blocked, true, "同意を選ばなくても作れてしまいます");
      ok("提出：同意と生成AIを選ぶ前は作れない");
    }
    assert.equal(ex.warnedFirst, true, "学籍番号らしい数字があるのに、警告の前に提出ファイルが作られました");
    assert.ok(ex.text, "提出ファイルの中身がありません");
    assert.ok(ex.warnings.some((w) => w.includes("24A1234")), "学籍番号らしい数字の警告が出ません");
    assert.ok(!ex.warnings.some((w) => w.includes("学籍番号らしい数字「99Z9999」")), "架空の人物の学籍番号に警告が出ています");
    const sub = await verifySubmission(ex.text, pi + 1);
    assert.equal(sub.consent_showcase, true);
    assert.equal(sub.ai_use.used, aiUsed);
    assert.equal(sub.creative.mail.subject.length, 80);
    assert.equal(sub.creative.memo.text.length, 6000);
    assert.ok(sub.creative.mail.body.includes("玉川 みらい"));
    await page.noHScroll(`demo ${width}px 提出ファイル作成後`);
    ok(`提出（${width}px）：validateSubmission 合格、全挑戦の点数＝scoring.js の再計算、学籍番号らしい数字は作る前に警告→「このまま作る」で作成、横スクロールなし`);

    // 30 回の上限（初回は残る）を、保存の関数で確かめる
    if (pi === 1) {
      const cap = await page.eval(`(() => {
        for (let i = 0; i < 40; i++) MN.attempts.add(99, "cap", { t0: "x", t1: "x", answers: {}, score: i, max: 40 });
        const l = MN.attempts.list(99, "cap");
        return { n: l.length, first: l[0].score, last: l[l.length - 1].score };
      })()`);
      assert.deepEqual(cap, { n: 30, first: 0, last: 39 });
      await page.eval(`localStorage.removeItem("mn2026.k99.game.cap")`);
      ok("試行の記録：最大 30 回、初回は残る");
    }
  }

  // localStorage のキーはすべて mn2026. で始まる
  const keys = await page.eval(`Object.keys(localStorage)`);
  assert.ok(keys.length > 0 && keys.every((k) => k.startsWith("mn2026.")), "mn2026. 以外のキー：" + keys);
  ok(`localStorage のキー ${keys.length} 個はすべて mn2026. で始まる`);

  // トップと k1〜k3
  for (const width of [375, 1280]) {
    await page.width(width);
    await page.goto("/index.html");
    const st = await page.eval(`Array.from(document.querySelectorAll("[data-status]")).map(e => e.textContent)`);
    assert.deepEqual(st, ["未着手", "未着手", "未着手"]);
    await page.noHScroll(`トップ ${width}px`);
    for (const k of [1, 2, 3]) {
      await page.goto(`/k${k}/index.html`);
      await sleep(300);
      const s = await page.eval(`({
        h1: document.querySelector("h1").textContent,
        pending: ["learn","games","compose","submit"].every(id => document.getElementById(id) && document.getElementById(id).querySelector(".pending")),
        nav: document.querySelectorAll(".steps a").length
      })`);
      assert.ok(s.pending, `k${k}：準備中の表示がありません`);
      assert.equal(s.nav, 4);
      await page.noHScroll(`k${k} ${width}px`);
      await checkFields(`k${k}`);
    }
  }
  await page.eval(`localStorage.setItem("mn2026.k2.game.find", "[]")`);
  await page.goto("/index.html");
  const st2 = await page.eval(`document.querySelector('[data-status="2"]').textContent`);
  assert.equal(st2, "進行中");
  ok("トップと k1〜k3（375px・1280px）：準備中の表示、ナビ 4 つ、横スクロールなし、進み具合の表示");

  // 外部への通信がない
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
