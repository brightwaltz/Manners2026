// 採点の単体テスト：node --test tests/scoring.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const S = require("../assets/js/scoring.js");
const demo = JSON.parse(readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"));

const findItem = {
  id: "fx",
  header: [{ label: "件名", t: "質問", err: "e1" }],
  chunks: [
    { t: "山田先生" },          // c0
    { t: "\n" },                // c1
    { t: "急いで", err: "e2" }, // c2
    { t: "ください。", err: "e2" }, // c3（同じ err）
    { t: "以上" }               // c4
  ],
  errors: [{ id: "e1" }, { id: "e2" }],
  missing_options: [{ id: "m_a" }, { id: "m_b" }, { id: "m_c" }],
  missing_answer: ["m_a"]
};

test("find：全部正解で満点", () => {
  const r = S.scoreFind(findItem, { picked: ["h0", "c2"], missing: ["m_a"] });
  assert.equal(r.max, 30);
  assert.equal(r.score, 30);
  assert.deepEqual(r.missed, []);
});

test("find：何も選ばなければ 0 点", () => {
  const r = S.scoreFind(findItem, { picked: [], missing: [] });
  assert.equal(r.score, 0);
  assert.deepEqual(r.missed.sort(), ["e1", "e2"]);
  assert.deepEqual(r.missingMissed, ["m_a"]);
});

test("find：全部不正解でも 0 未満にならない", () => {
  const r = S.scoreFind(findItem, { picked: ["c0", "c1", "c4"], missing: ["m_b", "m_c"] });
  assert.equal(r.score, 0);
  assert.equal(r.wrongPicks.length, 3);
});

test("find：余計なタップは −5", () => {
  const r = S.scoreFind(findItem, { picked: ["h0", "c2", "c0"], missing: ["m_a", "m_b"] });
  assert.equal(r.score, 30 - 5 - 5);
});

test("find：同じ err の複数のかたまりは 1 回だけ加点し、減点もしない", () => {
  const both = S.scoreFind(findItem, { picked: ["c2", "c3"], missing: [] });
  assert.equal(both.score, 10);
  const one = S.scoreFind(findItem, { picked: ["c3"], missing: [] });
  assert.equal(one.score, 10);
  assert.deepEqual(one.found, ["e2"]);
});

test("find：同じ位置の重複は 1 回として数える", () => {
  const r = S.scoreFind(findItem, { picked: ["c0", "c0", "h0"], missing: ["m_a", "m_a"] });
  assert.equal(r.score, 10 - 5 + 10);
});

test("find：存在しない位置は誤りとして減点", () => {
  const r = S.scoreFind(findItem, { picked: ["h0", "c99"], missing: [] });
  assert.equal(r.score, 5);
});

test("find：note のかたまりは採点で扱わない（タップしても加点も減点もない）", () => {
  const item = {
    id: "fn",
    chunks: [{ t: "場面：授業のあと", note: true }, { t: "急いで", err: "e1" }, { t: "以上" }],
    errors: [{ id: "e1" }],
    missing_options: [{ id: "m_a" }],
    missing_answer: []
  };
  assert.equal(S.findChunkMap(item).c0, undefined);
  assert.equal(S.scoreFind(item, { picked: ["c0", "c1"], missing: [] }).score, 10);
  assert.deepEqual(S.scoreFind(item, { picked: ["c0"], missing: [] }).wrongPicks, []);
});

test("find：missing_answer が空なら、チェックなしで満点、チェックすると −5", () => {
  const item = {
    id: "fe",
    chunks: [{ t: "a", err: "e1" }, { t: "b", err: "e2" }, { t: "c" }],
    errors: [{ id: "e1" }, { id: "e2" }],
    missing_options: [{ id: "m_a" }, { id: "m_b" }],
    missing_answer: []
  };
  const full = S.scoreFind(item, { picked: ["c0", "c1"], missing: [] });
  assert.equal(full.max, 20);
  assert.equal(full.score, 20);
  assert.equal(S.scoreFind(item, { picked: ["c0", "c1"], missing: ["m_a"] }).score, 15);
  assert.equal(S.scoreFind(item, { picked: ["c0", "c1"], missing: ["m_a", "m_b"] }).score, 10);
  assert.equal(S.scoreFind(item, { picked: [], missing: ["m_a"] }).score, 0);
});

test("choice：正解 10、不正解 0、未回答 0", () => {
  const item = { id: "c", options: [{ id: "a" }, { id: "b" }], answer: "b" };
  assert.equal(S.scoreChoice(item, "b").score, 10);
  assert.equal(S.scoreChoice(item, "a").score, 0);
  assert.equal(S.scoreChoice(item, undefined).score, 0);
});

test("order：全部正しい・全部違う・部分正解の四捨五入", () => {
  const item = { answer: ["p1", "p2", "p3", "p4"] };
  assert.equal(S.scoreOrder(item, ["p1", "p2", "p3", "p4"]).score, 10);
  assert.equal(S.scoreOrder(item, ["p4", "p3", "p2", "p1"]).score, 0);
  assert.equal(S.scoreOrder(item, ["p1", "p3", "p2", "p4"]).score, 5);
  const three = { answer: ["a", "b", "c"] };
  assert.equal(S.scoreOrder(three, ["a", "c", "b"]).score, 3); // 3.33 → 3
  assert.equal(S.scoreOrder(three, ["a", "b", "x"]).score, 7); // 6.67 → 7
  const eight = { answer: ["1", "2", "3", "4", "5", "6", "7", "8"] };
  assert.equal(S.scoreOrder(eight, ["1", "2", "3", "5", "4", "7", "6", "8"]).score, 5); // 5.0
  const five = { answer: ["a", "b", "c", "d", "e"] };
  assert.equal(S.scoreOrder(five, ["a", "c", "b", "e", "d"]).score, 2);
  assert.equal(S.scoreOrder(item, null).score, 0);
});

test("choiceOrder：fixed_order のゲームではデータの順のまま", () => {
  const item = { id: "q1", options: [{ id: "ok" }, { id: "ng" }, { id: "cond" }], answer: "cond" };
  assert.deepEqual(S.choiceOrder(item, { fixed_order: true }).map((o) => o.id), ["ok", "ng", "cond"]);
  assert.equal(S.scoreChoice(item, "cond").score, 10);
});

test("orderInitial：最初の並びが正解の順と同じにならない", () => {
  const item = { pieces: [{ id: "p1" }, { id: "p2" }, { id: "p3" }], answer: ["p1", "p2", "p3"] };
  // 乱数が常に 0.999… のとき、シャッフル結果は元の順（＝正解）になる → 並べ直される
  const stay = S.orderInitial(item, () => 0.9999);
  assert.notDeepEqual(stay, item.answer);
  assert.deepEqual([...stay].sort(), ["p1", "p2", "p3"]);
  for (let i = 0; i < 200; i++) assert.notDeepEqual(S.orderInitial(item), item.answer);
  const two = { pieces: [{ id: "b" }, { id: "a" }], answer: ["a", "b"] };
  for (let i = 0; i < 50; i++) assert.deepEqual(S.orderInitial(two), ["b", "a"]);
  assert.deepEqual(S.orderInitial({ pieces: [{ id: "x" }], answer: ["x"] }), ["x"]);
});

test("find：header と missing_options が空配列でも採点できる", () => {
  const item = { id: "fh", header: [], chunks: [{ t: "a", err: "e1" }, { t: "b" }], errors: [{ id: "e1" }], missing_options: [], missing_answer: [] };
  const r = S.scoreFind(item, { picked: ["c0"], missing: [] });
  assert.equal(r.max, 10);
  assert.equal(r.score, 10);
});

test("choiceOrder：毎回同じ順", () => {
  const item = demo.games.find((g) => g.type === "choice").items[0];
  const a = S.choiceOrder(item).map((o) => o.id);
  const b = S.choiceOrder(item).map((o) => o.id);
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), item.options.map((o) => o.id).sort());
});

