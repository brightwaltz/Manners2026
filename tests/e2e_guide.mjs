// 課題の進め方ガイドの通しの検査：node tests/e2e_guide.mjs
// 依存なし。起動のしかたは tests/e2e.mjs と同じ（python3 -m http.server と headless Chrome、CDP で操作）。
// 7 つの場面の移動（ボタン・←→キー・#s1〜#s7）、各場面の操作、記録への影響がないこと、
// reduced-motion、375px と 1280px で横スクロールなし、JS のエラーなし、外部への通信なしを確かめる。
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = "/guide/index.html";

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
      // ブラウザが自動で取りに行く favicon.ico の 404 は想定どおり（動画とポスターの 404 は不合格）
      if (!(e.source === "network" && /\/favicon\.ico$/.test(e.url || ""))) page.errors.push("Log：" + e.text + " " + (e.url || ""));
    }
    if (m.method === "Network.requestWillBeSent") page.requests.push(m.params.request.url);
    if (m.method === "Page.loadEventFired") page.loaded++;
  });
  for (const d of ["Runtime", "Log", "Page", "Network"]) await cdp.send(d + ".enable", {}, sessionId);
  // キー入力がページに届くように、ページにフォーカスがある扱いにする
  await cdp.send("Page.bringToFront", {}, sessionId);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  page.eval = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error("評価エラー：" + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  page.call = (fn, ...args) => page.eval(`(${fn})(...${JSON.stringify(args)})`);
  page.width = async (w) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: w < 600 }, sessionId);
  };
  // URL のフラグメントだけが違う移動では load が来ないので、別のページを経由してから開く
  page.goto = async (path) => {
    const n = page.loaded;
    await cdp.send("Page.navigate", { url: base + path }, sessionId);
    await waitFor(() => page.loaded > n, 15000, path + " の読み込み");
    await sleep(300);
  };
  page.reload = async () => {
    const n = page.loaded;
    await cdp.send("Page.reload", {}, sessionId);
    await waitFor(() => page.loaded > n, 15000, "再読み込み");
    await sleep(300);
  };
  page.key = async (key) => {
    const code = { ArrowLeft: 37, ArrowRight: 39, Tab: 9 }[key];
    for (const type of ["keyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, sessionId);
    }
    await sleep(30);
  };
  page.reducedMotion = (on) => cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] }, sessionId);
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

// いま見えている場面と表示
function pageState() {
  const vis = Array.from(document.querySelectorAll(".g-scene")).filter((s) => !s.hidden);
  return {
    visible: vis.map((s) => Number(s.getAttribute("data-scene"))),
    count: document.getElementById("g-count").textContent,
    prev: document.getElementById("g-prev").disabled,
    next: document.getElementById("g-next").disabled,
    hash: location.hash
  };
}

// 見えている場面の中のボタン・リンクの高さ（44px 以上か）
function pageSmallTargets() {
  const scene = Array.from(document.querySelectorAll(".g-scene")).find((s) => !s.hidden);
  const els = [...scene.querySelectorAll("button, a.btn, .g-todo label"), ...document.querySelectorAll(".g-nav button")];
  return els.filter((e) => e.offsetParent !== null).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]).filter((x) => x[1] < 44);
}

