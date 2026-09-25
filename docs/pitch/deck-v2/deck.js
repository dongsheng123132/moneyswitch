/* MoneySwitch deck runtime — no dependencies, works from file:// */
(function () {
  "use strict";
  var stage = document.getElementById("stage");
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  var total = slides.length;
  var progress = document.getElementById("progress");
  var pageno = document.getElementById("pageno");
  var notesEl = document.getElementById("notes");
  var params = new URLSearchParams(location.search);
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var isStatic = params.has("static") || reduce;
  if (isStatic) document.documentElement.classList.add("static");

  var cur = -1;
  var runToken = 0; // invalidates in-flight typing / counting when slide changes

  // ---------- scale stage to viewport ----------
  function fit() {
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.setProperty("--scale", s);
  }
  window.addEventListener("resize", fit);
  fit();

  // ---------- page number inside each slide (also shows in print) ----------
  slides.forEach(function (s, i) {
    var pg = s.querySelector(".ftr .pg");
    if (pg) pg.innerHTML = "<b>" + String(i + 1).padStart(2, "0") + "</b> / " + String(total).padStart(2, "0");
  });

  // ---------- typing (walks text nodes, so syntax-highlight spans survive) ----------
  function textNodes(el) {
    var out = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }
  function prepType(el) {
    if (!el._nodes) {
      el._nodes = textNodes(el);
      el._orig = el._nodes.map(function (n) { return n.nodeValue; });
    }
  }
  function finishType(el) {
    prepType(el);
    el._nodes.forEach(function (n, i) { n.nodeValue = el._orig[i]; });
    var c = el.querySelector(".caret");
    if (c && !el.hasAttribute("data-keep-caret")) c.remove();
    if (el.dataset.after) {
      var tgt = document.querySelector(el.dataset.after);
      if (tgt) {
        tgt.classList.add("danger");
        tgt.classList.remove("shake"); void tgt.offsetWidth; tgt.classList.add("shake");
      }
    }
  }
  function typeEl(el, token) {
    prepType(el);
    var speed = +el.dataset.speed || 38;
    var delay = +el.dataset.delay || 0;
    el._nodes.forEach(function (n) { n.nodeValue = ""; });
    var old = el.querySelector(".caret"); if (old) old.remove();
    var caret = document.createElement("span"); caret.className = "caret";
    el.appendChild(caret);
    if (el.dataset.after) { var t = document.querySelector(el.dataset.after); if (t) t.classList.remove("danger", "shake"); }
    var ni = 0, ci = 0;
    function step() {
      if (token !== runToken) return;
      if (ni >= el._nodes.length) { finishType(el); return; }
      var src = el._orig[ni];
      if (ci >= src.length) { ni++; ci = 0; return step(); }
      ci++;
      var node = el._nodes[ni];
      node.nodeValue = src.slice(0, ci);
      // keep caret right after the node being typed
      if (node.parentNode) node.parentNode.insertBefore(caret, node.nextSibling);
      var ch = src[ci - 1];
      setTimeout(step, ch === "\n" ? speed * 4 : speed);
    }
    setTimeout(step, delay);
  }

  // ---------- count-up (final text is always the authored text) ----------
  function countEl(el, token) {
    if (!el.dataset.final) el.dataset.final = el.textContent;
    var finalText = el.dataset.final;
    var to = parseFloat(el.dataset.to);
    var dec = +(el.dataset.dec || 0);
    var pre = el.dataset.pre || "", suf = el.dataset.suf || "";
    var dur = +(el.dataset.dur || 1600), delay = +(el.dataset.delay || 0);
    el.textContent = pre + (0).toFixed(dec) + suf;
    setTimeout(function () {
      var t0 = performance.now();
      function tick(now) {
        if (token !== runToken) { el.textContent = finalText; return; }
        var p = Math.min(1, (now - t0) / dur);
        var e = 1 - Math.pow(1 - p, 4);
        if (p < 1) { el.textContent = pre + (to * e).toFixed(dec) + suf; requestAnimationFrame(tick); }
        else el.textContent = finalText;
      }
      requestAnimationFrame(tick);
    }, delay);
  }

  function finalizeAll(root) {
    root.querySelectorAll(".type").forEach(finishType);
    root.querySelectorAll(".count").forEach(function (el) { if (el.dataset.final) el.textContent = el.dataset.final; });
  }

  // ---------- navigation ----------
  function go(i, fromHash) {
    i = Math.max(0, Math.min(total - 1, i));
    if (i === cur) return;
    runToken++;
    var token = runToken;
    if (cur >= 0) { slides[cur].classList.remove("active"); finalizeAll(slides[cur]); }
    cur = i;
    var s = slides[cur];
    void s.offsetWidth; // restart CSS animations on re-entry
    s.classList.add("active");
    if (!isStatic) {
      s.querySelectorAll(".type").forEach(function (el) { typeEl(el, token); });
      s.querySelectorAll(".count").forEach(function (el) { countEl(el, token); });
    }
    progress.style.width = ((cur + 1) / total * 100) + "%";
    pageno.textContent = (cur + 1) + " / " + total;
    var n = s.querySelector(".notes");
    var title = s.getAttribute("data-title") || "";
    notesEl.innerHTML = '<div class="nt">SPEAKER NOTES · ' + (cur + 1) + "/" + total + " · " + title + "</div>" + (n ? n.innerHTML : "");
    if (!fromHash) { try { history.replaceState(null, "", location.pathname + location.search + "#" + (cur + 1)); } catch (e) {} }
    document.title = "MoneySwitch · " + (cur + 1) + "/" + total + " " + title;
  }
  function next() { go(cur + 1); }
  function prev() { go(cur - 1); }

  function fromHashIdx() {
    var h = parseInt((location.hash || "").replace("#", ""), 10);
    return isNaN(h) ? 0 : h - 1;
  }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "PageDown" || k === "Enter") { e.preventDefault(); next(); }
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") { e.preventDefault(); prev(); }
    else if (k === "Home") { go(0); }
    else if (k === "End") { go(total - 1); }
    else if (k === "f" || k === "F") {
      if (!document.fullscreenElement) (document.documentElement.requestFullscreen || function () {}).call(document.documentElement);
      else document.exitFullscreen();
    }
    else if (k === "n" || k === "N") { notesEl.classList.toggle("on"); }
    else if (k === "r" || k === "R") { var i = cur; cur = -1; go(i); } // replay current slide
    else if (/^[0-9]$/.test(k)) { /* no-op: avoid accidental jumps */ }
    wake();
  });
  window.addEventListener("hashchange", function () { go(fromHashIdx(), true); });

  // touch swipe
  var tx = null;
  document.addEventListener("touchstart", function (e) { tx = e.touches[0].clientX; }, { passive: true });
  document.addEventListener("touchend", function (e) {
    if (tx === null) return;
    var dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
  });

  // hide chrome when idle
  var idleT;
  function wake() { document.body.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(function () { document.body.classList.add("idle"); }, 2500); }
  document.addEventListener("mousemove", wake);
  wake();

  // print: everything in final state
  window.addEventListener("beforeprint", function () { runToken++; slides.forEach(finalizeAll); });

  if (params.has("notes")) notesEl.classList.add("on");
  go(fromHashIdx(), true);

  // expose for automated checks
  window.__deck = { go: go, total: total, cur: function () { return cur; }, finalizeAll: function () { runToken++; slides.forEach(finalizeAll); } };
})();