test("choiceOrder：正解の位置が問題ごとにばらける（いつも 1 番目にならない）", () => {
  const positions = [];
  for (let i = 0; i < 40; i++) {
    const item = {
      id: "q" + i,
      options: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      answer: "a"
    };
    positions.push(S.choiceOrder(item).findIndex((o) => o.id === "a"));
  }
  const counts = [0, 1, 2, 3].map((p) => positions.filter((x) => x === p).length);
  assert.ok(counts[0] < 40, "正解がいつも 1 番目");
  assert.ok(counts.filter((c) => c > 0).length >= 3, "正解の位置が 3 か所以上に散らない: " + counts);
  // デモの問題でも、正解が全部 1 番目ではない
  const demoChoice = demo.games.find((g) => g.type === "choice").items;
  const firsts = demoChoice.filter((it) => S.choiceOrder(it)[0].id === it.answer).length;
  assert.ok(firsts < demoChoice.length);
});

test("scoreGame：合計と満点", () => {
  const g = demo.games.find((x) => x.type === "find");
  const full = {};
  for (const it of g.items) {
    const map = S.findChunkMap(it);
    const picked = [];
    for (const e of it.errors) picked.push(Object.keys(map).find((k) => map[k] === e.id));
    full[it.id] = { picked, missing: it.missing_answer };
  }
  const r = S.scoreGame(g, full);
  assert.equal(r.score, r.max);
  assert.equal(S.scoreGame(g, {}).score, 0);
  assert.equal(S.scoreGame(g, {}).max, r.max);
});

