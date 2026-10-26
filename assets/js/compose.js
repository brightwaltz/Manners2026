/*
 * 自由記述フォーム部品（ライブ点検つき）
 * MN.compose.mount(el, kadaiNum, { id, title, intro, fields: [...], checks: [...] })
 * 入力のたびに localStorage へ保存する。checks は目安の表示だけで、点数にはしない。
 */
(function (global) {
  "use strict";

  var MN = global.MN;
  var el = MN.el;
  var registry = {}; // { kadai: { formId: def } }

  function defaults(def) {
    var v = {};
    (def.fields || []).forEach(function (f) {
      v[f.id] = f.type === "select" ? "" : (f.prefill || "");
    });
    return v;
  }

  function values(k, def) {
    var saved = MN.creative.get(k, def.id) || {};
    var v = defaults(def);
    Object.keys(v).forEach(function (id) {
      if (typeof saved[id] === "string") v[id] = saved[id];
    });
    return v;
  }

  // 空でない＝どこか 1 つでも、最初の文から書きかえた（または選んだ）欄がある
  function isFilled(k, fid) {
    var def = registry[k] && registry[k][fid];
    var saved = MN.creative.get(k, fid);
    if (!saved) return false;
    if (!def) return Object.keys(saved).some(function (id) { return String(saved[id] || "").trim(); });
    return (def.fields || []).some(function (f) {
      var s = String(saved[f.id] || "");
      if (!s.trim()) return false;
      return f.type === "select" ? true : s.trim() !== String(f.prefill || "").trim();
    });
  }

  function mount(container, k, def) {
    registry[k] = registry[k] || {};
    registry[k][def.id] = def;
    MN.clear(container);
    container.setAttribute("data-compose", def.id);
    if (def.title) container.appendChild(el("h3", { text: def.title }));
    if (def.intro) container.appendChild(MN.textWithBreaks(el("p"), def.intro));

    var v = values(k, def);
    var checkList = el("ul", { class: "live-checks", "aria-live": "polite" });

    function save() { MN.creative.set(k, def.id, v); }

    function runChecks() {
      MN.clear(checkList);
      (def.checks || []).forEach(function (c) {
        var ok = false;
        try { ok = !!c.test(v); } catch (e) { ok = false; }
        checkList.appendChild(el("li", { class: ok ? "on" : "off", "data-check": c.id }, [
          el("span", { class: "m", text: ok ? "○" : "−" }),
          el("span", { text: c.label })
        ]));
      });
    }

    (def.fields || []).forEach(function (f) {
      var domId = "cf-k" + k + "-" + def.id + "-" + f.id;
      var input;
      if (f.type === "textarea") {
        input = el("textarea", { id: domId, rows: f.rows || 8 });
      } else if (f.type === "select") {
        input = el("select", { id: domId });
        input.appendChild(el("option", { value: "", text: "（選んでください）" }));
        (f.options || []).forEach(function (o) { input.appendChild(el("option", { value: o.id, text: o.t })); });
      } else {
        input = el("input", { type: "text", id: domId, autocomplete: "off" });
      }
      input.setAttribute("data-field", f.id);
      if (f.max && f.type !== "select") input.setAttribute("maxlength", String(f.max));
      if (f.hint) input.setAttribute("aria-describedby", domId + "-hint");
      input.value = v[f.id];

      var count = f.type === "select" ? null : el("div", { class: "count", "data-count": f.id });
      function updateCount() {
        if (!count) return;
        var n = input.value.length;
        count.textContent = n + (f.max ? " / " + f.max : "") + " 字";
        count.classList.toggle("full", !!f.max && n >= f.max);
      }
      input.addEventListener("input", function () {
        if (f.max && f.type !== "select" && input.value.length > f.max) input.value = input.value.slice(0, f.max);
        v[f.id] = input.value;
        save();
        updateCount();
        runChecks();
      });
      input.addEventListener("change", function () {
        v[f.id] = input.value;
        save();
        runChecks();
      });
      updateCount();

      container.appendChild(el("div", { class: "field" }, [
        el("label", { class: "flabel", for: domId, text: f.label }),
        f.hint ? el("p", { class: "small muted", id: domId + "-hint", text: f.hint }) : null,
        input,
        count
      ]));
    });

    if ((def.checks || []).length) {
      container.appendChild(el("p", { class: "zone-label", text: "点検（目安です。点数にはなりません）" }));
      container.appendChild(checkList);
      runChecks();
    }

    container.appendChild(el("p", { class: "small muted", text: "入力は自動で保存されます。" }));
  }

  MN.compose = {
    mount: mount,
    isFilled: isFilled,
    // 別の課題のフォームも含め、保存済みの値のオブジェクトを返す（無ければ null）
    read: function (k, fid) {
      var saved = MN.creative.get(k, fid);
      return saved && typeof saved === "object" ? saved : null;
    },
    // 定義が登録済みなら最初の文を補った値、無ければ保存された値
    valuesOf: function (k, fid) {
      var d = registry[k] && registry[k][fid];
      return d ? values(k, d) : (MN.creative.get(k, fid) || {});
    },
    registered: function (k) { return Object.keys(registry[k] || {}); },
    title: function (k, fid) { var d = registry[k] && registry[k][fid]; return d ? d.title : null; }
  };
})(window);
