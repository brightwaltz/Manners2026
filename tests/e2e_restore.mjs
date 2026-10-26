// 「保存したファイルから続ける」の通しの検査：node tests/e2e_restore.mjs
// 依存なし。python3 -m http.server と headless Chrome を立て、Chrome DevTools Protocol で操作する（起動部分は e2e_k1.mjs と同じ）。
// 課題1で 1 ゲーム解いて作る1 を書き、提出ファイルを作る → localStorage を全部消す → 貼り付け欄から読み込む／
// ファイル選択（DOM.setFileInputFiles）から読み込む → 記録と入力が戻り、作り直した提出ファイルが合格し点数が一致する。
// 別の課題のファイル・壊れた中身の案内、今の入力と違うときの確認、375px で横スクロールなし、JS のエラーなしも確かめる。
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
const PAGE = "/k1/index.html";
const MSG_BAD = "ファイルの形が読み取れませんでした。サイトが作った提出ファイルを選んでください。";

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

function pageStart(gid) {
  const box = document.querySelector(`[data-game="${gid}"]`);
  box.querySelector('[data-action="start"],[data-action="retry"]').click();
  return !!box.querySelector("[data-item-id]");
}

// choice のゲームを正解どおりに最後まで解く
function pagePlayChoice(gameDef) {
  const box = document.querySelector(`[data-game="${gameDef.id}"]`);
  const answers = {};
  for (;;) {
    const card = box.querySelector("[data-item-id]");
    const id = card.getAttribute("data-item-id");
    const item = gameDef.items.find((x) => x.id === id);
    card.querySelector(`[data-opt="${item.answer}"]`).click();
    answers[id] = item.answer;
    const next = card.querySelector('[data-action="next"],[data-action="finish"]');
    const last = next.getAttribute("data-action") === "finish";
    next.click();
    if (last) break;
  }
  const res = box.querySelector('[data-role="result"]');
  return { answers, score: Number(res.querySelector("[data-result-score]").textContent), max: Number(res.querySelector("[data-result-max]").textContent) };
}

function pageSet(fid, field, value) {
  const e = document.querySelector(`[data-compose="${fid}"] [data-field="${field}"]`);
  e.value = value;
  e.dispatchEvent(new Event("input", { bubbles: true }));
  e.dispatchEvent(new Event("change", { bubbles: true }));
  return e.value;
}

function pageExport() {
  const box = document.getElementById("submit");
  box.querySelector('[data-choice="consent:yes"]').click();
  box.querySelector('[data-choice="ai:no"]').click();
  box.querySelector('[data-action="export"]').click();
  const anyway = box.querySelector('[data-action="export-anyway"]');
  if (anyway) anyway.click();
  return box.querySelector('[data-role="export-text"]').value;
}

// 今の記録と画面の様子
function pageState(fields) {
  const submit = document.getElementById("submit");
  const label = submit.querySelector("label.file-btn");
  const summary = submit.querySelector(".restore-paste summary");
  const file = submit.querySelector('[data-role="restore-file"]');
  return {
    attempts: JSON.parse(localStorage.getItem("mn2026.k1.game.choice") || "[]"),
    mail: Object.fromEntries(fields.map((f) => [f, document.querySelector(`[data-compose="mail"] [data-field="${f}"]`).value])),
    consentYes: submit.querySelector('[data-choice="consent:yes"]').checked,
    aiNo: submit.querySelector('[data-choice="ai:no"]').checked,
    msg: (submit.querySelector('[data-role="restore-msg"]') || {}).textContent || "",
    first: submit.firstElementChild.getAttribute("data-role"),
    restoreText: submit.querySelector('[data-role="restore"]').textContent,
    submitText: submit.textContent,
    file: { type: file.type, accept: file.getAttribute("accept"), inLabel: label.contains(file) },
    labelText: label.textContent,
    labelH: label.getBoundingClientRect().height,
    summaryText: summary.textContent,
    summaryH: summary.getBoundingClientRect().height,
    keys: Object.keys(localStorage)
  };
}

// 「ファイルを選べないときは」を開き、貼り付けて読み込む（読み込めたときは組み立て直しが始まる）
function pagePaste(text) {
  const d = document.querySelector("#submit .restore-paste");
  d.open = true;
  const t = d.querySelector('[data-role="restore-text"]');
  t.value = text;
  t.dispatchEvent(new Event("input", { bubbles: true }));
  d.querySelector('[data-action="restore-paste"]').click();
  return (document.querySelector('[data-role="restore-msg"]') || {}).textContent || "";
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
    "",
    "よろしくお願いいたします。",
    "",
    "工学部 1年 玉川 みらい（学籍番号 99Z9999）",
    "mirai.tamagawa@example.ac.jp"
  ].join("\n")
};
const FIELDS = Object.keys(MAIL);

/* ---------- 本体 ---------- */