// localStorage の中身を全部
function pageStorage() {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); }
  return o;
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
  const state = () => page.call(pageState);
  // hashchange は非同期なので、場面 n が見えるまで少し待つ（来なければそのときの状態を返す）
  const settle = async (n) => {
    try { return await waitFor(async () => { const st = await state(); return st.visible.length === 1 && st.visible[0] === n && st; }, 2000, "場面" + n); } catch { return state(); }
  };
  const click = (sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("ない：" + ${JSON.stringify(sel)}); e.click(); })()`);

  // 本物の記録の見本を先に入れておく（ガイドを操作しても変わらないことを確かめる）
  await page.width(1280);
  await page.goto(PAGE);
  await page.eval(`(() => {
    localStorage.clear();
    localStorage.setItem("mn2026.k1.game.find", JSON.stringify([{ t0: "2026-10-27T10:00:00+09:00", score: 7, max: 10 }]));
    localStorage.setItem("mn2026.k1.compose.mail", JSON.stringify({ subject: "見本の件名" }));
    localStorage.setItem("mn2026.k1.submit", JSON.stringify({ consent: true }));
    localStorage.setItem("mn2026.first_visit_at", JSON.stringify("2026-10-27T10:00:00+09:00"));
  })()`);
  const before = await page.call(pageStorage);
  await page.reload();

  // 動画があるので枠が出る。長さは約60秒、ポスターも読み込める
  await waitFor(() => page.eval(`!document.getElementById("film").hidden`), 10000, "#film の表示");
  const film = await page.eval(`(async () => {
    const v = document.querySelector("#film video");
    const img = new Image();
    const poster = await new Promise((res) => { img.onload = () => res(img.naturalWidth); img.onerror = () => res(0); img.src = v.poster; });
    const credit = Array.from(document.querySelectorAll("#film .g-credit a")).map(a => a.getAttribute("href"));
    return { duration: v.duration, poster, posterSrc: v.getAttribute("poster"), credit: Array.from(new Set(credit)).sort(), text: document.querySelector("#film .g-credit").textContent,
      fs: getComputedStyle(document.querySelector("#film .g-credit")).fontSize };
  })()`);
  assert.ok(film.duration >= 59 && film.duration <= 61, "動画の長さ：" + film.duration);
  assert.ok(film.poster > 0, "ポスター（" + film.posterSrc + "）が読み込めません");
  assert.deepEqual(film.credit, [
    "https://creativecommons.org/licenses/by/4.0/",
    "https://freesound.org/people/MattRuthSound/sounds/562094",
    "https://freesound.org/people/dersuperanton/sounds/433649"
  ], "クレジットのリンク");
  assert.equal(film.text, "効果音：“Plopp Bubble popping” by dersuperanton（CC BY 4.0）、“Wood tapping drumsticks hitting 001.wav” by MattRuthSound（CC BY 4.0）、ほか CC0 の素材（Freesound）。");
  assert.equal(film.fs, "14px");
  ok(`#film が表示される：動画 ${film.duration.toFixed(2)} 秒、ポスター幅 ${film.poster}px、クレジットのリンク 3 つ（14px）`);

  // 1 回分の操作（幅と reduced-motion を変えて繰り返す）
  async function runAll(width, reduce) {
    const tag = `${width}px${reduce ? " reduce" : ""}`;
    await page.width(width);
    await page.reducedMotion(reduce);
    await page.goto("/index.html");
    await page.goto(PAGE);
    assert.equal(await page.eval(`matchMedia("(prefers-reduced-motion: reduce)").matches`), reduce);

    // 「次へ」で最後まで、「前へ」で最初まで
    let s = await state();
    assert.deepEqual([s.visible, s.count, s.prev, s.next], [[1], "場面 1 / 7", true, false], "最初の表示");
    const hist0 = await page.eval(`history.length`);
    // ボタンを押したときと同じく、フォーカスを置いてから押す
    for (let n = 2; n <= 7; n++) {
      await page.eval(`(() => { const b = document.getElementById("g-next"); b.focus(); b.click(); })()`);
      s = await state();
      assert.deepEqual([s.visible, s.count, s.hash], [[n], `場面 ${n} / 7`, `#s${n}`], `次へ → ${n}`);
    }
    assert.equal(s.next, true, "場面7で「次へ」が押せます");
    assert.equal(await page.eval(`document.activeElement.id`), "g-h7", "「次へ」が使えなくなったとき、フォーカスが見出しに移っていません");
    for (let n = 6; n >= 1; n--) {
      await click("#g-prev");
      s = await state();
      assert.deepEqual([s.visible, s.count], [[n], `場面 ${n} / 7`], `前へ → ${n}`);
    }
    // ←→キー
    await page.eval(`document.getElementById("g-next").focus()`);
    for (let n = 2; n <= 7; n++) {
      await page.key("ArrowRight");
      s = await settle(n);
      assert.deepEqual([s.visible, s.count], [[n], `場面 ${n} / 7`], `→キー → ${n}`);
    }
    await page.key("ArrowRight");
    await sleep(300);
    assert.deepEqual((await state()).visible, [7], "場面7で→キーを押すと動いてはいけません");
    for (let n = 6; n >= 1; n--) {
      await page.key("ArrowLeft");
      s = await settle(n);
      assert.deepEqual([s.visible, s.count], [[n], `場面 ${n} / 7`], `←キー → ${n}`);
    }
    assert.equal(await page.eval(`history.length`), hist0, "場面を移るたびに履歴が増えています（replaceState のはず）");
    // 「最初の場面へ」
    await page.eval(`location.hash = "#s5"`);
    await sleep(50);
    assert.deepEqual((await state()).visible, [5]);
    await click("#g-first");
    assert.deepEqual((await state()).visible, [1], "「最初の場面へ」");
    ok(`${tag}：「次へ」「前へ」と←→キーで場面 1〜7 を行き来、「場面 n / 7」の表示、端でボタンが止まる、履歴は増えない（replaceState）、「最初の場面へ」`);

    // フォーカスが見える（Tab で移ったボタンに枠が出る）
    await page.eval(`document.getElementById("g-h1").focus()`);
    await page.key("Tab");
    const fv = await page.eval(`(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, fv: e.matches(":focus-visible"), ow: parseFloat(cs.outlineWidth), os: cs.outlineStyle }; })()`);
    assert.ok(fv.tag === "BUTTON" && fv.fv && fv.os !== "none" && fv.ow >= 2, "Tab で移ったボタンにフォーカスの枠が見えません：" + JSON.stringify(fv));

    // 場面1：よくある形 ⇔ 直した形
    const s1 = await page.eval(`(() => {
      const out = [];
      for (const card of document.querySelectorAll(".g-card")) {
        const b = card.querySelector("[data-toggle]");
        const vis = () => Array.from(card.querySelectorAll(".g-ex")).filter(e => !e.hidden);
        const r = { ex: card.getAttribute("data-ex") };
        r.before = { tag: vis()[0].querySelector(".g-tag").textContent, marks: vis()[0].querySelectorAll("mark").length, btn: b.textContent };
        b.click();
        const v = vis();
        r.after = { n: v.length, tag: v[0].querySelector(".g-tag").textContent, marks: Array.from(v[0].querySelectorAll("mark")).map(m => m.textContent), btn: b.textContent, pressed: b.getAttribute("aria-pressed"),
          anim: getComputedStyle(v[0]).animationName, changed: v[0].classList.contains("g-changed"),
          tagColor: getComputedStyle(v[0].querySelector(".g-tag")).color };
        b.click();
        r.back = { tag: vis()[0].querySelector(".g-tag").textContent, btn: b.textContent, tagColor: getComputedStyle(vis()[0].querySelector(".g-tag")).color };
        out.push(r);
      }
      return out;
    })()`);
    assert.equal(s1.length, 3);
    for (const c of s1) {
      assert.deepEqual(c.before, { tag: "× よくある形", marks: 0, btn: "直した形を見る" }, c.ex);
      assert.equal(c.after.n, 1);
      assert.equal(c.after.tag, "○ 直した形");
      assert.ok(c.after.marks.length >= 1, `${c.ex}：直した形に mark がありません`);
      assert.equal(c.after.btn, "よくある形に戻す");
      assert.equal(c.after.pressed, "true");
      assert.equal(c.after.changed, true);
      assert.equal(c.after.anim, reduce ? "none" : "g-flash", `${c.ex}：動き ${c.after.anim}`);
      assert.notEqual(c.after.tagColor, c.back.tagColor, "○と×のラベルの色が同じです");
      assert.deepEqual([c.back.tag, c.back.btn], ["× よくある形", "直した形を見る"]);
    }
    assert.deepEqual(s1[0].after.marks, ["レポート課題の提出形式について（情報リテラシー 木曜2限）"]);
    ok(`${tag} 場面1：3枚とも「直した形を見る」で ○ 直した形と mark、「よくある形に戻す」で × に戻る、動き ${reduce ? "なし（reduced-motion）" : "あり"}`);

    // 場面2：箱の説明
    await page.eval(`location.hash = "#s2"`);
    await sleep(50);
    const s2 = await page.eval(`(() => {
      const shown = () => Array.from(document.querySelectorAll("#g-flow-detail [data-for]")).filter(e => !e.hidden).map(e => e.textContent);
      const out = { first: shown(), steps: {} };
      for (const n of ["2", "3", "4", "1"]) {
        document.querySelector('[data-step="' + n + '"]').click();
        out.steps[n] = { shown: shown(), pressed: Array.from(document.querySelectorAll("[data-step]")).filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.getAttribute("data-step")) };
      }
      const r = (n) => document.querySelector('[data-step="' + n + '"]').getBoundingClientRect();
      out.ratio = innerWidth < 600 ? r(3).height / r(2).height : r(3).width / r(2).width;
      out.label = document.querySelector('[data-step="3"] .g-weight').textContent;
      out.score = /点/.test(document.getElementById("g-flow-detail").textContent.replace("点数を見ながら", ""));
      return out;
    })()`);
    assert.deepEqual(s2.first, ["短い解説を読みます。"], "場面2の最初の説明");
    assert.deepEqual(s2.steps["2"], { shown: ["間違い探しや並べかえで、点数を見ながら確かめます。何度でも挑戦できます。"], pressed: ["2"] });
    assert.deepEqual(s2.steps["3"], { shown: ["メールや問題、レポートを自分で作ります（課題3では「書く」）。ここをいちばん重く見ます。"], pressed: ["3"] });
    assert.deepEqual(s2.steps["4"], { shown: ["提出ファイルを作り、WebClass に出します。"], pressed: ["4"] });
    assert.deepEqual(s2.steps["1"], { shown: ["短い解説を読みます。"], pressed: ["1"] });
    assert.equal(s2.label, "いちばん重く見ます");
    assert.ok(s2.ratio >= 1.4 && s2.ratio <= 1.8, `③の箱の大きさの比 ${s2.ratio.toFixed(2)}（約1.6倍のはず）`);
    assert.equal(s2.score, false, "場面2に点数が出ています");
    ok(`${tag} 場面2：最初は①、箱を押すとその説明だけが出る、③は約${s2.ratio.toFixed(2)}倍で「いちばん重く見ます」`);

    // 場面3：記録の見本
    await page.eval(`location.hash = "#s3"`);
    await sleep(50);
    const s3 = await page.eval(`(() => {
      const q = (s) => document.querySelector(s);
      const snap = () => ({
        device: q("#g-device-label").textContent,
        list: q("#g-record-list").hidden ? null : Array.from(q("#g-record-list").children).map(e => e.textContent),
        empty: !q("#g-record-empty").hidden,
        msg: q("#g-store-msg").hidden ? "" : q("#g-store-msg").textContent,
        restore: q('[data-store="restore"]').disabled
      });
      const press = (k) => { q('[data-store="' + k + '"]').click(); return snap(); };
      return { init: snap(), other: press("other"), restore1: press("restore"), reset: press("reset"), safari: press("safari"), restore2: press("restore"), reset2: press("reset") };
    })()`);
    const full = ["ゲームの記録 3回", "作ったもの 2件"];
    assert.deepEqual(s3.init, { device: "この端末", list: full, empty: false, msg: "", restore: true });
    assert.deepEqual(s3.other, { device: "別の端末", list: null, empty: true, msg: "別の端末のブラウザには、記録がありません。", restore: false });
    assert.deepEqual(s3.restore1, { device: "別の端末", list: full, empty: false, msg: "④提出の「保存したファイルから続ける」で読み込むと、続きからできます。", restore: true });
    assert.deepEqual(s3.reset, s3.init);
    assert.deepEqual(s3.safari, { device: "この端末", list: null, empty: true, msg: "Safari は、7日以上開かないサイトの記録を消すことがあります。", restore: false });
    assert.equal(s3.restore2.list.length, 2);
    assert.deepEqual(s3.reset2, s3.init);
    ok(`${tag} 場面3：別の端末・Safari で記録が空に、「提出ファイルを読み込むと」は空のときだけ押せて記録が戻る、最初の状態に戻せる`);

    // 場面4：箱の説明
    await page.eval(`location.hash = "#s4"`);
    await sleep(50);
    const s4 = await page.eval(`(() => {
      const shown = () => Array.from(document.querySelectorAll("#g-route-detail [data-for]")).filter(e => !e.hidden).map(e => e.textContent.trim());
      const out = { file: shown() };
      for (const k of ["webclass", "teacher", "file"]) { document.querySelector('[data-route="' + k + '"]').click(); out[k + "2"] = shown(); }
      out.persona = document.querySelector(".g-persona").textContent;
      out.mono = getComputedStyle(document.querySelector(".g-code")).fontFamily;
      return out;
    })()`);
    assert.equal(s4.file.length, 1);
    assert.ok(s4.file[0].includes(`"kadai": 1,`) && s4.file[0].includes(`"games": { … },`) && s4.file[0].includes(`"creative": { … }`) && s4.file[0].endsWith("名前や学籍番号は入っていません。"), "ファイルの説明：" + s4.file[0]);
    assert.ok(/monospace|Menlo|Consolas/.test(s4.mono), "見本が等幅ではありません");
    assert.deepEqual(s4.webclass2, ["WebClass は、誰が出したかを記録しています。"]);
    assert.deepEqual(s4.teacher2, ["1月12日（火）の授業で、みんなの結果をもとにフィードバックします。"]);
    assert.deepEqual(s4.file2, s4.file);
    assert.equal(s4.persona, "署名などで名前が要るときは、架空の人物を使います：工学部 1年 玉川 みらい（学籍番号 99Z9999）");
    ok(`${tag} 場面4：ファイル・WebClass・先生の箱を押すとその説明、架空の人物の枠`);

    // 場面6：「いま」の印
    await page.eval(`location.hash = "#s6"`);
    await sleep(50);
    const now = await page.eval(`(() => { const e = document.getElementById("g-now"); const r = e.getBoundingClientRect(), t = document.getElementById("g-timeline").getBoundingClientRect(); return { p: Number(e.getAttribute("data-percent")), text: e.textContent, accent: getComputedStyle(e).color === (() => { const x = document.createElement("span"); x.style.color = "var(--accent)"; document.body.appendChild(x); const c = getComputedStyle(x).color; x.remove(); return c; })(), inside: r.left >= t.left - 1 && r.right <= t.right + 1 }; })()`);
    assert.ok(now.p >= 0 && now.p <= 100 && /いま/.test(now.text) && now.inside && now.accent, "「いま」の印：" + JSON.stringify(now));
    ok(`${tag} 場面6：「いま」の印 ${now.p}%（時間軸の中に収まる、色は --accent）`);

    // 場面7：チェックリスト
    await page.eval(`location.hash = "#s7"`);
    await sleep(50);
    await page.eval(`(() => { localStorage.removeItem("mn2026.guide.todo"); })()`);
    await page.reload();
    const cb = (i) => `[data-todo="${i}"]`;
    assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll("[data-todo]")).map(c => c.checked)`), [false, false, false]);
    await click(cb(0));
    await click(cb(2));
    const marks = await page.eval(`Array.from(document.querySelectorAll(".g-todo .g-done")).map(e => !e.hidden && e.textContent)`);
    assert.deepEqual(marks, ["済み", false, "済み"]);
    await page.reload();
    const after = await page.eval(`({ checked: Array.from(document.querySelectorAll("[data-todo]")).map(c => c.checked), done: Array.from(document.querySelectorAll(".g-todo .g-done")).map(e => !e.hidden), v: localStorage.getItem("mn2026.guide.todo"), scene: document.getElementById("g-count").textContent })`);
    assert.deepEqual(after, { checked: [true, false, true], done: [true, false, true], v: "[true,false,true]", scene: "場面 7 / 7" });
    const links = await page.eval(`Array.from(document.querySelectorAll('[data-scene="7"] a.btn')).map(a => [a.textContent, a.getAttribute("href")])`);
    assert.deepEqual(links, [["課題1を始める", "../k1/"], ["トップに戻る", "../"]]);
    ok(`${tag} 場面7：チェックすると「済み」、再読み込み後も残る（mn2026.guide.todo）、課題1を始める・トップに戻る`);

    // 各場面：横スクロールなし、ボタン 44px 以上
    for (let n = 1; n <= 7; n++) {
      await page.eval(`location.hash = "#s${n}"`);
      await sleep(reduce ? 50 : 350);
      assert.deepEqual(await page.call(pageSmallTargets), [], `場面${n}（${tag}）：44px 未満のボタン`);
      await page.noHScroll(`guide ${tag} s${n}`);
      if (n === 1 || n === 3) {
        // 切り替えたあとの姿も撮る
        await page.eval(n === 1 ? `document.querySelectorAll("[data-toggle]").forEach(b => b.click())` : `document.querySelector('[data-store="other"]').click()`);
        await sleep(reduce ? 50 : 500);
        await page.noHScroll(`guide ${tag} s${n} after`);
        await page.eval(n === 1 ? `document.querySelectorAll("[data-toggle]").forEach(b => b.click())` : `document.querySelector('[data-store="reset"]').click()`);
      }
    }
    ok(`${tag}：7 場面とも横スクロールなし、ボタンは 44px 以上`);
  }

  for (const width of [1280, 375]) await runAll(width, false);
  await runAll(375, true);
  await page.reducedMotion(false);

  // #s4 で直接開ける
  await page.width(1280);
  await page.goto("/index.html");
  await page.goto(PAGE + "#s4");
  const d = await state();
  assert.deepEqual([d.visible, d.count], [[4], "場面 4 / 7"]);
  ok("#s4 で直接開くと場面4");

  // トップからガイドへのリンク
  await page.goto("/index.html");
  const card = await page.eval(`(() => { const a = document.querySelector('.kadai-list a[href="guide/"]'); return a && a.textContent.replace(/\\s+/g, " ").trim(); })()`);
  assert.equal(card, "はじめに：課題の進め方ガイド 進め方と出し方を、7つの場面で確かめます。");
  ok("トップに「はじめに：課題の進め方ガイド」のカード");

  // 記録への影響がない（トップは core.js が first_visit_at を読むだけ。値は入れてあるので変わらない）
  const end = await page.call(pageStorage);
  for (const [k, v] of Object.entries(before)) assert.equal(end[k], v, `${k} が変わりました`);
  const added = Object.keys(end).filter((k) => !(k in before));
  assert.ok(added.every((k) => k.startsWith("mn2026.guide.")), "mn2026.guide. 以外のキーが増えました：" + added);
  assert.deepEqual(added, ["mn2026.guide.todo"]);
  ok(`mn2026.k1.* などの見本 ${Object.keys(before).length} 個は変わらず、増えたキーは mn2026.guide.todo だけ`);

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
