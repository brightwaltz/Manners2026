// 保存したファイルから続ける（MN.restore）の単体テスト：node --test tests/restore.test.mjs
// core.js を vm の中で読み、localStorage はメモリの代わりを使う。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const S = require(join(ROOT, "assets/js/scoring.js"));
const CORE = readFileSync(join(ROOT, "assets/js/core.js"), "utf8");

// vm の中のオブジェクトは別のレルムなので、JSON で揃えてから比べる
const plain = (x) => JSON.parse(JSON.stringify(x));

function memoryStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
}

function load(confirmAnswer = true) {
  const ctx = vm.createContext({ MNScoring: S, localStorage: memoryStorage(), asked: [] });
  ctx.window = ctx;
  ctx.confirm = (q) => { ctx.asked.push(q); return confirmAnswer; };
  vm.runInContext(CORE, ctx);
  ctx.MN.data = { 1: { games: [{ id: "find" }, { id: "choice" }] } };
  return ctx;
}

function at(min, score = 10) {
  const t0 = `2026-11-01T10:${String(min).padStart(2, "0")}:00+09:00`;
  const t1 = `2026-11-01T10:${String(min).padStart(2, "0")}:30+09:00`;
  return { t0, t1, answers: { q1: "a" }, score, max: 20 };
}

function file(over = {}) {
  return {
    schema: S.SCHEMA, kadai: 1, data_version: "v1", app_version: "2026-10-27",
    first_visit_at: "2026-10-30T09:00:00+09:00", exported_at: "2026-11-02T09:00:00+09:00",
    consent_showcase: true, ai_use: { used: false, detail: "" },
    games: { find: { attempts: [at(5), at(1)] }, choice: { attempts: [] } },
    creative: { mail: { subject: "件名", body: "本文" } },
    ...over
  };
}

test("記録が空の端末：ゲームの記録・作る・同意・生成AI・最初の日時が戻る", () => {
  const c = load();
  const r = c.MN.restore.fromText(1, JSON.stringify(file()));
  assert.equal(r.ok, true);
  assert.equal(r.message, "読み込みました：ゲームの記録 2 回、作る 1 件。");
  assert.deepEqual(plain(c.MN.attempts.list(1, "find")).map((a) => a.t0), [at(1).t0, at(5).t0], "t0 の順");
  assert.deepEqual(plain(c.MN.creative.get(1, "mail")), { subject: "件名", body: "本文" });
  assert.deepEqual(plain(c.MN.store.get("k1.submit")), { consent: true, ai_used: false, ai_detail: "" });
  assert.equal(c.MN.store.get("first_visit_at"), "2026-10-30T09:00:00+09:00");
  assert.deepEqual(plain(c.asked), []);
});

test("合わせ方：同じ挑戦（t0・t1・score が同じ）は重複させず、t0 の順に並ぶ", () => {
  const c = load();
  c.MN.attempts.add(1, "find", at(3));
  c.MN.attempts.add(1, "find", at(5));
  c.MN.restore.fromText(1, JSON.stringify(file()));
  c.MN.restore.fromText(1, JSON.stringify(file())); // 2 回読んでも増えない
  const l = plain(c.MN.attempts.list(1, "find"));
  assert.deepEqual(l.map((a) => a.t0), [at(1).t0, at(3).t0, at(5).t0]);
  // t0・t1 が同じでも score が違えば別の挑戦
  c.MN.restore.fromText(1, JSON.stringify(file({ games: { find: { attempts: [at(3, 0)] } } })));
  assert.equal(c.MN.attempts.list(1, "find").length, 4);
});

test("30 回の上限：最初の挑戦は必ず残り、残りは新しい順に 29 回", () => {
  const c = load();
  for (let i = 10; i < 40; i++) c.MN.attempts.add(1, "find", at(i));
  const incoming = [at(0)];
  for (let i = 40; i < 50; i++) incoming.push(at(i));
  c.MN.restore.fromText(1, JSON.stringify(file({ games: { find: { attempts: incoming } } })));
  const l = plain(c.MN.attempts.list(1, "find"));
  assert.equal(l.length, 30);
  assert.equal(l[0].t0, at(0).t0, "最初の挑戦（ファイル側でいちばん早いもの）が残る");
  assert.equal(l[1].t0, at(21).t0);
  assert.equal(l[29].t0, at(49).t0);
  // mergeAttempts 単体でも同じ
  const m = plain(c.MN.restore.mergeAttempts(Array.from({ length: 40 }, (_, i) => at(i + 10)), []));
  assert.equal(m.length, 30);
  assert.deepEqual([m[0].t0, m[1].t0, m[29].t0], [at(10).t0, at(21).t0, at(49).t0]);
});

