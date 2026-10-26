// サイトの検査：node tools/check.mjs [提出ファイル.txt ...]
// 失敗が 1 つでもあれば終了コード 1。
// 引数に提出ファイルを渡すと、その形も validateSubmission で確かめる。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const S = require(join(ROOT, "assets/js/scoring.js"));

const failures = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);
const rel = (p) => relative(ROOT, p);

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.includes(extname(p))) out.push(p);
  }
  return out;
}

// 公開するファイルだけを対象にする（tools/ と tests/ は公開物ではない）
const SITE_DIRS = ["assets", "data", "demo", "k1", "k2", "k3"];
const htmlFiles = [join(ROOT, "index.html"), ...SITE_DIRS.flatMap((d) => walk(join(ROOT, d), [".html"]))].filter(existsSync);
const cssFiles = SITE_DIRS.flatMap((d) => walk(join(ROOT, d), [".css"]));
const jsFiles = SITE_DIRS.flatMap((d) => walk(join(ROOT, d), [".js", ".mjs"]));
const jsonFiles = walk(join(ROOT, "data"), [".json"]);

/* ---------- 1. 外部リソースの読み込み ---------- */

const EXT = String.raw`(?:https?:)?//`;
const externalPatterns = [
  [new RegExp(String.raw`<script\b[^>]*\bsrc\s*=\s*["']?\s*${EXT}`, "i"), "外部の script src"],
  [new RegExp(String.raw`<link\b[^>]*\bhref\s*=\s*["']?\s*${EXT}`, "i"), "外部の link href（stylesheet・preload・icon など）"],
  [new RegExp(String.raw`<(?:img|iframe|source|video|audio|embed|object)\b[^>]*\b(?:src|srcset|data)\s*=\s*["']?\s*${EXT}`, "i"), "外部の画像・埋め込み"],
  [new RegExp(String.raw`@import\s+(?:url\()?\s*["']?\s*${EXT}`, "i"), "外部の @import"],
  [new RegExp(String.raw`url\(\s*["']?\s*${EXT}`, "i"), "外部の url()"],
  [new RegExp(String.raw`fetch\(\s*[\`"']\s*${EXT}`, "i"), "外部への fetch"],
  [/\bnew\s+(?:WebSocket|EventSource)\s*\(/, "WebSocket / EventSource"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\.src\s*=\s*["'`]\s*(?:https?:)?\/\//i, "外部の src を JS で設定"],
  [/\bimport\s*\(\s*["'`]\s*(?:https?:)?\/\//i, "外部の import()"]
];
for (const f of [...htmlFiles, ...cssFiles, ...jsFiles]) {
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const [re, what] of externalPatterns) {
      if (re.test(line)) fail(rel(f), `${i + 1} 行目：${what}`);
    }
  });
}

/* ---------- 2. 文字の大きさ（14px 未満がない） ---------- */

const KEYWORD_PX = { "xx-small": 9, "x-small": 10, small: 13, smaller: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32, larger: 19 };
function fontSizeToPx(v) {
  v = v.trim().replace(/\s*!important$/, "").toLowerCase();
  if (v in KEYWORD_PX) return KEYWORD_PX[v];
  if (/^(inherit|initial|unset|revert|var\(.*\))$/.test(v)) return null;
  let m = /^(-?[\d.]+)(px|rem|em|pt|%)$/.exec(v);
  if (m) {
    const n = parseFloat(m[1]);
    return { px: n, rem: n * 16, em: n * 16, pt: (n * 4) / 3, "%": (n / 100) * 16 }[m[2]];
  }
  return NaN; // clamp() や calc() などは判定できないので不合格にする
}
function checkFontSizes(file, text, re) {
  let m;
  while ((m = re.exec(text))) {
    const px = fontSizeToPx(m[1]);
    const line = text.slice(0, m.index).split("\n").length;
    if (px === null) continue;
    if (Number.isNaN(px)) fail(rel(file), `${line} 行目：font-size を判定できません（${m[1].trim()}）。px で書いてください`);
    else if (px < 14 - 1e-9) fail(rel(file), `${line} 行目：font-size ${m[1].trim()}（${px.toFixed(1)}px）は 14px 未満です`);
  }
}
for (const f of cssFiles) {
  const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  checkFontSizes(f, text, /font-size\s*:\s*([^;}]+)/gi);
  // font: の一括指定
  let m;
  const re = /(?:^|[;{\s])font\s*:\s*([^;}]+)/gi;
  while ((m = re.exec(text))) {
    const sz = /(?:^|\s)([\d.]+(?:px|rem|em|pt|%))(?:\/|\s)/.exec(" " + m[1] + " ");
    if (sz) checkFontSizes(f, `font-size:${sz[1]};`, /font-size\s*:\s*([^;}]+)/gi);
  }
}
for (const f of htmlFiles) {
  const text = readFileSync(f, "utf8");
  checkFontSizes(f, text, /font-size\s*:\s*([^;"'}]+)/gi);
}
for (const f of jsFiles) {
  const text = readFileSync(f, "utf8");
  checkFontSizes(f, text, /fontSize\s*=\s*["'`]([^"'`]+)["'`]/g);
  checkFontSizes(f, text, /font-size\s*:\s*([^;"'`}]+)/gi);
}

/* ---------- 3. 入力欄に個人情報を求める語がない ---------- */

const FORBIDDEN = /名前|氏名|学籍番号|メールアドレス|name|e-?mail/i;
const stripTags = (s) => s.replace(/<[^>]*>/g, "");
for (const f of htmlFiles) {
  const text = readFileSync(f, "utf8");
  // input / textarea / select の属性（name・id・placeholder・aria-label・title・autocomplete）
  const tagRe = /<(input|textarea|select)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(text))) {
    const attrRe = /\b(name|id|placeholder|aria-label|title|autocomplete)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/gi;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      const val = a[3] ?? a[4] ?? a[5] ?? "";
      if (FORBIDDEN.test(val)) fail(rel(f), `<${m[1]}> の ${a[1]}="${val}" に個人情報を求める語があります`);
    }
  }
  // <label> の文字
  const labelRe = /<label\b[^>]*>([\s\S]*?)<\/label>/gi;
  while ((m = labelRe.exec(text))) {
    const t = stripTags(m[1]);
    if (FORBIDDEN.test(t)) fail(rel(f), `ラベル「${t.trim()}」に個人情報を求める語があります`);
  }
  // フォーム定義（作るの fields）の label・placeholder・id
  checkFieldDefs(f, text);
}
for (const f of jsFiles) checkFieldDefs(f, readFileSync(f, "utf8"));
function checkFieldDefs(f, text) {
  // fields: [ ... ] の中の label / placeholder / hint / id の文字列
  const fieldsRe = /fields\s*:\s*\[([\s\S]*?)\]\s*,?\s*(?:checks|\})/g;
  let m;
  while ((m = fieldsRe.exec(text))) {
    const propRe = /\b(label|placeholder|id)\s*:\s*(["'`])((?:\\.|(?!\2).)*)\2/g;
    let p;
    while ((p = propRe.exec(m[1]))) {
      if (FORBIDDEN.test(p[3])) fail(rel(f), `作るの欄の ${p[1]}「${p[3]}」に個人情報を求める語があります`);
    }
  }
  // JS で placeholder / name 属性を設定している箇所
  const setRe = /(?:placeholder|\bname)\s*[:=]\s*["'`]([^"'`]*)["'`]/g;
  while ((m = setRe.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/PERSONA|<meta/.test(before)) continue; // 架空の人物の定義、meta name="viewport" は除く
    if (/^name\s*[:=]/.test(m[0]) && /^(viewport)$/.test(m[1])) continue;
    if (FORBIDDEN.test(m[1])) fail(rel(f), `${m[0]} に個人情報を求める語があります`);
  }
}

/* ---------- 4. 問題データ ---------- */

function checkData(file) {
  let d;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(rel(file), "JSON として読めません：" + e.message);
    return;
  }
  const F = rel(file);
  if (!Number.isInteger(d.kadai)) fail(F, "kadai が整数ではありません");
  if (typeof d.version !== "string" || !d.version) fail(F, "version がありません");
  if (!Array.isArray(d.games)) { fail(F, "games が配列ではありません"); return; }
  const uniqueIds = (arr, where) => {
    const seen = new Set();
    for (const x of arr) {
      if (typeof x?.id !== "string" || !x.id) fail(F, `${where}：id がありません`);
      else if (seen.has(x.id)) fail(F, `${where}：id「${x.id}」が重複しています`);
      else seen.add(x.id);
    }
    return seen;
  };
  // learn（任意）：h は必須の文字列、p・ul・after・ex は文字列の配列、links は { t, href } で href は https、
  // num は false だけ（番号を付けないカード）
  if (d.learn !== undefined) {
    const isStrArr = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");
    if (!Array.isArray(d.learn)) fail(F, "learn が配列ではありません");
    else d.learn.forEach((sec, i) => {
      const L = `learn[${i}]`;
      if (!sec || typeof sec !== "object" || Array.isArray(sec)) { fail(F, `${L} が object ではありません`); return; }
      for (const k of Object.keys(sec)) if (!["h", "p", "ul", "after", "ex", "links", "num"].includes(k)) fail(F, `${L}：未知のキー「${k}」`);
      if (typeof sec.h !== "string" || !sec.h.trim()) fail(F, `${L}：h（見出し）は必須の文字列です`);
      if (sec.num !== undefined && sec.num !== false) fail(F, `${L}：num は false だけ使えます（番号を付けないカード）`);
      for (const k of ["p", "ul", "after", "ex"]) if (sec[k] !== undefined && !isStrArr(sec[k])) fail(F, `${L}：${k} は文字列の配列にしてください`);
      if (sec.links !== undefined) {
        if (!Array.isArray(sec.links)) fail(F, `${L}：links は配列にしてください`);
        else sec.links.forEach((l, j) => {
          if (!l || typeof l.t !== "string" || !l.t.trim()) fail(F, `${L}.links[${j}]：t（表示名）は必須の文字列です`);
          let ok = false;
          try { ok = new URL(l?.href).protocol === "https:"; } catch {}
          if (!ok) fail(F, `${L}.links[${j}]：href は https:// で始まる URL にしてください（${l?.href}）`);
        });
      }
    });
  }
  uniqueIds(d.games, "games");
  uniqueIds(d.games.flatMap((g) => g.items || []), "問題（ファイル全体）");
  for (const g of d.games) {
    const G = `game「${g.id}」`;
    // 正解の表示位置がばらける（fixed_order のゲームは対象外）。3 問以上で全部同じ位置なら不合格
    if (g.type === "choice" && !g.fixed_order && Array.isArray(g.items) && g.items.length >= 3) {
      const pos = g.items.map((it) => S.choiceOrder(it, g).findIndex((o) => o.id === it.answer));
      if (pos.every((p) => p === pos[0])) fail(F, `${G}：正解の表示位置が全問 ${pos[0] + 1} 番目です。選択肢の id か問題の id を変えてください`);
    }
    if (!["find", "choice", "order"].includes(g.type)) fail(F, `${G}：type「${g.type}」は使えません`);
    if (!Array.isArray(g.items)) { fail(F, `${G}：items が配列ではありません`); continue; }
    for (const it of g.items) {
      const I = `${G} 問題「${it.id}」`;
      if (g.type === "choice") {
        const opts = it.options || [];
        if (opts.length < 2) fail(F, `${I}：選択肢が 2 つ未満です`);
        const ids = uniqueIds(opts, `${I} の選択肢`);
        if (typeof it.answer !== "string" || !ids.has(it.answer)) fail(F, `${I}：answer「${it.answer}」が選択肢にありません`);
        for (const k of Object.keys(it.option_explain || {})) if (!ids.has(k)) fail(F, `${I}：option_explain の「${k}」が選択肢にありません`);
        if (!it.prompt) fail(F, `${I}：prompt がありません`);
      } else if (g.type === "order") {
        const ids = uniqueIds(it.pieces || [], `${I} の部品`);
        const ans = it.answer || [];
        const ok = Array.isArray(ans) && ans.length === ids.size && new Set(ans).size === ans.length && ans.every((a) => ids.has(a));
        if (!ok) fail(F, `${I}：answer が部品 id の並べ替えになっていません`);
        if (ids.size < 2) fail(F, `${I}：部品が 2 つ未満です`);
      } else if (g.type === "find") {
        const errIds = uniqueIds(it.errors || [], `${I} の errors`);
        const used = new Set();
        const allChunks = [...(it.header || []).map((h, i) => ["h" + i, h]), ...(it.chunks || []).map((c, i) => ["c" + i, c])];
        for (const [pos, c] of allChunks) {
          if (typeof c.t !== "string") fail(F, `${I}：${pos} に t がありません`);
          if (c.err !== undefined) {
            if (c.note) fail(F, `${I}：${pos} は note なのに err があります`);
            else if (c.t === "\n" || !String(c.t).trim()) fail(F, `${I}：${pos} は空白・改行なのに err があります`);
            if (!errIds.has(c.err)) fail(F, `${I}：${pos} の err「${c.err}」が errors にありません`);
            used.add(c.err);
          }
        }
        for (const id of errIds) if (!used.has(id)) fail(F, `${I}：errors の「${id}」がどのかたまりにも使われていません`);
        const mIds = uniqueIds(it.missing_options || [], `${I} の missing_options`);
        if (!Array.isArray(it.missing_answer)) fail(F, `${I}：missing_answer が配列ではありません`);
        else for (const m of it.missing_answer) if (!mIds.has(m)) fail(F, `${I}：missing_answer の「${m}」が missing_options にありません`);
        if (!(it.errors || []).length && !(it.missing_answer || []).length) fail(F, `${I}：誤りも足りないものも無く、満点が 0 です`);
      }
    }
  }
}
jsonFiles.forEach(checkData);
if (!jsonFiles.length) fail("data/", "問題データがありません");

