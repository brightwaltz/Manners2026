// 課題3の通しの検査：node tests/e2e_k3.mjs
// 依存なし。python3 -m http.server と headless Chrome を立て、Chrome DevTools Protocol で操作する。
// k3/index.html で 3 つのゲームを解き（正解だけ・わざと間違い混じり）、最終レポートのライブ点検、
// 課題2の出典の読み込み、提出ファイルまで通す。起動と CDP の部分は tests/e2e.mjs と同じ。
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const S = require(join(ROOT, "assets/js/scoring.js"));
const R = require(join(ROOT, "k3/report.js"));
const K3 = JSON.parse(readFileSync(join(ROOT, "data/k3.json"), "utf8"));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FORBIDDEN = /名前|氏名|学籍番号|メールアドレス|name|e-?mail/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(msg) { results.push(["○", msg]); console.log("○ " + msg); }
// E2E_EXPORT_DIR を指定したときだけ、提出ファイルの中身を <E2E_EXPORT_DIR>/<回>/マナー課題N_提出.txt に保存する（通し検査用）
function saveExport(label, n, text) {
  if (!process.env.E2E_EXPORT_DIR) return;
  const dir = join(process.env.E2E_EXPORT_DIR, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `マナー課題${n}_提出.txt`), text);
}

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
  // スクロールバーは隠さない（書くのライブ点検で、スクロールバーが常に見えることを確かめるため）
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    "--disable-background-networking", "--disable-component-update", "about:blank"];
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
  // E2E_SHOT_DIR を指定すると、各段の画面を PNG で保存する（目視用）
  let shotN = 0;
  // selector を渡すと、その要素の上端までスクロールして画面 1 枚分だけ撮る（無ければページ全体）
  page.shot = async (label, selector) => {
    if (!process.env.E2E_SHOT_DIR) return;
    label = String(++shotN).padStart(2, "0") + "_" + label;
    if (selector) await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e && e.scrollIntoView({ block: "start" }); })()`);
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: !selector }, sessionId);
    writeFileSync(join(process.env.E2E_SHOT_DIR, label.replace(/[^\w.-]+/g, "_") + ".png"), Buffer.from(r.data, "base64"));
  };
  page.noHScroll = async (label) => {
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


// ゲームを 1 問だけ進めて、問題画面と判定後を撮るための操作（記録には残らない。ページを読み直して捨てる）
function pageOneItem(gameDef, step) {
  const box = document.querySelector(`[data-game="${gameDef.id}"]`);
  if (step === "start") {
    box.querySelector('[data-action="start"],[data-action="retry"]').click();
    return box.querySelector("[data-item-id]").getAttribute("data-item-id");
  }
  const card = box.querySelector("[data-item-id]");
  const item = gameDef.items.find((x) => x.id === card.getAttribute("data-item-id"));
  if (gameDef.type === "order") {
    item.answer.slice().reverse().forEach((p) => card.querySelector(`[data-zone="pool"] [data-piece="${p}"]`).click());
    card.querySelector('[data-action="judge"]').click();
  } else if (gameDef.type === "choice") {
    card.querySelector(`[data-opt="${item.options.find((o) => o.id !== item.answer).id}"]`).click();
  } else {
    const map = window.MNScoring.findChunkMap(item);
    const ps = Object.keys(map);
    card.querySelector(`[data-chunk="${ps.find((p) => map[p])}"]`).click();
    const extra = ps.find((p) => !map[p]);
    if (extra) card.querySelector(`[data-chunk="${extra}"]`).click();
    card.querySelector('[data-action="judge"]').click();
  }
  return true;
}

// 最終レポートの欄に値を入れる（compose.js の input / change を発火させる）
function pageFillReport(vals) {
  const form = document.querySelector('[data-compose="report"]');
  for (const [k, v] of Object.entries(vals)) {
    const e = form.querySelector(`[data-field="${k}"]`);
    e.value = v;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const panel = document.querySelector('[data-role="report-live"]');
  const live = {};
  panel.querySelectorAll("[data-live]").forEach((e) => {
    live[e.getAttribute("data-live")] = { ok: e.getAttribute("data-ok"), text: e.textContent };
  });
  const values = {};
  form.querySelectorAll("[data-field]").forEach((e) => { values[e.getAttribute("data-field")] = e.value; });
  return {
    topics: Array.from(panel.querySelectorAll('[data-role="topic-list"] li')).map((li) => li.textContent),
    live,
    values,
    saved: JSON.parse(localStorage.getItem("mn2026.k3.creative.report") || "null")
  };
}

function pageImport() {
  const btn = document.querySelector('[data-action="import-k2-refs"]');
  btn.click();
  return {
    refs: document.querySelector('[data-compose="report"] [data-field="refs"]').value,
    saved: JSON.parse(localStorage.getItem("mn2026.k3.creative.report") || "null"),
    msg: document.querySelector('[data-role="import-msg"]').textContent,
    count: document.querySelector('[data-compose="report"] [data-count="refs"]').textContent,
    refsLive: document.querySelector('[data-live="refs"]').textContent
  };
}

function pageExport(first) {
  const box = document.getElementById("submit");
  const out = {};
  if (first) {
    box.querySelector('[data-action="export"]').click();
    out.blocked = !!box.querySelector('[data-role="submit-blocked"]');
    box.querySelector('[data-choice="consent:no"]').click();
    box.querySelector('[data-choice="ai:no"]').click();
  }
  box.querySelector('[data-action="export"]').click();
  out.warnings = Array.from(box.querySelectorAll('[data-role="submit-warning"]')).map((e) => e.textContent);
  out.text = box.querySelector('[data-role="export-text"]').value;
  out.status = Array.from(box.querySelectorAll(".status-table tr")).map((e) => e.textContent);
  return out;
}

function pageLayout() {
  const f = document.querySelector('[data-compose="report"]').getBoundingClientRect();
  const pe = document.querySelector('[data-role="report-live"]');
  const p = pe.getBoundingClientRect();
  const h = document.querySelector("#compose-sec > h2").getBoundingClientRect();
  const cs = getComputedStyle(pe);
  return { fLeft: f.left, fRight: f.right, fBottom: f.bottom, fTop: f.top, hLeft: h.left, pLeft: p.left, pTop: p.top, pRight: p.right, iw: innerWidth,
    pScroll: pe.scrollHeight, pClient: pe.clientHeight, pBg: cs.backgroundImage + " " + cs.backgroundAttachment,
    pBarW: pe.offsetWidth - pe.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) };
}

/* ---------- 架空のレポート（約 1,200 字。「思う」2 回、「なので」1 回、本論3 は空） ---------- */

const REPORT = {
  theme: "T3",
  stance: "cond",
  title: "授業の形は内容に応じて選ぶべきである",
  question: "大学の授業は、オンデマンドより対面で行うべきか",
  answer: "大学の授業は、内容に応じて対面とオンデマンドを使い分けるべきだと考える。",
  p_intro: "大学の授業の形は、ここ数年で大きく変わった。感染症の流行をきっかけに、多くの大学が、教室での対面授業に加えて、録画を好きな時間に見るオンデマンド授業を取り入れている。オンデマンド授業には、自分のペースで学べるという利点がある。一方で、教員に質問しにくいという声もある。授業の形をどう選ぶかは、学生の学び方だけでなく、大学の教室や教員の時間の使い方にも関わる問題である。本レポートでは、大学の授業はオンデマンドより対面で行うべきかを考える。結論から述べると、授業の内容に応じて二つの形を使い分けるべきである。",
  p_body1: "対面授業の最大の利点は、その場で質問できることである。架空の調査である山田（2021）によれば、対面授業を受けた学生の多くが「疑問をその日のうちに解決できた」と答えている。疑問をすぐに解決できれば、学生は次の内容へ安心して進める。特に、実験や演習のように手を動かす授業では、教員がその場で様子を見て助言できる。この助言は、録画では代わりがききにくい。つまずいた理由をその場で確かめられることは、学生が同じ間違いを繰り返さないためにも役立つ。なので、演習を中心とする授業は対面で行うことが望ましいと思う。また、学生どうしが話し合う授業でも、同じ教室にいることが議論を深める助けになる。相手の表情や声の調子が分かると、自分の考えを言い出しやすくなり、ほかの人の意見を聞いて考えを改めるきっかけも生まれる。",
  p_body2: "これに対して、オンデマンド授業は、知識を順に説明する講義に向いている。佐藤（2022）は、録画の講義を繰り返し見た学生ほど、小テストの点が高かったと報告している［1］。録画であれば、分からないところを止めて何度でも見直せる。さらに、通学に時間がかかる学生や、アルバイトで決まった時間に出られない学生にとっては、好きな時間に学べることが大きな助けになる。講義の内容を覚えることが目的であれば、オンデマンドのほうが学びやすい場合もあると思う。ただし、見たかどうかを確かめる仕組みがなければ、学生が録画を後回しにしてしまうおそれがある。そのため、オンデマンド授業では、短い確認の問題を録画の区切りごとに置くなど、学びを続けやすくする工夫が欠かせない。",
  p_body3: "",
  p_concl: "以上から、大学の授業は、内容に応じて対面とオンデマンドを使い分けるべきだと考える。質問や話し合いが中心となる授業は対面で行い、知識の説明が中心となる講義はオンデマンドで行うと、それぞれの利点を生かせる。この考え方は、大学の授業に限らず、会社の研修や地域の講座にも当てはまる。今後は、オンデマンド授業でも気軽に質問できる仕組みを、どのように作るかを考える必要がある。そのためには、授業の後に短い質問の時間を設けることや、掲示板で質問を受け付けることが考えられる。どの方法が学生にとって使いやすいかは、実際に試して確かめる必要がある。授業の形を一つに決めてしまうのではなく、学生の声を聞きながら見直し続けることが、これからの大学に求められている。",
  refs: "山田花子（2021）『大学の授業と質問』架空出版。\n佐藤一郎（2022）「録画講義の効果」『架空教育研究』12巻、pp. 1-10。",
  self_review: "本論1の最初の文を、例から始まる文から、対面授業の利点を述べる文に直した。最初の文だけを読んだとき、段落の主張が分からなかったからである。"
};

// 課題2で保存された出典（課題2の作る「引用してみる」のキー）
const K2_CITE = {
  src1_kind: "book",
  src1_ref: "山田花子（2021）『大学の授業と質問』架空出版。",
  src2_kind: "web",
  src2_ref: "文部科学省（2023）「架空のページ」https://www.mext.go.jp/（2026年10月27日閲覧）",
  src1_quote: "", src1_use: "", src2_quote: "", src2_use: ""
};

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
  const games = K3.games;
  assert.deepEqual(games.map((g) => g.id), ["order", "topic", "find"]);
  const allAttempts = {};

  async function load(width) {
    await page.width(width);
    await page.goto("/k3/index.html");
    await waitFor(() => page.eval(`document.querySelectorAll("[data-game]").length === 3 && !!document.querySelector('[data-action="export"]') && !!document.querySelector('[data-role="report-live"]')`), 10000, "k3 の組み立て");
  }

  async function checkFields(label) {
    const fields = await page.call(pageFormFields);
    for (const f of fields) {
      assert.ok(!FORBIDDEN.test(f.attrs) && !FORBIDDEN.test(f.labels), `${label}：入力欄に個人情報を求める語があります ${JSON.stringify(f)}`);
    }
    return fields.length;
  }

  // 何も保存されていない状態から始める
  await load(1280);
  await page.eval(`localStorage.clear()`);

  for (const width of [375, 1280]) {
    await load(width);
    const s = await page.eval(`({
      lead: document.querySelector(".lead") && document.querySelector(".lead").textContent,
      nav: Array.from(document.querySelectorAll(".steps a")).map(a => a.textContent),
      h2: document.querySelector("#compose-sec h2").textContent,
      learn: document.getElementById("learn").textContent,
      learnH: Array.from(document.querySelectorAll("#learn h3")).map(h => h.textContent),
      pending: document.querySelectorAll("main .pending").length,
      importBtn: !!document.querySelector('[data-action="import-k2-refs"]'),
      gameTitles: Array.from(document.querySelectorAll("[data-game] h3")).map(h => h.textContent),
      fields: Array.from(document.querySelectorAll('[data-compose="report"] [data-field]')).map(e => e.getAttribute("data-field")),
      themeTag: document.querySelector('[data-field="theme"]').tagName,
      themeOpts: Array.from(document.querySelectorAll('[data-field="theme"] input[type="radio"]')).map(o => o.value),
      stanceOpts: Array.from(document.querySelectorAll('[data-field="stance"] label')).map(o => o.textContent),
      status: Array.from(document.querySelectorAll("#submit .status-table th")).map(e => e.textContent),
      statusTd: Array.from(document.querySelectorAll("#submit .status-table td")).map(e => e.textContent)
    })`);
    assert.equal(s.lead, "レポートは、問いを立て、根拠を示して答える文章です。書き方の決まりをゲームで確かめてから、最後に自分のレポートを1本書きます。このレポートが、3つの課題の最終提出物です。");
    assert.deepEqual(s.nav, ["① 学ぶ", "② ゲーム", "③ 書く", "④ 提出"]);
    assert.equal(s.h2, "③ 書く");
    assert.equal(s.learnH.length, K3.learn.length);
    for (const sec of K3.learn) {
      assert.ok(s.learn.includes(sec.h), "学ぶに見出しがありません：" + sec.h);
      sec.p.forEach((p) => assert.ok(s.learn.includes(p), "学ぶに本文がありません：" + p));
    }
    assert.equal(s.pending, 0, "準備中の表示が残っています");
    assert.equal(s.importBtn, false, "課題2の保存が無いのに読み込みボタンが出ています");
    assert.deepEqual(s.gameTitles, games.map((g) => g.title));
    assert.deepEqual(s.fields, ["theme", "stance", "title", "question", "answer", "p_intro", "p_body1", "p_body2", "p_body3", "p_concl", "refs", "self_review"]);
    assert.equal(s.themeTag, "FIELDSET");
    assert.deepEqual(s.themeOpts, ["T1", "T2", "T3", "T4", "T5"]);
    assert.deepEqual(s.stanceOpts, ["はい", "いいえ", "条件による"]);
    assert.equal(s.status.length, 4);
    assert.equal(s.status[3], "書く「最終レポート」");
    assert.equal(s.statusTd[3], "× まだ（必須の欄：テーマ、あなたの答え）");
    const nFields = await checkFields(`k3 ${width}px`);
    await page.noHScroll(`k3 ${width}px 読み込み直後`);
    await page.shot(`w${width}_top`, "header");
    await page.shot(`w${width}_learn`, "#learn-sec");
    ok(`k3（${width}px）：リード・学ぶ ${s.learnH.length} 枚・ゲーム 3 つ・書く・提出を組み立て、入力欄 ${nFields} 個に個人情報を求める語なし、課題2の保存が無いので読み込みボタンなし、横スクロールなし`);

    // 問題画面と判定後（各ゲーム 1 問、記録には残らない）
    for (const g of games) {
      await page.call(pageOneItem, g, "start");
      await page.noHScroll(`${g.id} ${width}px 問題`);
      await page.shot(`w${width}_${g.id}_question`, `[data-game="${g.id}"]`);
      await page.call(pageOneItem, g, "judge");
      await page.noHScroll(`${g.id} ${width}px 判定後`);
      await page.shot(`w${width}_${g.id}_judged`, `[data-game="${g.id}"] [data-role="feedback"]`);
    }
    await page.goto("/k3/index.html");
    const leftover = await page.eval(`Object.keys(localStorage).filter(k => /\\.game\\./.test(k))`);
    assert.deepEqual(leftover, [], "途中でやめた挑戦が記録されています");
    ok(`k3（${width}px）：各ゲームの問題画面・判定後に横スクロールなし、途中でやめた挑戦は記録されない`);
  }

  // 1 回目：幅 1280px、正解だけ → 満点。2 回目：幅 375px、わざと間違い混じり → 画面＝再計算
  const passes = [{ width: 1280, mode: "correct" }, { width: 375, mode: "mixed" }];
  for (const { width, mode } of passes) {
    await load(width);
    for (const g of games) {
      const r = await page.call(pagePlay, g, mode);
      assert.deepEqual(r.overflow, [], `${g.id}（${width}px）：横スクロール ${r.overflow}`);
      assert.equal(r.count, g.items.length);
      const re = S.scoreGame(g, r.answers);
      assert.equal(r.score, re.score, `${g.id}：画面の点数 ${r.score} と再計算 ${re.score} が違います`);
      assert.equal(r.max, re.max);
      assert.equal(r.rank, S.rank(re.score, re.max));
      if (mode === "correct") {
        assert.equal(r.score, r.max, `${g.id}：正解だけなのに満点ではありません`);
        assert.equal(r.max, g.type === "find" ? g.items.reduce((n, it) => n + S.maxItem("find", it), 0) : 10 * g.items.length);
      } else assert.ok(r.score < r.max, `${g.id}：間違い混じりなのに満点です`);
      (allAttempts[g.id] ||= []).push({ answers: r.answers, score: r.score });
      ok(`k3（${width}px）${g.id}：${mode === "correct" ? "正解だけ" : "わざと間違い混じり"} ${r.score} / ${r.max}（${r.rank}）画面＝scoring.js の再計算${g.type === "order" ? "、どの問題も最初の並びは正解と違う" : ""}`);
    }
    await page.shot(`w${width}_games_result`, "#games-sec");
  }

  // 最終レポート：課題2の出典を入れてから読み込み直す
  await page.eval(`localStorage.setItem("mn2026.k2.creative.cite", ${JSON.stringify(JSON.stringify(K2_CITE))})`);
  for (const width of [375, 1280]) {
    await load(width);
    if (width === 375) {
      const empty = await page.call(pageFillReport, {});
      assert.equal(empty.topics.length, 0);
      assert.equal(empty.live.chars.ok, "0");
      const f = await page.call(pageFillReport, REPORT);
      // トピック・センテンス一覧：本論3 は空なので 4 つ
      const expectTopics = ["p_intro", "p_body1", "p_body2", "p_concl"].map((k) => REPORT[k].slice(0, REPORT[k].indexOf("。") + 1));
      assert.equal(f.topics.length, 4);
      const labels = ["序論", "本論1", "本論2", "結論"];
      f.topics.forEach((t, i) => assert.equal(t, labels[i] + expectTopics[i]));
      // 字数：テスト側で別に数える（空白と改行を除く）
      const n = ["p_intro", "p_body1", "p_body2", "p_body3", "p_concl"].reduce((a, k) => a + REPORT[k].replace(/\s/g, "").length, 0);
      assert.ok(n >= 1150 && n <= 1300, "架空のレポートの字数 " + n);
      assert.ok(f.live.chars.text.includes("字数（空白・改行を除く）：" + n + "字"), "字数の表示：" + f.live.chars.text);
      assert.equal(f.live.chars.ok, n >= 1200 && n <= 2000 ? "1" : "0");
      // 話し言葉の候補
      assert.ok(f.live.colloquial.text.includes("「思う」2回"), f.live.colloquial.text);
      assert.ok(f.live.colloquial.text.includes("「なので」1回"), f.live.colloquial.text);
      // 「学生にとっては」の「って」は候補にしない
      assert.ok(REPORT.p_body2.includes("にとって") && !f.live.colloquial.text.includes("って"), f.live.colloquial.text);
      // 接続詞は文の頭だけ（「なので」「また」「さらに」の 3 回。「授業でも」の「でも」は数えない）
      assert.ok(REPORT.p_body1.includes("授業でも"));
      assert.ok(f.live.conj.text.includes("接続詞：3回") && !f.live.conj.text.includes("「でも」"), f.live.conj.text);
      assert.equal(f.live.colloquial.ok, "0");
      assert.equal(f.live.refs.ok, "1");
      assert.equal(f.live.cite.ok, "1");
      assert.deepEqual(Object.keys(f.live).sort(), ["chars", "cite", "colloquial", "conj", "desumasu", "long", "refs", "topics"]);
      assert.deepEqual(f.saved, f.values, "入力が保存されていません");
      // 画面の表示が report.js の結果と合う
      const rr = R.check(REPORT);
      assert.equal(rr.chars.n, n);
      assert.ok(f.live.conj.text.includes(rr.conj.total + "回"));
      assert.equal(f.live.long.ok, rr.long.ok ? "1" : "0");
      assert.equal(f.live.desumasu.ok, "1");
      ok(`ライブ点検：トピック・センテンス 4 つ（本論3 の空欄は飛ばす）、字数 ${n} 字、話し言葉「思う」2回・「なので」1回、8 項目を表示`);

      // 1 文直すと一覧が変わる
      const f2 = await page.call(pageFillReport, { p_body3: "三つ目の論点を述べる。続きの文。" });
      assert.equal(f2.topics.length, 5);
      assert.equal(f2.topics[3], "本論3三つ目の論点を述べる。");
      const f3 = await page.call(pageFillReport, { p_body3: "" });
      assert.equal(f3.topics.length, 4);
      ok("ライブ点検：入力のたびに更新される（本論3 を書くと 5 つ、消すと 4 つ）");

      // 課題2の出典を読み込む（src1 はすでに入っているので src2 だけが足される）
      const im = await page.call(pageImport);
      assert.equal(im.refs, REPORT.refs + "\n" + K2_CITE.src2_ref);
      assert.equal(im.saved.refs, im.refs, "読み込んだ出典が保存されていません");
      assert.ok(im.count.startsWith(im.refs.length + " / 1000"), "字数の表示：" + im.count);
      assert.ok(im.refsLive.includes("出典の数：3"), im.refsLive);
      const im2 = await page.call(pageImport);
      assert.equal(im2.refs, im.refs, "2 回押すと同じ出典が重複します");
      // 上限（1000 字）を超えて切れたときは、そう伝える。試したあとは元に戻す
      await page.call(pageFillReport, { refs: "長".repeat(990) });
      const im3 = await page.call(pageImport);
      assert.equal(im3.refs.length, 1000);
      assert.equal(im3.msg, " 上限の 1000 字を超えたため、一部を追加できませんでした。");
      const back = await page.call(pageFillReport, { refs: im.refs });
      assert.equal(back.saved.refs, im.refs);
      ok("課題2で書いた出典を読み込む：空でないものを末尾に 1 行ずつ追記、同じ行は足さない、保存とライブ点検も更新");
    }
    // 読み込み直しても残っている
    const kept = await page.call(pageFillReport, {});
    assert.equal(kept.values.p_body1, REPORT.p_body1);
    assert.equal(kept.topics.length, 4);
    const lay = await page.call(pageLayout);
    if (width === 1280) {
      assert.ok(lay.pLeft >= lay.fRight && Math.abs(lay.pTop - lay.fTop) < 2, "1280px でライブ点検が横に並んでいません " + JSON.stringify(lay));
      // 「③ 書く」の見出しとフォームの左端がそろう
      assert.ok(Math.abs(lay.hLeft - lay.fLeft) < 1, "見出しとフォームの左端がそろっていません " + JSON.stringify(lay));
      // パネルの中でスクロールするときは、下端の影とスクロールバー（自分で描く幅 12px）が出る
      assert.ok(lay.pScroll > lay.pClient, "パネルが画面に収まっています（スクロールの確認ができません）" + JSON.stringify(lay));
      assert.ok(lay.pBg.includes("linear-gradient") && lay.pBg.includes("local"), "下端の影がありません：" + lay.pBg);
      assert.equal(lay.pBarW, 12, "スクロールバーの幅：" + lay.pBarW);
    }
    else assert.ok(lay.pTop >= lay.fBottom, "375px でライブ点検がフォームの下にありません " + JSON.stringify(lay));
    assert.ok(lay.pRight <= lay.iw);
    await page.noHScroll(`k3 ${width}px 書く`);
    await page.shot(`w${width}_compose_top`, "#compose-sec");
    if (width === 375) await page.shot(`w${width}_compose_live`, '[data-role="report-live"]');
    else await page.shot(`w${width}_compose_body`, '[data-field="p_body1"]');
    ok(`書く（${width}px）：${width === 1280 ? "ライブ点検は横" : "ライブ点検は下"}、読み込み直しても入力が残る、横スクロールなし`);
  }

  async function verifySubmission(text) {
    const sub = JSON.parse(text);
    assert.equal(text, JSON.stringify(sub, null, 2) + "\n");
    const v = S.validateSubmission(sub);
    assert.ok(v.ok, "validateSubmission 不合格：" + v.errors.join(" / "));
    assert.equal(sub.kadai, 3);
    assert.equal(sub.data_version, K3.version);
    assert.deepEqual(Object.keys(sub.games).sort(), ["find", "order", "topic"]);
    for (const g of games) {
      const atts = sub.games[g.id].attempts;
      assert.equal(atts.length, 2, `${g.id} の挑戦の数`);
      atts.forEach((a, i) => {
        const re = S.scoreGame(g, a.answers);
        assert.equal(a.score, re.score, `${g.id} 挑戦${i + 1}：ファイルの点数と再計算が違います`);
        assert.equal(a.max, re.max);
        assert.equal(a.score, allAttempts[g.id][i].score, `${g.id} 挑戦${i + 1}：画面の点数と違います`);
      });
      assert.equal(atts[0].score, atts[0].max, `${g.id}：1 回目は満点のはず`);
    }
    assert.deepEqual(Object.keys(sub.creative), ["report"]);
    return sub;
  }

  // 提出（375px）
  await load(375);
  const ex = await page.call(pageExport, true);
  assert.equal(ex.blocked, true, "同意を選ばなくても作れてしまいます");
  assert.deepEqual(ex.warnings, [], "警告が出ています：" + ex.warnings.join(" / "));
  assert.ok(ex.status.every((t) => /○/.test(t)), "進み具合：" + ex.status.join(" / "));
  const sub = await verifySubmission(ex.text);
  saveExport("間違い混じり", 3, ex.text); // 1 回目は正解だけ、2 回目は間違い混じりの挑戦が入る
  const rep = sub.creative.report;
  for (const k of Object.keys(REPORT)) {
    const want = k === "refs" ? REPORT.refs + "\n" + K2_CITE.src2_ref : REPORT[k];
    assert.equal(rep[k], want, "creative.report." + k);
  }
  await page.noHScroll("k3 375px 提出");
  await page.shot("w375_submit", "#submit-sec");
  ok("提出（375px）：validateSubmission 合格、creative.report に 12 欄、全挑戦の点数＝scoring.js の再計算、進み具合はすべて ○");

  // 各欄を上限まで埋めても（合計 5,880 字）提出ファイルを作れる
  await load(1280);
  const maxes = { title: 60, question: 120, answer: 200, p_intro: 700, p_body1: 900, p_body2: 900, p_body3: 900, p_concl: 700, refs: 1000, self_review: 400 };
  const big = {};
  for (const [k, m] of Object.entries(maxes)) big[k] = ("長い文である。" + "あ".repeat(m)).slice(0, m) + "超過";
  const fb = await page.call(pageFillReport, big);
  for (const [k, m] of Object.entries(maxes)) assert.equal(fb.values[k].length, m, `${k} が ${m} 字で止まりません`);
  const total = Object.values(fb.values).reduce((a, x) => a + x.length, 0);
  assert.ok(total >= 5880, "合計 " + total);
  const ex2 = await page.call(pageExport, false);
  assert.deepEqual(ex2.warnings, []);
  const sub2 = await verifySubmission(ex2.text);
  for (const [k, m] of Object.entries(maxes)) assert.equal(sub2.creative.report[k].length, m);
  await page.noHScroll("k3 1280px 上限まで入力");
  await page.shot("w1280_compose_full", "#compose-sec");
  await page.shot("w1280_submit", "#submit-sec");
  ok(`上限まで入力（合計 ${total} 字）：各欄は上限で止まり、提出ファイルは validateSubmission 合格、横スクロールなし`);

  const keys = await page.eval(`Object.keys(localStorage)`);
  assert.ok(keys.every((k) => k.startsWith("mn2026.")), "mn2026. 以外のキー：" + keys);
  const external = page.requests.filter((u) => !u.startsWith(base) && !/^(data|blob|about):/.test(u));
  assert.deepEqual(external, [], "外部への通信：" + external.join(", "));
  ok(`localStorage のキーはすべて mn2026.、通信はすべて ${base} の中（${page.requests.length} 件）`);

  assert.deepEqual(page.errors, [], "JS のエラー：\n" + page.errors.join("\n"));
  ok("JS のエラーなし");
  console.log(`\n合格（${results.length} 項目）`);
}

main().then(() => { cleanup(); process.exit(0); }, (e) => {
  console.error("\n× 不合格：" + (e && e.stack || e));
  cleanup();
  process.exit(1);
});