let fileDir = null;
process.on("exit", () => { if (fileDir) { try { rmSync(fileDir, { recursive: true, force: true }); } catch {} } });

async function main() {
  const game = DATA.games.find((g) => g.id === "choice");
  assert.ok(game && game.type === "choice", "data/k1.json に choice のゲームがありません");

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
  await page.width(375);

  const ready = () => waitFor(() => page.eval(`document.querySelectorAll("[data-game]").length === ${DATA.games.length} && document.querySelectorAll("[data-compose]").length === 3 && !!document.querySelector('#submit [data-action="export"]')`), 10000, "k1 の組み立て");
  async function load() { await page.goto(PAGE); await ready(); }
  // 読み込みのあと、ページが組み立て直されるのを待つ
  async function afterReload(action, what) {
    const n = page.loaded;
    await action();
    await waitFor(() => page.loaded > n, 15000, what + "：組み立て直し");
    await sleep(300);
    await ready();
  }
  const state = () => page.call(pageState, FIELDS);

  /* 1. 枠の表示（プロファイルは新しいので記録は空） */
  await load();
  let s = await state();
  assert.equal(s.first, "restore", "④提出の先頭に「保存したファイルから続ける」がありません");
  assert.ok(s.restoreText.includes("保存したファイルから続ける"));
  assert.ok(s.restoreText.includes("記録はこの端末のブラウザの中だけにあります。別の端末で続けるときや、記録が消えたときは、前に作った提出ファイルを読み込むと続きからできます。"));
  assert.deepEqual(s.file, { type: "file", accept: ".txt,.json,text/plain", inLabel: true });
  assert.equal(s.labelText, "提出ファイルを選んで読み込む");
  assert.equal(s.summaryText, "ファイルを選べないときは");
  assert.ok(s.labelH >= 44, `ファイルを選ぶボタンの高さ ${s.labelH}px`);
  assert.ok(s.summaryH >= 44, `「ファイルを選べないときは」の高さ ${s.summaryH}px`);
  assert.ok(s.submitText.includes("途中でも作れます。作ったファイルは保存用にもなります（あとで作り直して、提出し直せます）。"));
  await page.eval(`document.querySelector("#submit .restore-paste").open = true`);
  await page.noHScroll("restore_box", '[data-role="restore"]');
  ok("④提出の先頭に枠：説明文・ファイル選択（accept .txt,.json,text/plain、高さ 44px 以上）・貼り付け欄、提出の説明に 1 文、375px で横スクロールなし");

  /* 2. 1 ゲーム解いて作る1 を書き、提出ファイルを作る */
  assert.ok(await page.call(pageStart, game.id));
  const played = await page.call(pagePlayChoice, game);
  assert.equal(played.score, S.scoreGame(game, played.answers).score);
  for (const f of FIELDS) await page.call(pageSet, "mail", f, MAIL[f]);
  const text1 = await page.call(pageExport);
  const sub1 = JSON.parse(text1);
  assert.ok(S.validateSubmission(sub1).ok);
  assert.equal(sub1.games.choice.attempts.length, 1);
  assert.deepEqual(sub1.creative.mail, MAIL);
  ok(`課題1：choice を解いて ${played.score} / ${played.max}、作る1 を書き、提出ファイルを作成`);

  // 戻ったかを確かめる。作り直した提出ファイルも合格し、点数が再計算と一致する
  async function verifyRestored(label, expectMsg) {
    const st = await state();
    assert.equal(st.msg, expectMsg, `${label}：読み込みの結果の表示`);
    assert.deepEqual(st.attempts, sub1.games.choice.attempts, `${label}：ゲームの記録`);
    assert.deepEqual(st.mail, MAIL, `${label}：作る1 の入力`);
    assert.ok(st.consentYes && st.aiNo, `${label}：同意と生成AIの選択`);
    assert.ok(st.keys.every((k) => k.startsWith("mn2026.")), "mn2026. 以外のキー：" + st.keys);
    const text = await page.call(pageExport);
    const sub = JSON.parse(text);
    const v = S.validateSubmission(sub);
    assert.ok(v.ok, `${label}：validateSubmission 不合格：` + v.errors.join(" / "));
    assert.deepEqual(sub.games, sub1.games, `${label}：作り直した提出ファイルのゲームの記録`);
    for (const gid of Object.keys(sub.games)) {
      const g = DATA.games.find((x) => x.id === gid);
      for (const a of sub.games[gid].attempts) {
        const re = S.scoreGame(g, a.answers);
        assert.deepEqual([a.score, a.max], [re.score, re.max], `${label}：${gid} の点数と再計算`);
      }
    }
    assert.deepEqual(sub.creative, sub1.creative, `${label}：作るの中身`);
    assert.equal(sub.first_visit_at, sub1.first_visit_at, `${label}：最初に開いた日時は早いほう`);
    await page.noHScroll(label, '[data-role="restore"]');
  }
  const okMsg = "読み込みました：ゲームの記録 1 回、作る 1 件。";

  /* 3. 全部消して、貼り付け欄から読み込む */
  await page.eval("localStorage.clear()");
  await load();
  s = await state();
  assert.deepEqual([s.attempts, s.mail.subject, s.consentYes], [[], "", false], "記録が消えていません");
  await afterReload(() => page.call(pagePaste, "﻿" + text1), "貼り付け");
  await verifyRestored("貼り付けから読み込み", okMsg);
  ok("localStorage を消して、貼り付け欄から読み込み：ゲームの記録・作る1・同意・生成AI・最初の日時が戻り、作り直した提出ファイルが合格、点数＝再計算");

  /* 4. 全部消して、ファイル選択から読み込む */
  fileDir = mkdtempSync(join(tmpdir(), "mn2026-restore-"));
  const path = join(fileDir, "マナー課題1_提出.txt");
  writeFileSync(path, text1);
  await page.eval("localStorage.clear()");
  await load();
  assert.deepEqual((await state()).attempts, []);
  await afterReload(async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 }, page.sessionId);
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-role="restore-file"]' }, page.sessionId);
    assert.ok(nodeId, "ファイル選択の欄が見つかりません");
    await cdp.send("DOM.setFileInputFiles", { files: [path], nodeId }, page.sessionId);
  }, "ファイル選択");
  await verifyRestored("ファイル選択から読み込み", okMsg);
  ok("localStorage を消して、ファイル選択（DOM.setFileInputFiles）から読み込み：同じく戻り、作り直した提出ファイルが合格、点数＝再計算");

  /* 5. 同じファイルをもう一度：記録は重複しない。今の入力と違えば確認し、キャンセルなら今の入力を残す */
  await page.call(pageSet, "mail", "subject", "いま書きかえた件名");
  await page.eval(`window.confirm = (q) => { sessionStorage.setItem("asked", q); return false; }`);
  await afterReload(() => page.call(pagePaste, text1), "確認でキャンセル");
  s = await state();
  assert.match(await page.eval(`sessionStorage.getItem("asked") || ""`), /^いまの入力をファイルの内容で置き換えますか？（キャンセルすると、いまの入力を残し、ゲームの記録だけ読み込みます）$/);
  assert.equal(s.mail.subject, "いま書きかえた件名", "キャンセルしたのに置き換わりました");
  assert.deepEqual(s.attempts, sub1.games.choice.attempts, "同じ挑戦が重複しました");
  assert.equal(s.msg, "読み込みました：ゲームの記録 1 回、作る 0 件。");
  await page.eval(`sessionStorage.clear(); window.confirm = () => true`);
  await afterReload(() => page.call(pagePaste, text1), "確認で OK");
  s = await state();
  assert.equal(s.mail.subject, MAIL.subject, "OK したのに置き換わりません");
  assert.equal(s.attempts.length, 1);
  ok("同じファイルをもう一度：記録は重複しない、今の入力と違えば確認（キャンセル→今の入力を残す、OK→置き換え）");

  /* 6. 別の課題のファイル・壊れた中身 */
  await page.goto("/k2/index.html");
  await waitFor(() => page.eval(`!!document.querySelector('#submit [data-action="export"]')`), 10000, "k2 の組み立て");
  const text2 = await page.eval(`JSON.stringify(MN.submit.build(2), null, 2) + "\\n"`);
  assert.ok(S.validateSubmission(JSON.parse(text2)).ok);
  await load();
  const before = await state();
  for (const [t, expect] of [[text2, "これは課題2のファイルです。課題2のページで読み込んでください。"], ["{ \"schema\": ", MSG_BAD], [JSON.stringify({ ...sub1, student: "x" }), MSG_BAD]]) {
    const n = page.loaded;
    const msg = await page.call(pagePaste, t);
    assert.equal(msg, expect);
    await sleep(500);
    assert.equal(page.loaded, n, "読み込めないのにページが読み直されました");
  }
  const after = await state();
  assert.deepEqual([after.attempts, after.mail, after.keys.sort()], [before.attempts, before.mail, before.keys.sort()], "読み込めないのに記録が変わりました");
  await page.noHScroll("restore_error", '[data-role="restore"]');
  ok("課題2のファイルを課題1で読み込むと案内、壊れた中身・形の違うファイルも案内、記録は変わらない");

  /* 7. トップの説明 */
  await page.goto("/index.html");
  const top = await page.eval("document.body.textContent");
  assert.ok(top.includes("Safari では、7日以上このサイトを開かないと記録が消えることがあります。途中でやめるときは、各課題の④提出で「提出ファイルを作る」を押してファイルを保存しておくと、あとで「保存したファイルから続ける」で読み込めます。"));
  await page.noHScroll("top");
  ok("トップの「記録と個人情報について」に Safari の説明");

  const external = page.requests.filter((u) => !u.startsWith(base) && !/^(data|blob|about|file):/.test(u));
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
