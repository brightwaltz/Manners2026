/*
 * MN 名前空間：保存、試行の記録、提出ファイル、共通 UI
 * 記録はこの端末のブラウザの localStorage だけに置く（キーの頭は mn2026.）。
 * 外部への通信はしない。名前・学籍番号などの識別子は扱わない。
 */
(function (global) {
  "use strict";

  var S = global.MNScoring;
  var MN = global.MN = global.MN || {};

  MN.APP_VERSION = "2026-10-27";
  MN.PREFIX = "mn2026.";
  MN.MAX_ATTEMPTS = 30;
  MN.DEADLINE_TEXT = "2026年12月31日（木）23:59";

  // 架空の人物。学生は自分の名前の代わりに必ずこれを使う
  MN.PERSONA = { name: "玉川 みらい", affil: "工学部 1年", id: "99Z9999" };
  MN.PERSONA.label = MN.PERSONA.affil + " " + MN.PERSONA.name + "（学籍番号 " + MN.PERSONA.id + "）";
  MN.PERSONA.short = MN.PERSONA.affil + " " + MN.PERSONA.name;

  // 課題2・課題3で共通に使うレポートのテーマ
  MN.THEMES = [
    { id: "T1", t: "生成AIがあれば、大学でメールやレポートの書き方を学ぶ必要はないか" },
    { id: "T2", t: "大学のレポートで、生成AIの使用を認めるべきか" },
    { id: "T3", t: "大学の授業は、オンデマンドより対面で行うべきか" },
    { id: "T4", t: "コンビニエンスストアの24時間営業は続けるべきか" },
    { id: "T5", t: "自動運転車が事故を起こしたとき、責任は主に製造者が負うべきか" }
  ];

  MN.KADAI = {
    0: { title: "動作確認用デモ" },
    1: { title: "メールのマナーを学ぶ", short: "メールのマナー" },
    2: { title: "引用のルールを学ぶ", short: "引用のルール" },
    3: { title: "レポートの書き方を学ぶ", short: "レポートの書き方" }
  };

  /* ---------- 保存 ---------- */

  MN.store = {
    get: function (key, fallback) {
      try {
        var v = global.localStorage.getItem(MN.PREFIX + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        global.localStorage.setItem(MN.PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    keys: function (sub) {
      var out = [];
      try {
        for (var i = 0; i < global.localStorage.length; i++) {
          var k = global.localStorage.key(i);
          if (k && k.indexOf(MN.PREFIX + (sub || "")) === 0) out.push(k.slice(MN.PREFIX.length));
        }
      } catch (e) { /* 使えないブラウザでは空 */ }
      return out;
    }
  };

  // ISO 8601（端末の時差付き。日本なら +09:00）
  MN.isoLocal = function (d) {
    d = d || new Date();
    function p(n, w) { n = String(Math.abs(n)); while (n.length < (w || 2)) n = "0" + n; return n; }
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? "+" : "-";
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
      sign + p(Math.floor(Math.abs(off) / 60)) + ":" + p(Math.abs(off) % 60);
  };

  MN.firstVisit = function () {
    var v = MN.store.get("first_visit_at", null);
    if (!v) {
      v = MN.isoLocal();
      MN.store.set("first_visit_at", v);
    }
    return v;
  };

  /* ---------- 試行の記録 ---------- */

  MN.attempts = {
    key: function (k, gid) { return "k" + k + ".game." + gid; },
    list: function (k, gid) { return MN.store.get(this.key(k, gid), []) || []; },
    // 完了した挑戦だけを記録する。最大 30 回、初回は必ず残す
    add: function (k, gid, attempt) {
      var arr = this.list(k, gid);
      arr.push(attempt);
      while (arr.length > MN.MAX_ATTEMPTS) arr.splice(1, 1);
      MN.store.set(this.key(k, gid), arr);
      return arr;
    },
    best: function (k, gid) {
      var arr = this.list(k, gid);
      if (!arr.length) return null;
      return arr.reduce(function (b, a) {
        return (a.max ? a.score / a.max : 0) > (b.max ? b.score / b.max : 0) ? a : b;
      });
    },
    first: function (k, gid) { return this.list(k, gid)[0] || null; }
  };

  MN.creative = {
    key: function (k, fid) { return "k" + k + ".creative." + fid; },
    get: function (k, fid) { return MN.store.get(this.key(k, fid), null); },
    set: function (k, fid, values) { MN.store.set(this.key(k, fid), values); }
  };

  // トップページ用：未着手／進行中／提出ファイル作成済み
  MN.progress = function (k) {
    if (MN.store.get("k" + k + ".exported_at", null)) return "done";
    var used = MN.store.keys("k" + k + ".").filter(function (key) {
      return /\.(game|creative)\./.test(key);
    });
    return used.length ? "doing" : "todo";
  };
  MN.PROGRESS_LABEL = { todo: "未着手", doing: "進行中", done: "提出ファイル作成済み" };

  /* ---------- 共通 UI ---------- */

  // 要素を作る。children は文字列か要素。innerHTML は使わない
  MN.el = function (tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (a) {
        var v = attrs[a];
        if (v === null || v === undefined || v === false) return;
        if (a === "class") e.className = v;
        else if (a === "text") e.textContent = v;
        else if (a.indexOf("on") === 0 && typeof v === "function") e.addEventListener(a.slice(2), v);
        else e.setAttribute(a, v === true ? "" : v);
      });
    }
    (Array.isArray(children) ? children : children === undefined ? [] : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return e;
  };

  // 改行を <br> にして文字列を入れる
  MN.textWithBreaks = function (parent, text) {
    String(text || "").split("\n").forEach(function (line, i) {
      if (i) parent.appendChild(document.createElement("br"));
      if (line) parent.appendChild(document.createTextNode(line));
    });
    return parent;
  };

  MN.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  MN.pending = function (el, msg) {
    MN.clear(el);
    el.appendChild(MN.el("p", { class: "pending", "data-pending": "" }, msg || "準備中です。"));
  };

  MN.shuffle = function (arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  /* ---------- 問題データ ---------- */

  MN.loadData = function (k, url) {
    url = url || "../data/k" + k + ".json";
    return fetch(url, { cache: "no-cache" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (data && data.version) MN.store.set("k" + k + ".data_version", String(data.version));
      MN.data = MN.data || {};
      MN.data[k] = data;
      return data;
    }).catch(function () { return null; });
  };

  /* ---------- 提出 ---------- */

  MN.submit = {};

  // 提出ファイルの中身（object）を作る。識別子は入れない
  MN.submit.build = function (k, opts) {
    opts = opts || {};
    var st = MN.store.get("k" + k + ".submit", {}) || {};
    var data = (MN.data || {})[k];
    var games = {};
    var gameIds = (opts.requiredGames || []).slice();
    if (data && data.games) data.games.forEach(function (g) { if (gameIds.indexOf(g.id) < 0) gameIds.push(g.id); });
    gameIds.forEach(function (gid) {
      games[gid] = {
        attempts: MN.attempts.list(k, gid).map(function (a) {
          return { t0: a.t0, t1: a.t1, answers: a.answers, score: a.score, max: a.max };
        })
      };
    });
    var creative = {};
    var formIds = (opts.requiredCompose || []).slice();
    MN.compose && MN.compose.registered(k).forEach(function (fid) { if (formIds.indexOf(fid) < 0) formIds.push(fid); });
    formIds.forEach(function (fid) {
      var v = MN.compose ? MN.compose.valuesOf(k, fid) : (MN.creative.get(k, fid) || {});
      var out = {};
      Object.keys(v).forEach(function (f) { out[f] = String(v[f] == null ? "" : v[f]); });
      creative[fid] = out;
    });
    return {
      schema: S.SCHEMA,
      kadai: k,
      data_version: String(opts.dataVersion || MN.store.get("k" + k + ".data_version", "") || ""),
      app_version: MN.APP_VERSION,
      first_visit_at: MN.firstVisit(),
      exported_at: MN.isoLocal(),
      consent_showcase: st.consent === true,
      ai_use: { used: st.ai_used === true, detail: st.ai_used === true ? String(st.ai_detail || "") : "" },
      games: games,
      creative: creative
    };
  };

  MN.submit.fileName = function (k) { return "マナー課題" + k + "_提出.txt"; };

  MN.submit.download = function (name, text) {
    try {
      var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = MN.el("a", { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return true;
    } catch (e) {
      return false;
    }
  };

  // 完了状況・同意・生成AI・提出ファイル作成
  MN.submit.mount = function (el, k, opts) {
    opts = opts || {};
    var stKey = "k" + k + ".submit";
    var st = MN.store.get(stKey, {}) || {};
    function save() { MN.store.set(stKey, st); }
    MN.clear(el);

    // 完了状況
    var statusBox = MN.el("div", { class: "card", "data-role": "submit-status" });
    el.appendChild(statusBox);
    function gameTitle(gid) {
      var d = (MN.data || {})[k];
      var g = d && d.games && d.games.filter(function (x) { return x.id === gid; })[0];
      return g ? g.title : gid;
    }
    function incomplete() {
      var list = [];
      (opts.requiredGames || []).forEach(function (gid) {
        if (!MN.attempts.list(k, gid).length) list.push("ゲーム「" + gameTitle(gid) + "」");
      });
      (opts.requiredCompose || []).forEach(function (fid) {
        var miss = composeMissing(fid);
        if (miss.length) list.push(composeName(fid) + "（必須の欄：" + miss.join("、") + "）");
        else if (!(MN.compose && MN.compose.isFilled(k, fid))) list.push(composeName(fid));
      });
      return list;
    }
    // 作るの表示名：{kind}「{title}」（kind の既定は「作る」）
    function composeName(fid) {
      return ((MN.compose && MN.compose.kind(k, fid)) || "作る") + "「" + ((MN.compose && MN.compose.title(k, fid)) || fid) + "」";
    }
    // required の欄のうち、まだ空のもののラベル
    function composeMissing(fid) {
      return MN.compose ? MN.compose.missingRequired(k, fid) : [];
    }
    function renderStatus() {
      MN.clear(statusBox);
      statusBox.appendChild(MN.el("h3", { text: "進み具合" }));
      var tb = MN.el("tbody");
      (opts.requiredGames || []).forEach(function (gid) {
        var n = MN.attempts.list(k, gid).length;
        tb.appendChild(MN.el("tr", null, [
          MN.el("th", { text: "ゲーム「" + gameTitle(gid) + "」" }),
          MN.el("td", { class: n ? "mark-ok" : "mark-ng", text: n ? "○ 完了（" + n + " 回）" : "× まだ" })
        ]));
      });
      (opts.requiredCompose || []).forEach(function (fid) {
        var miss = composeMissing(fid);
        var ok = !miss.length && MN.compose && MN.compose.isFilled(k, fid);
        tb.appendChild(MN.el("tr", null, [
          MN.el("th", { text: composeName(fid) }),
          MN.el("td", { class: ok ? "mark-ok" : "mark-ng",
            text: ok ? "○ 記入あり" : miss.length ? "× まだ（必須の欄：" + miss.join("、") + "）" : "× まだ" })
        ]));
      });
      statusBox.appendChild(MN.el("table", { class: "status-table" }, tb));
      statusBox.appendChild(MN.el("div", { class: "actions" },
        MN.el("button", { type: "button", class: "sub", "data-action": "refresh-status", onclick: renderStatus }, "進み具合を更新")));
    }
    renderStatus();

    function radioRow(groupKey, choices, current, onChange) {
      var row = MN.el("div", { class: "radio-row" });
      choices.forEach(function (c) {
        var input = MN.el("input", { type: "radio", name: "mn-" + groupKey + "-k" + k, value: c.v, "data-choice": groupKey + ":" + c.v });
        if (current === c.val) input.checked = true;
        input.addEventListener("change", function () { if (input.checked) onChange(c.val); });
        row.appendChild(MN.el("label", null, [input, c.t]));
      });
      return row;
    }

    // 紹介の同意
    el.appendChild(MN.el("fieldset", null, [
      MN.el("legend", { text: "作品の紹介（必須）" }),
      MN.el("p", { text: "1月12日の授業で、名前を出さずにあなたの作品を紹介してもよいですか。" }),
      radioRow("consent", [{ v: "yes", val: true, t: "はい" }, { v: "no", val: false, t: "いいえ" }],
        st.consent, function (v) { st.consent = v; save(); })
    ]));

    // 生成AI
    var detail = MN.el("textarea", { rows: 3, maxlength: 1000, "data-field": "ai-detail", "aria-label": "生成AIを使った場所と、させたこと" });
    detail.value = st.ai_detail || "";
    detail.addEventListener("input", function () { st.ai_detail = detail.value; save(); });
    var detailWrap = MN.el("div", { class: "field" }, [
      MN.el("p", { class: "small", text: "使った場合は、どこで・何をさせたかを書いてください（例：作るの「本文」で、敬語の言い回しを直させた）。" }),
      detail
    ]);
    function syncDetail() { detailWrap.hidden = st.ai_used !== true; }
    el.appendChild(MN.el("fieldset", null, [
      MN.el("legend", { text: "生成AIの使用（必須）" }),
      radioRow("ai", [{ v: "no", val: false, t: "使っていない" }, { v: "yes", val: true, t: "使った" }],
        st.ai_used, function (v) { st.ai_used = v; save(); syncDetail(); }),
      detailWrap
    ]));
    syncDetail();

    // 作成
    var msg = MN.el("div", { "data-role": "submit-msg", "aria-live": "polite" });
    var outWrap = MN.el("div", { hidden: true });
    var out = MN.el("textarea", { class: "export", rows: 12, readonly: true, "data-role": "export-text", "aria-label": "提出ファイルの中身" });
    var copyBtn = MN.el("button", { type: "button", class: "sub", "data-action": "copy" }, "コピー");
    var copyMsg = MN.el("span", { class: "small", "aria-live": "polite" });
    copyBtn.addEventListener("click", function () {
      out.select();
      var done = function () { copyMsg.textContent = " コピーしました。"; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(out.value).then(done, function () {
          try { document.execCommand("copy"); done(); } catch (e) { copyMsg.textContent = " 手でコピーしてください。"; }
        });
      } else {
        try { document.execCommand("copy"); done(); } catch (e) { copyMsg.textContent = " 手でコピーしてください。"; }
      }
    });
    outWrap.appendChild(MN.el("h3", { text: "提出ファイルの中身" }));
    outWrap.appendChild(MN.el("p", { class: "small", text: "ダウンロードできない端末では、下の中身をコピーし、メモ帳などに貼って「" + MN.submit.fileName(k) + "」のように .txt で保存して提出してください。" }));
    outWrap.appendChild(out);
    outWrap.appendChild(MN.el("div", { class: "actions" }, [copyBtn, copyMsg]));

    var makeBtn = MN.el("button", { type: "button", "data-action": "export" }, "提出ファイルを作る");
    // 「提出ファイルを作る」は毎回点検し直す。学籍番号らしい数字などがあれば、作る前に警告して止まり、
    // 「このまま作る」を押したときだけ作る（作ること自体は止めない）
    makeBtn.addEventListener("click", function () { make(false); });
    function make(force) {
      MN.clear(msg);
      renderStatus();
      var problems = [];
      if (st.consent !== true && st.consent !== false) problems.push("「作品の紹介」で、はい か いいえ を選んでください。");
      if (st.ai_used !== true && st.ai_used !== false) problems.push("「生成AIの使用」を選んでください。");
      if (st.ai_used === true && !String(st.ai_detail || "").trim()) problems.push("生成AIを使った場所と、させたことを書いてください。");
      if (problems.length) {
        msg.appendChild(MN.el("div", { class: "notice ng", "data-role": "submit-blocked" },
          problems.map(function (p) { return MN.el("div", { text: "× " + p }); })));
        return;
      }
      var sub = MN.submit.build(k, opts);
      var notes = [];
      var left = incomplete();
      if (left.length) notes.push("まだ終わっていないものがあります：" + left.join("、") + "。このままでも提出できますが、終えてから作り直すことをすすめます。");
      var texts = [sub.ai_use.detail];
      Object.keys(sub.creative).forEach(function (fid) {
        Object.keys(sub.creative[fid]).forEach(function (f) { texts.push(sub.creative[fid][f]); });
      });
      var hits = [];
      texts.forEach(function (t) { hits = hits.concat(S.findPersonalInfo(t)); });
      if (hits.length) {
        var piiNote = "自由記述に、" + hits.map(function (h) { return h.kind + "「" + h.text + "」"; }).join("、") +
          " があります。自分の学籍番号やメールアドレスなら消して、架空の人物「" + MN.PERSONA.label + "」に置きかえてから、もう一度「提出ファイルを作る」を押してください。";
        if (!force) {
          outWrap.hidden = true;
          out.value = "";
          var anyway = MN.el("button", { type: "button", class: "sub", "data-action": "export-anyway" }, "このまま作る");
          anyway.addEventListener("click", function () { make(true); });
          msg.appendChild(MN.el("div", { class: "notice", "data-role": "submit-warning" }, [
            MN.el("div", { text: "注意：" + piiNote }),
            MN.el("div", { class: "small", text: "架空の人物の情報や、例として書いた番号なら、そのまま作ってかまいません。" }),
            MN.el("div", { class: "actions" }, anyway)
          ]));
          return;
        }
        notes.push(piiNote);
      }
      var check = S.validateSubmission(sub);
      if (!check.ok) {
        msg.appendChild(MN.el("div", { class: "notice ng", text: "提出ファイルを作れませんでした：" + check.errors.join(" / ") }));
        return;
      }
      var text = JSON.stringify(sub, null, 2) + "\n";
      out.value = text;
      outWrap.hidden = false;
      MN.store.set("k" + k + ".exported_at", sub.exported_at);
      notes.forEach(function (n) { msg.appendChild(MN.el("div", { class: "notice", "data-role": "submit-warning" }, "注意：" + n)); });
      var ok = opts.noDownload ? false : MN.submit.download(MN.submit.fileName(k), text);
      msg.appendChild(MN.el("div", { class: "notice ok" },
        // ダウンロードは始めたことしか分からない（保存できたかは確かめられない）
        (ok ? "○ ダウンロードを始めました。保存したファイルが見つからないときは、下の「提出ファイルの中身」をコピーして、メモ帳などで「" +
          MN.submit.fileName(k) + "」として保存してください。" : "○ 提出ファイルの中身を作りました。") +
        " WebClass の課題" + k + "の提出欄にアップロードしてください。"));
    }

    el.appendChild(MN.el("div", { class: "card" }, [
      MN.el("h3", { text: "提出ファイルを作る" }),
      MN.el("p", { text: "ファイル名は「" + MN.submit.fileName(k) + "」です。名前や学籍番号は入りません。作り直したときは、新しいファイルを提出してください。" }),
      MN.el("div", { class: "actions" }, makeBtn),
      msg
    ]));
    el.appendChild(outWrap);
  };

  /* ---------- 課題ページの組み立て ---------- */

  // learn: [{ h: "見出し", p: ["段落"], ul: ["箇条書き"], after: ["箇条書きのあとの段落"], ex: ["例の行"], links: [{ t, href }], num: false }]
  // （data/kN.json の任意のキー）。h → p → ul → after → ex → links の順に、すべて文字列として表示する（HTML は使わない）
  // num: false のカードは番号を付けず、番号の数え方からも外す
  MN.safeHttps = function (href) {
    try {
      var u = new URL(String(href));
      return u.protocol === "https:" ? u.href : null;
    } catch (e) {
      return null;
    }
  };

  MN.renderLearn = function (el, learn) {
    MN.clear(el);
    var num = 0;
    learn.forEach(function (sec, i) {
      // data-learn は並びの位置（番号の有無にかかわらず 1 から）
      var card = MN.el("div", { class: "card learn-card", "data-learn": String(i + 1) });
      var numbered = sec.num !== false;
      if (numbered) num++;
      card.appendChild(MN.el("h3", { text: (numbered ? num + ". " : "") + (sec.h || "") }));
      (sec.p || []).forEach(function (p) { card.appendChild(MN.textWithBreaks(MN.el("p"), p)); });
      if (sec.ul && sec.ul.length) {
        card.appendChild(MN.el("ul", { class: "learn-ul" }, sec.ul.map(function (t) {
          return MN.textWithBreaks(MN.el("li"), t);
        })));
      }
      (sec.after || []).forEach(function (p) { card.appendChild(MN.textWithBreaks(MN.el("p", { class: "learn-after" }), p)); });
      if (sec.ex && sec.ex.length) {
        card.appendChild(MN.el("div", { class: "learn-ex", "data-role": "learn-ex" }, [
          MN.el("p", { class: "ex-label", text: "例" }),
          MN.el("div", { class: "ex-body" }, sec.ex.map(function (line) {
            return MN.el("div", { class: "ex-line", text: line === "" ? "\u00a0" : line });
          }))
        ]));
      }
      var links = (sec.links || []).filter(function (l) { return l && MN.safeHttps(l.href); });
      if (links.length) {
        card.appendChild(MN.el("ul", { class: "learn-links" }, links.map(function (l) {
          return MN.el("li", null, MN.el("a", {
            href: MN.safeHttps(l.href), target: "_blank", rel: "noopener", text: l.t || l.href
          }));
        })));
      }
      el.appendChild(card);
    });
  };

  /*
   * MN.page.boot({ kadai, data?, compose?: [フォーム定義], submit?: { requiredGames, requiredCompose } })
   * data/kN.json が無いときは各段を「準備中」のままにする。
   */
  MN.page = {
    boot: function (cfg) {
      var k = cfg.kadai;
      MN.firstVisit();
      var $ = function (id) { return document.getElementById(id); };
      return MN.loadData(k, cfg.data).then(function (data) {
        var learnEl = $("learn"), gamesEl = $("games"), composeEl = $("compose"), submitEl = $("submit");
        if (!data) return null;
        if (learnEl && data.learn && data.learn.length) MN.renderLearn(learnEl, data.learn);
        if (gamesEl && data.games && data.games.length) {
          MN.clear(gamesEl);
          data.games.forEach(function (g) {
            var box = MN.el("div", { class: "game" });
            gamesEl.appendChild(box);
            MN.games.mount(box, k, g);
          });
        }
        var forms = cfg.compose || [];
        if (composeEl && forms.length) {
          MN.clear(composeEl);
          forms.forEach(function (f) {
            var box = MN.el("div", { class: "card" });
            composeEl.appendChild(box);
            MN.compose.mount(box, k, f);
          });
        }
        if (submitEl && ((data.games && data.games.length) || forms.length)) {
          var so = cfg.submit || {};
          MN.submit.mount(submitEl, k, {
            requiredGames: so.requiredGames || (data.games || []).map(function (g) { return g.id; }),
            requiredCompose: so.requiredCompose || forms.map(function (f) { return f.id; }),
            dataVersion: data.version
          });
        }
        return data;
      });
    }
  };
})(typeof window !== "undefined" ? window : this);