/* ---------- 5. 提出ファイルの形の検査（自己点検と、引数のファイル） ---------- */

const sample = {
  schema: S.SCHEMA, kadai: 1, data_version: "2026-10-27", app_version: "2026-10-27",
  first_visit_at: "2026-10-27T10:00:00+09:00", exported_at: "2026-10-27T11:00:00+09:00",
  consent_showcase: false, ai_use: { used: false, detail: "" },
  games: { find: { attempts: [] } }, creative: { mail: { subject: "" } }
};
if (!S.validateSubmission(sample).ok) fail("scoring.js", "validateSubmission が正しい形を不合格にしました");
if (S.validateSubmission({ ...sample, student: "x" }).ok) fail("scoring.js", "validateSubmission が未知のキーを合格にしました");
for (const arg of process.argv.slice(2)) {
  try {
    const r = S.validateSubmission(JSON.parse(readFileSync(arg, "utf8")));
    if (!r.ok) r.errors.forEach((e) => fail(arg, e));
    else console.log(`提出ファイル ${arg}：形は合格`);
  } catch (e) {
    fail(arg, "読めません：" + e.message);
  }
}

/* ---------- 結果 ---------- */

console.log(`検査したファイル：HTML ${htmlFiles.length}、CSS ${cssFiles.length}、JS ${jsFiles.length}、データ ${jsonFiles.length}`);
if (failures.length) {
  console.log(`不合格 ${failures.length} 件`);
  failures.forEach((f) => console.log("  × " + f));
  process.exit(1);
}
console.log("合格");
