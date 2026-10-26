/*
 * 自由記述フォーム部品（ライブ点検つき）
 * MN.compose.mount(el, kadaiNum, { id, title, kind?, intro, fields: [...], checks: [...] })
 * 入力のたびに localStorage へ保存する。checks は目安の表示だけで、点数にはしない。
 * kind は提出の進み具合での呼び名（既定「作る」）。
 * fields の type は text・textarea・select・radio。placeholder（text・textarea）、required（true なら
 * 未入力のとき提出の進み具合に欄名を出す）を使える。radio の保存値は選んだ選択肢の id。
 */
(function (global) {
  "use strict";

  var MN = global.MN;
  var el = MN.el;
  var registry = {}; // { kadai: { formId: def } }

  function defaults(def) {
    var v = {};
    (def.fields || []).forEach(function (f) {
      v[f.id] = isChoice(f) ? "" : (f.prefill || "");
    });
    return v;
  }

  function isChoice(f) { return f.type === "select" || f.type === "radio"; }

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
      return isChoice(f) ? true : s.trim() !== String(f.prefill || "").trim();
    });
  }

  // required の欄のうち、まだ空のもののラベル（定義が未登録なら空配列）
  function missingRequired(k, fid) {
    var def = registry[k] && registry[k][fid];
    if (!def) return [];
    var v = values(k, def);
    return (def.fields || []).filter(function (f) {
      return f.required && !String(v[f.id] || "").trim();
    }).map(function (f) { return f.label; });
  }

  // radio：選択肢を縦に並べる。まとめの fieldset に data-field を付け、value で選んだ id を読み書きできるようにする
  // （select と同じように扱えるようにするため。未選択は ""）
  function radioGroup(domId, f) {
    var group = el("fieldset", { class: "radio-field", id: domId });
    group.appendChild(el("legend", { class: "flabel", text: f.label }));
    if (f.hint) group.appendChild(el("p", { class: "small muted", id: domId + "-hint", text: f.hint }));
    var list = el("div", { class: "radio-list" });
    var inputs = (f.options || []).map(function (o, i) {
      var r = el("input", { type: "radio", name: domId, id: domId + "-" + i, value: o.id, "data-option": o.id });
      list.appendChild(el("label", { for: domId + "-" + i }, [r, el("span", { text: o.t })]));
      return r;
    });
    group.appendChild(list);
    Object.defineProperty(group, "value", {
      get: function () {
        var c = inputs.filter(function (r) { return r.checked; })[0];
        return c ? c.value : "";
      },
      set: function (x) {
        inputs.forEach(function (r) { r.checked = r.value === String(x == null ? "" : x); });
      }
    });
    return group;
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
      } else if (f.type === "radio") {
        input = radioGroup(domId, f);
      } else if (f.type === "select") {
        input = el("select", { id: domId });
        input.appendChild(el("option", { value: "", text: "（選んでください）" }));
        (f.options || []).forEach(function (o) { input.appendChild(el("option", { value: o.id, text: o.t })); });
      } else {
        input = el("input", { type: "text", id: domId, autocomplete: "off" });
      }
      input.setAttribute("data-field", f.id);
      if (f.max && !isChoice(f)) input.setAttribute("maxlength", String(f.max));
      if (f.placeholder && !isChoice(f)) input.setAttribute("placeholder", f.placeholder);
      if (f.required) input.setAttribute(f.type === "radio" ? "aria-required" : "required", f.type === "radio" ? "true" : true);
      if (f.hint) input.setAttribute("aria-describedby", domId + "-hint");
      input.value = v[f.id];

      var count = isChoice(f) ? null : el("div", { class: "count", "data-count": f.id });
      function updateCount() {
        if (!count) return;
        var n = input.value.length;
        count.textContent = n + (f.max ? " / " + f.max : "") + " 字";
        count.classList.toggle("full", !!f.max && n >= f.max);
      }
      input.addEventListener("input", function () {
        if (f.max && !isChoice(f) && input.value.length > f.max) input.value = input.value.slice(0, f.max);
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

      // radio は fieldset の legend が見出し（ラベルとヒントは radioGroup の中）
      container.appendChild(el("div", { class: "field" }, f.type === "radio" ? [input] : [
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
    missingRequired: missingRequired,
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
    title: function (k, fid) { var d = registry[k] && registry[k][fid]; return d ? d.title : null; },
    kind: function (k, fid) { var d = registry[k] && registry[k][fid]; return d ? (d.kind || "作る") : null; }
  };
})(window);
