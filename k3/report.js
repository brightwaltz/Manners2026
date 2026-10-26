/*
 * 課題3「最終レポート」のライブ点検（ブラウザと Node の両方で使う）
 * MNReport.check(values) は DOM に触れず、8 項目の結果を返す。表示は k3/index.html で行う。
 * どれも点数ではなく目安（ok: true なら ○、false なら注意）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MNReport = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 本文の段落（序論〜結論）
  var PARAS = [
    { id: "p_intro", label: "序論" },
    { id: "p_body1", label: "本論1" },
    { id: "p_body2", label: "本論2" },
    { id: "p_body3", label: "本論3" },
    { id: "p_concl", label: "結論" }
  ];
  var MIN_CHARS = 1200;
  var MAX_CHARS = 2000;
  var MIN_REFS = 2;
  var LONG_SENTENCE = 80;
  var CHARS_PER_CONJ = 200;
  // 「って」は「にとって」「によって」に当たるので候補にしない
  var COLLOQUIAL = ["思う", "思います", "なので", "すごく", "とか", "じゃない", "けど", "ちゃう", "です。", "ます。"];
  // 接続詞は文の頭（段落の最初、または「。」の直後）にあるものだけを数える（「授業でも」「にもまた」は数えない）
  var CONJ = ["そして", "また", "さらに", "なので", "だから", "でも", "しかし", "つまり"];

  function str(x) { return x == null ? "" : String(x); }

  // 字数：空白と改行は数えない（全角の空白も）
  function countChars(s) { return str(s).replace(/\s/g, "").length; }

  // 重ならない出現回数
  function countWord(text, w) {
    var n = 0, i = 0;
    text = str(text);
    if (!w) return 0;
    while ((i = text.indexOf(w, i)) >= 0) { n++; i += w.length; }
    return n;
  }

  // 段落の最初の文：最初の「。」まで（「。」を含む）。無ければ段落全体
  function firstSentence(p) {
    var t = str(p).trim();
    var i = t.indexOf("。");
    return i >= 0 ? t.slice(0, i + 1) : t;
  }

  // 文に分ける。「」『』の中の句点では切らない。改行は文の区切りとして扱わない（空白として消す）
  function sentences(p) {
    var t = str(p).replace(/\s+/g, "");
    var out = [], buf = "", depth = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      buf += c;
      if (c === "「" || c === "『") depth++;
      else if ((c === "」" || c === "』") && depth > 0) depth--;
      else if (depth === 0 && (c === "。" || c === "？" || c === "！" || c === "?" || c === "!")) {
        out.push(buf);
        buf = "";
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  // 文の頭にある w の数。空白・改行は除いてから、段落の最初と「。」の直後だけを見る
  function countConj(paraTexts, w) {
    return paraTexts.reduce(function (n, p) {
      return n + str(p).replace(/\s+/g, "").split("。").filter(function (s) { return s.indexOf(w) === 0; }).length;
    }, 0);
  }

  function paras(v) {
    v = v || {};
    return PARAS.map(function (p) { return { id: p.id, label: p.label, text: str(v[p.id]) }; });
  }

  function bodyText(v) {
    return paras(v).map(function (p) { return p.text; }).join("\n");
  }

  // 1. トピック・センテンス一覧（空の段落は飛ばす）
  function topicSentences(v) {
    return paras(v).filter(function (p) { return p.text.trim(); }).map(function (p) {
      return { id: p.id, label: p.label, text: firstSentence(p.text) };
    });
  }

  // 4. 本文中の出典の示し方の目安：「（」と年らしき 4 桁の組、または［1］のような番号
  function citeMarks(text) {
    var s = str(text);
    if (s.normalize) s = s.normalize("NFKC"); // 全角の括弧・数字を半角にそろえる
    var year = s.match(/\([^()\n]{0,40}?(1[89]\d\d|20\d\d)[^()\n]{0,20}?\)/g) || [];
    var num = s.match(/\[\d{1,3}(?:[,\-–]\s*\d{1,3})*\]/g) || [];
    return { year: year.length, num: num.length, total: year.length + num.length };
  }

  var DESUMASU_END = /(です|ます|でした|ました|ません|ましょう|でしょう|ください)[」』）)]*[。？！?!]?$/;

  function check(v) {
    v = v || {};
    var ps = paras(v);
    var body = bodyText(v);

    var chars = ps.reduce(function (n, p) { return n + countChars(p.text); }, 0);

    var refLines = str(v.refs).split("\n").filter(function (l) { return l.trim(); });

    var quotes = countWord(body, "「");
    var marks = citeMarks(body);

    var colloquial = COLLOQUIAL.map(function (w) { return { w: w, n: countWord(body, w) }; })
      .filter(function (x) { return x.n > 0; });

    var paraTexts = ps.map(function (p) { return p.text; });
    var conjHits = CONJ.map(function (w) { return { w: w, n: countConj(paraTexts, w) }; })
      .filter(function (x) { return x.n > 0; });
    var conjTotal = conjHits.reduce(function (n, x) { return n + x.n; }, 0);
    var conjLimit = chars / CHARS_PER_CONJ;

    var long = [];
    var desumasu = [];
    ps.forEach(function (p) {
      sentences(p.text).forEach(function (s, i) {
        var n = countChars(s);
        if (n > LONG_SENTENCE) long.push({ id: p.id, label: p.label, index: i + 1, len: n });
        if (DESUMASU_END.test(s)) desumasu.push({ id: p.id, label: p.label, index: i + 1 });
      });
    });

    return {
      topics: topicSentences(v),
      chars: { n: chars, min: MIN_CHARS, max: MAX_CHARS, ok: chars >= MIN_CHARS && chars <= MAX_CHARS },
      refs: { n: refLines.length, min: MIN_REFS, ok: refLines.length >= MIN_REFS },
      cite: { quotes: quotes, marks: marks.total, year: marks.year, num: marks.num, ok: marks.total > 0 },
      colloquial: { hits: colloquial, ok: colloquial.length === 0 },
      conj: { hits: conjHits, total: conjTotal, limit: conjLimit, ok: conjTotal <= conjLimit },
      long: { list: long, max: LONG_SENTENCE, ok: long.length === 0 },
      desumasu: { list: desumasu, ok: desumasu.length === 0 }
    };
  }

  // refs の末尾に、まだ無い行だけを 1 行ずつ足す。戻り値 { text, added: [...] }
  // 複数行の出典は 1 行にまとめる（行の間は半角の空白でつなぐ）。同じ行（前後の空白は無視）は足さない
  function appendRefs(refs, add) {
    var text = str(refs);
    var have = {};
    text.split("\n").forEach(function (l) { if (l.trim()) have[l.trim()] = true; });
    var added = [];
    (add || []).forEach(function (r) {
      var line = str(r).split("\n").map(function (l) { return l.trim(); }).filter(Boolean).join(" ");
      if (!line || have[line]) return;
      have[line] = true;
      added.push(line);
    });
    if (added.length) {
      if (text && !/\n$/.test(text)) text += "\n";
      text += added.join("\n");
    }
    return { text: text, added: added };
  }

  return {
    PARAS: PARAS,
    COLLOQUIAL: COLLOQUIAL,
    CONJ: CONJ,
    countChars: countChars,
    countWord: countWord,
    countConj: countConj,
    firstSentence: firstSentence,
    sentences: sentences,
    topicSentences: topicSentences,
    citeMarks: citeMarks,
    check: check,
    appendRefs: appendRefs
  };
});
