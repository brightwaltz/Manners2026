/*
 * ゲーム部品 3 種（find 間違い探し／choice 選択／order 並べ替え）
 * MN.games.mount(containerEl, kadaiNum, gameDef)
 * 点数はすべて MNScoring の関数で計算する。画面側で別の計算をしない。
 */
(function (global) {
  "use strict";

  var MN = global.MN;
  var S = global.MNScoring;
  var el = MN.el;

  function feedback(ok, children) {
    return el("div", { class: "feedback " + (ok ? "ok" : "ng"), "data-role": "feedback" }, children);
  }

  function mark(ok, text) {
    return el("span", { class: ok ? "mark-ok" : "mark-ng" }, (ok ? "○ " : "× ") + (text || ""));
  }

  /* ---------- find ---------- */

  function renderFind(box, item, done) {
    var picked = {};
    var spans = {};
    if (item.title) box.appendChild(el("h4", { class: "q-title", text: item.title }));
    box.appendChild(el("p", { class: "small muted", text: "問題のある部分をタップします。もう一度タップすると取り消せます。" }));
    var doc = el("div", { class: "doc" });

    function tappable(pos, text) {
      var s = el("span", { class: "chunk", role: "button", tabindex: "0", "aria-pressed": "false", "data-chunk": pos });
      MN.textWithBreaks(s, text);
      function toggle() {
        if (s.getAttribute("aria-disabled") === "true") return;
        picked[pos] = !picked[pos];
        s.setAttribute("aria-pressed", picked[pos] ? "true" : "false");
      }
      s.addEventListener("click", toggle);
      s.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
      });
      spans[pos] = s;
      return s;
    }

    // header が空配列なら宛先・件名の枠は出さない
    (item.header || []).forEach(function (h, i) {
      doc.appendChild(el("div", { class: "hrow" }, [
        el("span", { class: "hlabel", text: h.label }),
        tappable("h" + i, h.t)
      ]));
    });
    (item.chunks || []).forEach(function (c, i) {
      if (c.t === "\n") { doc.appendChild(el("br")); return; }
      if (c.note) { doc.appendChild(MN.textWithBreaks(el("span", { class: "note", "data-note": "" }), c.t)); return; }
      if (!String(c.t).trim()) { doc.appendChild(document.createTextNode(c.t)); return; }
      doc.appendChild(tappable("c" + i, c.t));
    });
    box.appendChild(doc);

    var checks = {};
    var opts = item.missing_options || [];
    // missing_options が空配列なら「足りないもの」の欄ごと出さない
    if (opts.length) {
      box.appendChild(el("p", { class: "zone-label", text: "足りないものがあればチェックします（無ければチェックしません）。" }));
      var ul = el("ul", { class: "checks-list" });
      opts.forEach(function (o) {
        var cb = el("input", { type: "checkbox", "data-missing": o.id });
        checks[o.id] = cb;
        ul.appendChild(el("li", null, el("label", null, [cb, el("span", { text: o.t })])));
      });
      box.appendChild(ul);
    }

    var judge = el("button", { type: "button", "data-action": "judge" }, "判定");
    var actions = el("div", { class: "actions" }, judge);
    box.appendChild(actions);

    judge.addEventListener("click", function () {
      var answer = {
        picked: Object.keys(picked).filter(function (p) { return picked[p]; }),
        missing: opts.map(function (o) { return o.id; }).filter(function (id) { return checks[id].checked; })
      };
      var r = S.scoreFind(item, answer);
      var map = S.findChunkMap(item);
      judge.remove();
      Object.keys(spans).forEach(function (pos) {
        var s = spans[pos];
        s.setAttribute("aria-disabled", "true");
        s.removeAttribute("tabindex");
        var err = map[pos];
        var cls = null, tag = null;
        if (err && r.found.indexOf(err) >= 0) { cls = "r-ok"; tag = "○"; }
        else if (err) { cls = "r-miss"; tag = "× 見落とし"; }
        else if (picked[pos]) { cls = "r-wrong"; tag = "× 誤りではない"; }
        if (cls) {
          s.classList.add(cls);
          s.appendChild(el("span", { class: "tag " + (cls === "r-ok" ? "mark-ok" : "mark-ng"), text: tag }));
        }
      });
      Object.keys(checks).forEach(function (id) { checks[id].disabled = true; });

      var fb = [el("p", { class: "result-big" }, "この問題 " + r.score + " / " + r.max + " 点")];
      if (r.wrongPicks.length) fb.push(el("p", null, mark(false, "誤りではない部分のタップ " + r.wrongPicks.length + " か所（1 か所 −5 点）")));
      var errUl = el("ul", { class: "err-list" });
      (item.errors || []).forEach(function (e) {
        var ok = r.found.indexOf(e.id) >= 0;
        errUl.appendChild(el("li", { "data-err": e.id }, [
          mark(ok, (ok ? "見つけた" : "見落とし") + "：" + (e.cat || "")),
          el("div", { text: e.why || "" }),
          e.fix ? el("div", null, [el("strong", { text: "直し方：" }), e.fix]) : null
        ]));
      });
      fb.push(errUl);
      if (opts.length) {
        var mUl = el("ul", { class: "err-list" });
        opts.forEach(function (o) {
          var isAns = (item.missing_answer || []).indexOf(o.id) >= 0;
          var checked = checks[o.id].checked;
          if (!isAns && !checked) return;
          var ok = isAns && checked;
          mUl.appendChild(el("li", null, mark(ok,
            o.t + "：" + (isAns ? (checked ? "足りない（正しくチェック）" : "足りない（チェックもれ）") : "足りている（チェック不要）"))));
        });
        if (!(item.missing_answer || []).length) mUl.appendChild(el("li", { text: "この問題には足りないものはありません。" }));
        fb.push(el("h4", { text: "足りないもの" }));
        fb.push(mUl);
        if (item.missing_explain) fb.push(MN.textWithBreaks(el("p"), item.missing_explain));
      }
      box.insertBefore(feedback(r.score === r.max, fb), actions);
      done(answer, r);
    });
  }

  /* ---------- choice ---------- */

  function renderChoice(box, item, done, game) {
    box.appendChild(MN.textWithBreaks(el("p", { class: "q-prompt" }), item.prompt));
    if (item.context) box.appendChild(el("div", { class: "context", text: item.context }));
    var wrap = el("div", { class: "options" });
    var buttons = {};
    var fbSlot = el("div");
    S.choiceOrder(item, game).forEach(function (o) {
      var b = el("button", { type: "button", "data-opt": o.id }, o.t);
      buttons[o.id] = b;
      b.addEventListener("click", function () {
        var r = S.scoreChoice(item, o.id);
        Object.keys(buttons).forEach(function (id) { buttons[id].disabled = true; });
        buttons[item.answer].classList.add("r-ok");
        buttons[item.answer].insertBefore(el("span", { class: "mark-ok", text: "○ " }), buttons[item.answer].firstChild);
        if (!r.correct) {
          b.classList.add("r-ng");
          b.insertBefore(el("span", { class: "mark-ng", text: "× " }), b.firstChild);
        }
        var fb = [el("p", { class: "result-big" }, [mark(r.correct, r.correct ? "正解" : "不正解")])];
        var oe = item.option_explain && item.option_explain[o.id];
        if (oe) fb.push(MN.textWithBreaks(el("p"), oe));
        if (item.explain) fb.push(MN.textWithBreaks(el("p"), item.explain));
        fbSlot.appendChild(feedback(r.correct, fb));
        done(o.id, r);
      });
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
    box.appendChild(fbSlot);
  }

  /* ---------- order ---------- */

  function renderOrder(box, item, done) {
    box.appendChild(MN.textWithBreaks(el("p", { class: "q-prompt" }), item.prompt));
    var byId = {};
    (item.pieces || []).forEach(function (p) { byId[p.id] = p; });
    // 最初の並びは正解の順と同じにしない
    var pool = S.orderInitial(item);
    var placed = [];
    var finished = false;

    var slots = el("div", { class: "slots", "data-zone": "answer" });
    var poolEl = el("div", { class: "pool", "data-zone": "pool" });
    var judge = el("button", { type: "button", "data-action": "judge", disabled: true }, "判定");
    var actions = el("div", { class: "actions" }, judge);
    box.appendChild(el("p", { class: "zone-label", text: "解答欄（タップすると下に戻ります）" }));
    box.appendChild(slots);
    box.appendChild(el("p", { class: "zone-label", text: "置き場（タップすると解答欄の最後に入ります）" }));
    box.appendChild(poolEl);
    box.appendChild(actions);

    function pieceBtn(id, idx) {
      return el("button", { type: "button", class: "piece", "data-piece": id, disabled: finished }, [
        idx !== null ? el("span", { class: "num", text: String(idx + 1) }) : null,
        byId[id].t
      ]);
    }
    function render() {
      MN.clear(slots);
      MN.clear(poolEl);
      placed.forEach(function (id, i) {
        var b = pieceBtn(id, i);
        b.addEventListener("click", function () {
          placed.splice(placed.indexOf(id), 1);
          pool.push(id);
          render();
        });
        slots.appendChild(b);
      });
      pool.forEach(function (id) {
        var b = pieceBtn(id, null);
        b.addEventListener("click", function () {
          pool.splice(pool.indexOf(id), 1);
          placed.push(id);
          render();
        });
        poolEl.appendChild(b);
      });
      if (!placed.length) slots.appendChild(el("span", { class: "empty", text: "ここに並びます" }));
      if (!pool.length && !finished) poolEl.appendChild(el("span", { class: "empty", text: "全部置きました。「判定」を押してください。" }));
      judge.disabled = pool.length > 0;
    }
    render();

    judge.addEventListener("click", function () {
      var answer = placed.slice();
      var r = S.scoreOrder(item, answer);
      finished = true;
      judge.remove();
      Array.prototype.forEach.call(slots.querySelectorAll(".piece"), function (b, i) {
        b.disabled = true;
        b.classList.add(r.marks[i] ? "r-ok" : "r-ng");
        b.appendChild(el("span", { class: r.marks[i] ? "mark-ok" : "mark-ng", text: r.marks[i] ? " ○" : " ×" }));
      });
      MN.clear(poolEl);
      poolEl.hidden = true;
      var ol = el("ol");
      (item.answer || []).forEach(function (id) { ol.appendChild(el("li", { text: byId[id] ? byId[id].t : id })); });
      var fb = [
        el("p", { class: "result-big" }, "この問題 " + r.score + " / " + r.max + " 点（正しい位置 " + r.correctCount + " / " + (item.answer || []).length + "）"),
        el("p", { text: "正しい順：" }), ol
      ];
      if (item.explain) fb.push(MN.textWithBreaks(el("p"), item.explain));
      box.insertBefore(feedback(r.score === r.max, fb), actions);
      done(answer, r);
    });
  }

  var RENDER = { find: renderFind, choice: renderChoice, order: renderOrder };

  /* ---------- 共通の進行 ---------- */

  function mount(container, k, game) {
    MN.clear(container);
    container.classList.add("game");
    container.setAttribute("data-game", game.id);
    var head = el("div");
    var body = el("div", { "data-role": "game-body" });
    container.appendChild(head);
    container.appendChild(body);
    head.appendChild(el("h3", { text: game.title || game.id }));
    if (game.intro) head.appendChild(MN.textWithBreaks(el("p"), game.intro));

    if (!RENDER[game.type] || !(game.items || []).length) {
      MN.pending(body);
      return;
    }

    function recordLine() {
      var best = MN.attempts.best(k, game.id);
      var first = MN.attempts.first(k, game.id);
      var n = MN.attempts.list(k, game.id).length;
      if (!n) return el("p", { class: "small muted", text: "まだ挑戦していません。全 " + game.items.length + " 問です。" });
      return el("p", { class: "small muted" },
        "挑戦 " + n + " 回 ／ ベスト " + best.score + " / " + best.max + "（" + S.rank(best.score, best.max) + "）／ 初回 " + first.score + " / " + first.max);
    }

    function startScreen() {
      MN.clear(body);
      body.appendChild(recordLine());
      var n = MN.attempts.list(k, game.id).length;
      body.appendChild(el("div", { class: "actions" },
        el("button", { type: "button", "data-action": "start", onclick: start }, n ? "もう一度挑戦" : "挑戦する")));
    }

    function start() {
      var order = MN.shuffle(game.items);
      var t0 = MN.isoLocal();
      var answers = {};
      var idx = 0;
      var combo = 0;
      var bestCombo = 0;
      var running = 0;
      var runningMax = 0;

      function showItem() {
        MN.clear(body);
        var item = order[idx];
        var bar = el("div", { class: "game-bar" }, [
          el("span", { text: "第 " + (idx + 1) + " / " + order.length + " 問" }),
          el("span", { "data-role": "running", text: "ここまで " + running + " / " + runningMax + " 点" }),
          combo >= 2 ? el("span", { class: "combo", text: "コンボ " + combo }) : null
        ]);
        body.appendChild(bar);
        var box = el("div", { class: "card", "data-item-id": item.id, "data-type": game.type });
        body.appendChild(box);
        RENDER[game.type](box, item, function (answer, r) {
          answers[item.id] = answer;
          running += r.score;
          runningMax += r.max;
          combo = r.score === r.max ? combo + 1 : 0;
          if (combo > bestCombo) bestCombo = combo;
          var last = idx === order.length - 1;
          var next = el("button", { type: "button", "data-action": last ? "finish" : "next" }, last ? "結果を見る" : "次へ");
          next.addEventListener("click", function () {
            if (last) finish();
            else { idx++; showItem(); }
          });
          var comboNote = combo >= 2 ? el("span", { class: "combo", text: "コンボ " + combo + "！" }) : null;
          box.appendChild(el("div", { class: "actions" }, [next, comboNote]));
          next.focus({ preventScroll: true });
        }, game);
        container.scrollIntoView && idx > 0 && container.scrollIntoView({ block: "start", behavior: "smooth" });
      }

      function finish() {
        var total = S.scoreGame(game, answers);
        var attempt = { t0: t0, t1: MN.isoLocal(), answers: answers, score: total.score, max: total.max };
        MN.attempts.add(k, game.id, attempt);
        var best = MN.attempts.best(k, game.id);
        var first = MN.attempts.first(k, game.id);
        var rk = S.rank(total.score, total.max);
        MN.clear(body);
        body.appendChild(el("div", { class: "card", "data-role": "result" }, [
          el("p", { class: "result-big" }, [
            "合計 ",
            el("span", { "data-result-score": String(total.score), text: String(total.score) }),
            " / ",
            el("span", { "data-result-max": String(total.max), text: String(total.max) }),
            " 点（" + S.percent(total.score, total.max) + "%） ",
            el("span", { class: "rank", "data-result-rank": rk, text: rk })
          ]),
          el("p", { class: "small muted", text: "ランク：S 90%以上、A 75%以上、B 50%以上、C それ以外" }),
          el("ul", null, [
            el("li", { text: "今回：" + total.score + " / " + total.max }),
            el("li", { text: "ベスト：" + best.score + " / " + best.max }),
            el("li", { text: "初回：" + first.score + " / " + first.max }),
            bestCombo >= 2 ? el("li", { text: "最大コンボ：" + bestCombo + "（点数には入りません）" }) : null
          ]),
          el("div", { class: "actions" },
            el("button", { type: "button", "data-action": "retry", onclick: start }, "もう一度挑戦"))
        ]));
        container.scrollIntoView && container.scrollIntoView({ block: "start", behavior: "smooth" });
      }

      showItem();
    }

    startScreen();
  }

  MN.games = { mount: mount, render: RENDER };
})(window);
