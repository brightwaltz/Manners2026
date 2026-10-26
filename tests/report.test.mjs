// 課題3 ライブ点検の単体テスト：node --test tests/report.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../k3/report.js");

test("字数：空白・改行（全角の空白も）は数えない", () => {
  assert.equal(R.countChars("あい う\nえ　お\t"), 5);
  assert.equal(R.countChars(""), 0);
  assert.equal(R.countChars(null), 0);
});

test("最初の文：最初の「。」まで、無ければ段落全体", () => {
  assert.equal(R.firstSentence("  一文目である。二文目である。"), "一文目である。");
  assert.equal(R.firstSentence("句点のない段落"), "句点のない段落");
  assert.equal(R.firstSentence(""), "");
});

test("トピック・センテンス一覧：空の段落は飛ばし、序論→結論の順", () => {
  const t = R.topicSentences({ p_intro: "序論の文。続き。", p_body1: "本論1の文。", p_body2: "  \n ", p_body3: "", p_concl: "結論の文" });
  assert.deepEqual(t.map((x) => [x.label, x.text]), [["序論", "序論の文。"], ["本論1", "本論1の文。"], ["結論", "結論の文"]]);
});

test("合計字数：序論〜結論だけを数え、1200〜2000 字で ○", () => {
  const base = { title: "題".repeat(50), answer: "答".repeat(100), refs: "文献".repeat(100) };
  assert.equal(R.check({ ...base, p_intro: "あ".repeat(600), p_concl: "い".repeat(599) }).chars.ok, false);
  const c = R.check({ ...base, p_intro: "あ".repeat(600), p_concl: "い".repeat(600) }).chars;
  assert.deepEqual([c.n, c.ok], [1200, true]);
  assert.equal(R.check({ p_intro: "あ".repeat(1000), p_body1: "い".repeat(1000) }).chars.ok, true);
  assert.equal(R.check({ p_intro: "あ".repeat(1000), p_body1: "い".repeat(1001) }).chars.ok, false);
});

test("出典の数：空でない行を数え、2 つ以上で ○", () => {
  assert.deepEqual(R.check({ refs: "文献A\n\n  \n" }).refs, { n: 1, min: 2, ok: false });
  assert.equal(R.check({ refs: "文献A\n文献B" }).refs.ok, true);
});

test("引用と出典の示し方：「」の数、（…年）と［1］の目安", () => {
  let c = R.check({ p_body1: "山田（2020）は「Aである」と述べている。" }).cite;
  assert.deepEqual([c.quotes, c.year, c.num, c.ok], [1, 1, 0, true]);
  c = R.check({ p_body1: "「A」という指摘がある［1］。(佐藤, 2019)" }).cite;
  assert.deepEqual([c.quotes, c.year, c.num, c.ok], [1, 1, 1, true]);
  c = R.check({ p_body1: "「A」という。（たとえば）100人が答えた。" }).cite;
  assert.deepEqual([c.quotes, c.marks, c.ok], [1, 0, false]);
});

test("話し言葉の候補：語と回数", () => {
  const c = R.check({ p_intro: "大事だと思う。なので、すごく大事だと思います。", p_concl: "そうじゃないけど、AとかBって言っちゃう。そうです。" }).colloquial;
  const m = Object.fromEntries(c.hits.map((h) => [h.w, h.n]));
  assert.deepEqual(m, { 思う: 1, 思います: 1, なので: 1, すごく: 1, とか: 1, じゃない: 1, けど: 1, ちゃう: 1, "です。": 1, "ます。": 1 });
  assert.equal(c.ok, false);
  assert.equal(R.check({ p_intro: "大事であると考える。" }).colloquial.ok, true);
});

test("話し言葉の候補：「にとって」「によって」は候補にしない", () => {
  assert.ok(!R.COLLOQUIAL.includes("って"));
  const c = R.check({ p_intro: "学生にとって重要である。調査によって明らかになった。" }).colloquial;
  assert.deepEqual(c.hits, []);
  assert.equal(c.ok, true);
});