test("data にないゲーム id は捨てる", () => {
  const c = load();
  const r = c.MN.restore.fromText(1, JSON.stringify(file({ games: { find: { attempts: [at(1)] }, ghost: { attempts: [at(2)] } } })));
  assert.equal(r.games, 1);
  assert.equal(c.MN.attempts.list(1, "ghost").length, 0);
  assert.ok(!c.MN.store.keys().includes("k1.game.ghost"));
});

test("別の課題のファイル：案内を出し、何も書きかえない", () => {
  const c = load();
  const r = c.MN.restore.fromText(1, JSON.stringify(file({ kadai: 2 })));
  assert.deepEqual(plain(r), { ok: false, message: "これは課題2のファイルです。課題2のページで読み込んでください。" });
  assert.deepEqual(plain(c.MN.store.keys()), []);
});

test("壊れた JSON・空・validateSubmission 不合格は同じ案内", () => {
  const c = load();
  const bad = "ファイルの形が読み取れませんでした。サイトが作った提出ファイルを選んでください。";
  for (const t of ["{ \"schema\": ", "", "   ", "null", "[]", "こんにちは"]) {
    assert.deepEqual(plain(c.MN.restore.fromText(1, t)), { ok: false, message: bad }, JSON.stringify(t));
  }
  const notValid = [
    { ...file(), student: "x" },
    { ...file(), schema: "other/1" },
    file({ games: { find: { attempts: [{ ...at(1), score: -1 }] } } }),
    file({ creative: { mail: { subject: 3 } } })
  ];
  for (const f of notValid) {
    assert.equal(S.validateSubmission(f).ok, false);
    assert.deepEqual(plain(c.MN.restore.fromText(1, JSON.stringify(f))), { ok: false, message: bad });
  }
  assert.deepEqual(plain(c.MN.store.keys()), []);
});

test("BOM 付き・前後の空白・2 スペース整形のファイルも読める", () => {
  const c = load();
  const r = c.MN.restore.fromText(1, "﻿\n  " + JSON.stringify(file(), null, 2) + "\n\n");
  assert.equal(r.ok, true);
  assert.equal(c.MN.attempts.list(1, "find").length, 2);
});

test("作る：今も書いてあってファイルと違えば聞く。キャンセルなら今の入力を残す", () => {
  const c = load(false);
  c.MN.creative.set(1, "mail", { subject: "いまの件名", body: "いまの本文" });
  const r = c.MN.restore.fromText(1, JSON.stringify(file()));
  assert.equal(c.asked.length, 1);
  assert.match(c.asked[0], /^いまの入力をファイルの内容で置き換えますか？/);
  assert.equal(r.creative, 0);
  assert.equal(r.games, 2, "ゲームの記録は読み込む");
  assert.deepEqual(plain(c.MN.creative.get(1, "mail")), { subject: "いまの件名", body: "いまの本文" });

  const c2 = load(true);
  c2.MN.creative.set(1, "mail", { subject: "いまの件名", body: "いまの本文" });
  assert.equal(c2.MN.restore.fromText(1, JSON.stringify(file())).creative, 1);
  assert.deepEqual(plain(c2.MN.creative.get(1, "mail")), { subject: "件名", body: "本文" });

  // 同じ内容なら聞かない。ファイルのほうが空なら今の入力に触らない
  const c3 = load(false);
  c3.MN.creative.set(1, "mail", { subject: "件名", body: "本文" });
  c3.MN.creative.set(1, "ng", { body: "書いた" });
  c3.MN.restore.fromText(1, JSON.stringify(file({ creative: { mail: { subject: "件名", body: "本文" }, ng: { body: "" } } })));
  assert.deepEqual(plain(c3.asked), []);
  assert.deepEqual(plain(c3.MN.creative.get(1, "ng")), { body: "書いた" });
});

test("同意・生成AI は今が未選択のときだけ、最初の日時は早いほう", () => {
  const c = load();
  c.MN.store.set("k1.submit", { consent: false });
  c.MN.store.set("first_visit_at", "2026-10-01T09:00:00+09:00");
  c.MN.restore.fromText(1, JSON.stringify(file({ ai_use: { used: true, detail: "本文の言い回し" } })));
  assert.deepEqual(plain(c.MN.store.get("k1.submit")), { consent: false, ai_used: true, ai_detail: "本文の言い回し" });
  assert.equal(c.MN.store.get("first_visit_at"), "2026-10-01T09:00:00+09:00");
});