test("rank", () => {
  assert.equal(S.rank(90, 100), "S");
  assert.equal(S.rank(89, 100), "A");
  assert.equal(S.rank(75, 100), "A");
  assert.equal(S.rank(50, 100), "B");
  assert.equal(S.rank(49, 100), "C");
  assert.equal(S.rank(0, 0), "C");
});

test("findPersonalInfo：学籍番号らしい数字とメールアドレスを見つける", () => {
  assert.equal(S.findPersonalInfo("工学部 1年 玉川 みらい（学籍番号 99Z9999）").length, 0);
  assert.equal(S.findPersonalInfo("宛先 yamada@example.ac.jp").length, 0);
  assert.equal(S.findPersonalInfo("2026年12月31日 23:59").length, 0);
  const h = S.findPersonalInfo("学籍番号 24A1234 です。taro@stu.example-univ.jp まで");
  assert.deepEqual(h.map((x) => x.kind).sort(), ["メールアドレス", "学籍番号らしい数字"]);
  assert.equal(S.findPersonalInfo("番号は２４Ａ１２３４").length, 1); // 全角
  assert.equal(S.findPersonalInfo("1234567").length, 1);
});

function goodSubmission() {
  return {
    schema: "manners2026-submit/1",
    kadai: 1,
    data_version: "2026-10-27",
    app_version: "2026-10-27",
    first_visit_at: "2026-10-27T10:00:00+09:00",
    exported_at: "2026-10-27T11:00:00+09:00",
    consent_showcase: true,
    ai_use: { used: false, detail: "" },
    games: { find: { attempts: [{ t0: "2026-10-27T10:01:00+09:00", t1: "2026-10-27T10:05:00+09:00", answers: {}, score: 0, max: 50 }] } },
    creative: { mail: { subject: "a", body: "b" } }
  };
}

test("validateSubmission：正しい形は合格", () => {
  const r = S.validateSubmission(goodSubmission());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test("validateSubmission：未知のキーは不合格", () => {
  for (const mutate of [
    (s) => { s.student_id = "x"; },
    (s) => { s.ai_use.tool = "x"; },
    (s) => { s.games.find.user = "x"; },
    (s) => { s.games.find.attempts[0].ua = "x"; },
    (s) => { s.creative.mail.n = 1; },
    (s) => { delete s.consent_showcase; },
    (s) => { s.exported_at = "昨日"; }
  ]) {
    const s = goodSubmission();
    mutate(s);
    assert.equal(S.validateSubmission(s).ok, false);
  }
});
