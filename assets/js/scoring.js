/*
 * 採点の純関数（ブラウザと Node の両方で使う）
 * 画面も、後で使う採点スクリプトも、点数はここの関数だけで計算する。
 * DOM には触れない。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MNScoring = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PER_ITEM = 10;

  function uniq(arr) {
    var seen = {};
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (x) {
      var k = String(x);
      if (!seen[k]) {
        seen[k] = true;
        out.push(k);
      }
    });
    return out;
  }

  /* ---------- find（間違い探し） ---------- */

  // かたまりの識別子（h0, c3）→ err id（無ければ null）
  // "note": true のかたまり（場面の説明）はタップ対象ではないので入れない
  function findChunkMap(item) {
    var map = {};
    (item.header || []).forEach(function (h, i) {
      map["h" + i] = h.err || null;
    });
    (item.chunks || []).forEach(function (c, i) {
      if (c.note) return;
      map["c" + i] = c.err || null;
    });
    return map;
  }

  function isNotePos(item, pos) {
    var m = /^c(\d+)$/.exec(pos);
    var c = m && (item.chunks || [])[Number(m[1])];
    return !!(c && c.note);
  }

  function maxFind(item) {
    return PER_ITEM * ((item.errors || []).length + (item.missing_answer || []).length);
  }

  // answer = { picked: ["h0","c3"], missing: ["m_name"] }
  // missing_answer が [] の問題は、何もチェックしなければ満点（満点 = 10 × 誤りの数）
  function scoreFind(item, answer) {
    answer = answer || {};
    var map = findChunkMap(item);
    var errIds = {};
    (item.errors || []).forEach(function (e) {
      errIds[e.id] = true;
    });
    var found = {};
    var wrongPicks = [];
    uniq(answer.picked).forEach(function (pos) {
      if (isNotePos(item, pos)) return; // 場面の説明は採点で扱わない
      var err = map.hasOwnProperty(pos) ? map[pos] : null;
      if (err && errIds[err]) {
        found[err] = true;
      } else {
        wrongPicks.push(pos);
      }
    });
    var foundIds = Object.keys(found);
    var missedIds = (item.errors || [])
      .map(function (e) { return e.id; })
      .filter(function (id) { return !found[id]; });

    var ansSet = {};
    (item.missing_answer || []).forEach(function (m) { ansSet[m] = true; });
    var missingOk = [];
    var missingWrong = [];
    uniq(answer.missing).forEach(function (m) {
      if (ansSet[m]) missingOk.push(m);
      else missingWrong.push(m);
    });
    var missingMissed = (item.missing_answer || []).filter(function (m) {
      return missingOk.indexOf(m) < 0;
    });

    var raw = PER_ITEM * foundIds.length - 5 * wrongPicks.length +
      PER_ITEM * missingOk.length - 5 * missingWrong.length;
    return {
      score: Math.max(0, raw),
      max: maxFind(item),
      found: foundIds,
      missed: missedIds,
      wrongPicks: wrongPicks,
      missingOk: missingOk,
      missingWrong: missingWrong,
      missingMissed: missingMissed
    };
  }

  /* ---------- choice（選択） ---------- */

  // answer = "b"
  function scoreChoice(item, answer) {
    var ok = typeof answer === "string" && answer === item.answer;
    return { score: ok ? PER_ITEM : 0, max: PER_ITEM, correct: ok };
  }

  // 32bit FNV-1a
  function hash(str) {
    var h = 0x811c9dc5;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // 選択肢の表示順：問題 id のハッシュで決める（毎回同じ順）
  // ゲーム定義に fixed_order: true があるときは、データの順のまま（表示だけの違い。採点は answer の id で行う）
  function choiceOrder(item, gameDef) {
    var opts = (item.options || []).slice();
    if (gameDef && gameDef.fixed_order) return opts;
    return opts
      .map(function (o, i) { return { o: o, k: hash(item.id + "|" + o.id), i: i }; })
      .sort(function (a, b) { return a.k - b.k || a.i - b.i; })
      .map(function (x) { return x.o; });
  }

  /* ---------- order（並べ替え） ---------- */

  // answer = ["p2","p1"]
  function scoreOrder(item, answer) {
    var correct = item.answer || [];
    var given = Array.isArray(answer) ? answer : [];
    var marks = correct.map(function (id, i) { return given[i] === id; });
    var n = marks.filter(Boolean).length;
    var score = correct.length ? Math.round((n / correct.length) * PER_ITEM) : 0;
    return { score: score, max: PER_ITEM, marks: marks, correctCount: n };
  }

  // 置き場の最初の並び（部品 id の配列）。部品が 2 つ以上なら正解の順と同じにしない。
  // 点数には関係しない。random は 0 以上 1 未満を返す関数（省略時 Math.random）
  function orderInitial(item, random) {
    random = random || Math.random;
    var a = (item.pieces || []).map(function (p) { return p.id; });
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    if (a.length > 1 && a.join("\u0000") === (item.answer || []).join("\u0000")) a.push(a.shift());
    return a;
  }

  /* ---------- まとめ ---------- */

  function scoreItem(type, item, answer) {
    if (type === "find") return scoreFind(item, answer);
    if (type === "choice") return scoreChoice(item, answer);
    if (type === "order") return scoreOrder(item, answer);
    throw new Error("unknown game type: " + type);
  }

  function maxItem(type, item) {
    return type === "find" ? maxFind(item) : PER_ITEM;
  }

  // answers = { 問題id: 解答 }。答えていない問題は 0 点（満点には数える）
  function scoreGame(gameDef, answers) {
    answers = answers || {};
    var score = 0;
    var max = 0;
    var perItem = {};
    (gameDef.items || []).forEach(function (item) {
      var has = Object.prototype.hasOwnProperty.call(answers, item.id);
      var r = has ? scoreItem(gameDef.type, item, answers[item.id])
                  : { score: 0, max: maxItem(gameDef.type, item) };
      perItem[item.id] = r;
      score += r.score;
      max += r.max;
    });
    return { score: score, max: max, perItem: perItem };
  }

  function rank(score, max) {
    if (!max) return "C";
    var p = (score / max) * 100;
    if (p >= 90) return "S";
    if (p >= 75) return "A";
    if (p >= 50) return "B";
    return "C";
  }

  function percent(score, max) {
    return max ? Math.round((score / max) * 100) : 0;
  }

  /* ---------- 個人情報らしい文字列の検出（警告用） ---------- */

  var PERSONA_ID = "99Z9999";

  // 戻り値：[{ kind: "学籍番号らしい数字" | "メールアドレス", text }]
  function findPersonalInfo(text) {
    var s = String(text || "");
    if (s.normalize) s = s.normalize("NFKC");
    var hits = [];
    var mailRe = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+/g;
    var m;
    while ((m = mailRe.exec(s))) {
      var domain = m[0].split("@")[1].toLowerCase();
      // example.com / example.ac.jp などの例示用ドメインは警告しない
      if (/(^|\.)example(\.|$)/.test(domain)) continue;
      hits.push({ kind: "メールアドレス", text: m[0] });
    }
    var noMail = s.replace(mailRe, " ");
    // 例：12A3456 のような形、または 7〜10 桁の数字の並び
    var idRe = /(^|[^A-Za-z0-9])(\d{2}[A-Za-z]\d{4,5}|\d{7,10})(?![A-Za-z0-9])/g;
    while ((m = idRe.exec(noMail))) {
      var t = m[2];
      if (t.toUpperCase() === PERSONA_ID) continue;
      hits.push({ kind: "学籍番号らしい数字", text: t });
    }
    return hits;
  }

  /* ---------- 提出ファイルの形の検査 ---------- */

  var SCHEMA = "manners2026-submit/1";
  var TOP_KEYS = ["schema", "kadai", "data_version", "app_version", "first_visit_at",
    "exported_at", "consent_showcase", "ai_use", "games", "creative"];
  var ATTEMPT_KEYS = ["t0", "t1", "answers", "score", "max"];
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?([+-]\d{2}:\d{2}|Z)$/;

  function isObj(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x);
  }

  function unknownKeys(obj, allowed) {
    return Object.keys(obj).filter(function (k) { return allowed.indexOf(k) < 0; });
  }

  function validateSubmission(sub) {
    var errors = [];
    function err(msg) { errors.push(msg); }
    if (!isObj(sub)) return { ok: false, errors: ["最上位が object ではありません"] };

    unknownKeys(sub, TOP_KEYS).forEach(function (k) { err("未知のキー: " + k); });
    TOP_KEYS.forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(sub, k)) err("キーがありません: " + k);
    });
    if (sub.schema !== SCHEMA) err("schema が違います");
    if (!(Number.isInteger(sub.kadai) && sub.kadai >= 0 && sub.kadai <= 3)) err("kadai が不正です");
    if (typeof sub.data_version !== "string") err("data_version が文字列ではありません");
    if (typeof sub.app_version !== "string") err("app_version が文字列ではありません");
    ["first_visit_at", "exported_at"].forEach(function (k) {
      if (typeof sub[k] !== "string" || !ISO_RE.test(sub[k])) err(k + " が ISO 8601 ではありません");
    });
    if (typeof sub.consent_showcase !== "boolean") err("consent_showcase が真偽値ではありません");

    if (!isObj(sub.ai_use)) {
      err("ai_use が object ではありません");
    } else {
      unknownKeys(sub.ai_use, ["used", "detail"]).forEach(function (k) { err("ai_use の未知のキー: " + k); });
      if (typeof sub.ai_use.used !== "boolean") err("ai_use.used が真偽値ではありません");
      if (typeof sub.ai_use.detail !== "string") err("ai_use.detail が文字列ではありません");
    }

    if (!isObj(sub.games)) {
      err("games が object ではありません");
    } else {
      Object.keys(sub.games).forEach(function (gid) {
        var g = sub.games[gid];
        if (!isObj(g)) { err("games." + gid + " が object ではありません"); return; }
        unknownKeys(g, ["attempts"]).forEach(function (k) { err("games." + gid + " の未知のキー: " + k); });
        if (!Array.isArray(g.attempts)) { err("games." + gid + ".attempts が配列ではありません"); return; }
        g.attempts.forEach(function (a, i) {
          var p = "games." + gid + ".attempts[" + i + "]";
          if (!isObj(a)) { err(p + " が object ではありません"); return; }
          unknownKeys(a, ATTEMPT_KEYS).forEach(function (k) { err(p + " の未知のキー: " + k); });
          ["t0", "t1"].forEach(function (k) {
            if (typeof a[k] !== "string" || !ISO_RE.test(a[k])) err(p + "." + k + " が ISO 8601 ではありません");
          });
          if (!isObj(a.answers)) err(p + ".answers が object ではありません");
          if (!(Number.isFinite(a.score) && a.score >= 0)) err(p + ".score が不正です");
          if (!(Number.isFinite(a.max) && a.max >= 0)) err(p + ".max が不正です");
        });
      });
    }

    if (!isObj(sub.creative)) {
      err("creative が object ではありません");
    } else {
      Object.keys(sub.creative).forEach(function (fid) {
        var f = sub.creative[fid];
        if (!isObj(f)) { err("creative." + fid + " が object ではありません"); return; }
        Object.keys(f).forEach(function (k) {
          if (typeof f[k] !== "string") err("creative." + fid + "." + k + " が文字列ではありません");
        });
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    PER_ITEM: PER_ITEM,
    SCHEMA: SCHEMA,
    hash: hash,
    findChunkMap: findChunkMap,
    scoreFind: scoreFind,
    scoreChoice: scoreChoice,
    choiceOrder: choiceOrder,
    scoreOrder: scoreOrder,
    orderInitial: orderInitial,
    scoreItem: scoreItem,
    maxItem: maxItem,
    scoreGame: scoreGame,
    rank: rank,
    percent: percent,
    findPersonalInfo: findPersonalInfo,
    validateSubmission: validateSubmission
  };
});
