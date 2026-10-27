/* 課題の進め方ガイド：7 つの場面を 1 つずつ見せる。
 * core.js は読み込まない（first_visit_at などを書いてしまうため）。
 * localStorage は mn2026.guide. で始まるキーだけを読み書きする。
 * 場面3の「記録が消える／戻る」は画面の中の見本で、本物の記録には触れない。 */
(function () {
  "use strict";

  var KEY_PREFIX = "mn2026.guide.";
  var TOTAL = 7;
  var current = 0;

  var $ = function (id) { return document.getElementById(id); };
  var all = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // 変わった要素だけを一瞬強調する（動きは CSS。reduced-motion のときは CSS 側で止める）
  function flash(el) {
    if (!el) return;
    el.classList.remove("g-changed");
    void el.offsetWidth; // 付け直しでもう一度動かす
    el.classList.add("g-changed");
  }

  function store(key, value) {
    try {
      if (value === undefined) {
        var v = window.localStorage.getItem(KEY_PREFIX + key);
        return v === null ? null : JSON.parse(v);
      }
      window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
    } catch (e) { /* 使えないブラウザでは覚えないだけ */ }
    return null;
  }

  /* ---------- 場面の切り替え ---------- */

  function sceneFromHash() {
    var m = /^#s([1-7])$/.exec(location.hash);
    return m ? Number(m[1]) : 1;
  }

  function show(n) {
    var changed = n !== current;
    current = n;
    all(".g-scene").forEach(function (s) { s.hidden = Number(s.getAttribute("data-scene")) !== n; });
    $("g-count").textContent = "場面 " + n + " / " + TOTAL;
    var prev = $("g-prev"), next = $("g-next"), first = $("g-first");
    var focused = document.activeElement;
    prev.disabled = n === 1;
    next.disabled = n === TOTAL;
    first.disabled = n === 1;
    // 押したボタンが使えなくなったら、フォーカスを場面の見出しへ移す
    if (focused && focused.disabled) $("g-h" + n).focus();
    if (changed) {
      var top = $("g-count").getBoundingClientRect().top;
      if (top < 0) $("g-count").scrollIntoView({ block: "start" });
    }
  }

  // URL は履歴に積まずに書き換える（「戻る」で場面を 1 つずつさかのぼらなくてよいように）
  function go(n) {
    n = Math.max(1, Math.min(TOTAL, n));
    if (location.hash !== "#s" + n) history.replaceState(null, "", "#s" + n);
    show(n);
  }

  $("g-prev").addEventListener("click", function () { go(current - 1); });
  $("g-next").addEventListener("click", function () { go(current + 1); });
  $("g-first").addEventListener("click", function () { go(1); });
  window.addEventListener("hashchange", function () { show(sceneFromHash()); });

  document.addEventListener("keydown", function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    var t = e.target;
    // 入力欄や動画の操作の矢印キーは横取りしない
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "VIDEO" ||
      (t.tagName === "INPUT" && t.type !== "checkbox") || t.isContentEditable)) return;
    e.preventDefault();
    go(current + (e.key === "ArrowRight" ? 1 : -1));
  });

  /* ---------- 場面1：よくある形 ⇔ 直した形 ---------- */

  all(".g-card").forEach(function (card) {
    var btn = card.querySelector("[data-toggle]");
    var before = card.querySelector('[data-form="before"]');
    var after = card.querySelector('[data-form="after"]');
    btn.addEventListener("click", function () {
      var fixed = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(fixed));
      before.hidden = fixed;
      after.hidden = !fixed;
      btn.textContent = fixed ? "よくある形に戻す" : "直した形を見る";
      flash(fixed ? after : before);
    });
  });

  /* ---------- 場面2・4：箱を押すと説明が出る ---------- */

  function picker(attr, detailId) {
    var boxes = all("[" + attr + "]");
    var detail = $(detailId);
    boxes.forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute(attr);
        if (b.getAttribute("aria-pressed") === "true") return;
        boxes.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        all("[data-for]", detail).forEach(function (d) { d.hidden = d.getAttribute("data-for") !== v; });
        flash(detail.querySelector('[data-for="' + v + '"]'));
      });
    });
  }
  picker("data-step", "g-flow-detail");
  picker("data-route", "g-route-detail");

  /* ---------- 場面3：記録の見本（画面の中だけ） ---------- */

  var STORE_MSG = {
    other: "別の端末のブラウザには、記録がありません。",
    safari: "Safari は、7日以上開かないサイトの記録を消すことがあります。",
    restore: "④提出の「保存したファイルから続ける」で読み込むと、続きからできます。"
  };
  var sample = { device: "この端末", hasRecord: true, last: null };

  function renderStore(changedEl) {
    $("g-device-label").textContent = sample.device;
    $("g-record-list").hidden = !sample.hasRecord;
    $("g-record-empty").hidden = sample.hasRecord;
    all("[data-store]").forEach(function (b) {
      var k = b.getAttribute("data-store");
      if (k === "reset") return;
      b.setAttribute("aria-pressed", String(k === sample.last));
      if (k === "restore") b.disabled = sample.hasRecord;
      else b.disabled = false;
    });
    var msg = $("g-store-msg");
    msg.textContent = sample.last ? STORE_MSG[sample.last] : "";
    msg.hidden = !sample.last;
    if (sample.last) flash(msg);
    if (changedEl) flash(changedEl);
  }

  all("[data-store]").forEach(function (b) {
    b.addEventListener("click", function () {
      var k = b.getAttribute("data-store");
      var deviceBefore = sample.device;
      var hadRecord = sample.hasRecord;
      if (k === "reset") sample = { device: "この端末", hasRecord: true, last: null };
      else if (k === "other") sample = { device: "別の端末", hasRecord: false, last: "other" };
      else if (k === "safari") sample = { device: "この端末", hasRecord: false, last: "safari" };
      else if (k === "restore") sample = { device: sample.device, hasRecord: true, last: "restore" };
      var restoreBtn = document.querySelector('[data-store="restore"]');
      renderStore(hadRecord !== sample.hasRecord ? $("g-record") : null);
      if (deviceBefore !== sample.device) flash($("g-device-label"));
      // 押したボタンが使えなくなったら、隣の「最初の状態に戻す」へ
      if (document.activeElement === restoreBtn && restoreBtn.disabled) document.querySelector('[data-store="reset"]').focus();
    });
  });

  /* ---------- 場面6：「いま」の位置 ---------- */

  // 公開→締切を 0〜50%、締切→フィードバックを 50〜100% に置く（範囲外は端に寄せる）
  function nowPercent(now) {
    var open = new Date(2026, 9, 27, 0, 0).getTime();
    var due = new Date(2026, 11, 31, 23, 59).getTime();
    var fb = new Date(2027, 0, 12, 0, 0).getTime();
    var t = now.getTime();
    if (t <= open) return 0;
    if (t <= due) return ((t - open) / (due - open)) * 50;
    if (t <= fb) return 50 + ((t - due) / (fb - due)) * 50;
    return 100;
  }
  (function () {
    var p = nowPercent(new Date());
    var el = $("g-now");
    el.style.left = p.toFixed(1) + "%";
    // 端では印の文字が枠の外に出ないように寄せる
    el.classList.toggle("g-now-start", p < 10);
    el.classList.toggle("g-now-end", p > 90);
    el.setAttribute("data-percent", p.toFixed(1));
  })();

  /* ---------- 場面7：今日やること（mn2026.guide.todo。採点には使わない） ---------- */

  var todo = store("todo");
  if (!Array.isArray(todo)) todo = [false, false, false];
  all("[data-todo]").forEach(function (cb) {
    var i = Number(cb.getAttribute("data-todo"));
    var done = cb.parentNode.querySelector(".g-done");
    cb.checked = todo[i] === true;
    done.hidden = !cb.checked;
    cb.addEventListener("change", function () {
      todo[i] = cb.checked;
      done.hidden = !cb.checked;
      store("todo", todo);
      flash(cb.parentNode);
    });
  });

  /* ---------- 動画（ファイルが読めたときだけ出す） ---------- */

  var film = $("film");
  var video = film.querySelector("video");
  function showFilm() { film.hidden = false; }
  video.addEventListener("loadedmetadata", showFilm);
  if (video.readyState >= 1) showFilm();

  show(sceneFromHash());
})();