test("接続詞：200 字につき 1 回を超えたら注意（ちょうどは ○）", () => {
  const filler = "あ".repeat(393);
  let c = R.check({ p_intro: "そして" + filler + "。しかし" }).conj; // 400 字で 2 回
  assert.deepEqual([c.total, c.limit, c.ok], [2, 2, true]);
  c = R.check({ p_intro: "そして" + filler.slice(1) + "。しかし" }).conj; // 399 字で 2 回
  assert.equal(c.ok, false);
  c = R.check({ p_intro: "また、A。そして、B。さらに、C。なので、D。だから、E。でも、F。しかし、G。つまり、H。" }).conj;
  assert.equal(c.total, 8);
  assert.equal(c.hits.length, 8);
});

test("接続詞：文の頭（段落の最初、「。」の直後）だけを数える", () => {
  // 文の途中の「でも」「また」は数えない
  let c = R.check({ p_intro: "授業でも同じである。これにもまたあてはまる。そしてAである。" }).conj;
  assert.deepEqual(c.hits, [{ w: "そして", n: 1 }]);
  // 段落ごとに最初を見る。「。」のあとの空白・改行は飛ばす
  c = R.check({ p_intro: "しかしAである。 \n つまりBである。", p_body1: "また、Cである。だからDだ。", p_concl: "Eである。でも" }).conj;
  assert.deepEqual(Object.fromEntries(c.hits.map((h) => [h.w, h.n])), { また: 1, だから: 1, でも: 1, しかし: 1, つまり: 1 });
  assert.equal(c.total, 5);
  // 「、」の直後や文の途中は数えない
  c = R.check({ p_intro: "Aであり、しかしBである。Cだからである。" }).conj;
  assert.equal(c.total, 0);
  assert.equal(R.countConj(["そしてA。そしてB。Cそして。"], "そして"), 2);
});

test("長い文：80 字を超える文の段落と何文目か", () => {
  const c = R.check({ p_intro: "短い文。" + "あ".repeat(80) + "。", p_body2: "あ".repeat(79) + "。" + "い".repeat(90) }).long;
  assert.deepEqual(c.list.map((x) => [x.label, x.index, x.len]), [["序論", 2, 81], ["本論2", 2, 90]]);
  assert.equal(c.ok, false);
  assert.equal(R.check({ p_intro: "あ".repeat(79) + "。" }).long.ok, true);
});

test("文の区切り：「」の中の句点では切らない", () => {
  assert.deepEqual(R.sentences("彼は「Aだ。Bだ。」と述べた。次の文？"), ["彼は「Aだ。Bだ。」と述べた。", "次の文？"]);
});

test("です・ます：文末で判定し、引用の中の「です」では注意にしない", () => {
  let c = R.check({ p_intro: "本レポートでは考える。これは重要です。", p_concl: "以上を示しました。" }).desumasu;
  assert.deepEqual(c.list.map((x) => [x.label, x.index]), [["序論", 2], ["結論", 1]]);
  c = R.check({ p_intro: "先生は「大事です。」と述べている。" }).desumasu;
  assert.equal(c.ok, true);
});

test("出典の追記：空でないものを末尾に 1 行ずつ、同じ行は足さない", () => {
  let r = R.appendRefs("", ["文献A", "", "  "]);
  assert.deepEqual(r, { text: "文献A", added: ["文献A"] });
  r = R.appendRefs("文献A\n", ["文献A", "文献B\n（2020年）"]);
  assert.deepEqual(r, { text: "文献A\n文献B （2020年）", added: ["文献B （2020年）"] });
  r = R.appendRefs("  文献A  \n文献B", ["文献A", "文献B"]);
  assert.deepEqual(r.added, []);
  assert.equal(r.text, "  文献A  \n文献B");
});
