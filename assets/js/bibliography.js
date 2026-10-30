/* Interactive bibliography: search, sort, expand/collapse, deep links.
   Works on the HTML produced by bibliography.md
   Without JavaScript the page still works: entries are plain <details>. */
(function () {
  "use strict";

  var app = document.querySelector("[data-bib]");
  if (!app) return;
  app.classList.add("bib-js");

  var input = document.getElementById("bib-search");
  var sortSelect = document.getElementById("bib-sort");
  var toggleAllBtn = document.getElementById("bib-toggle-all");
  var statusEl = document.getElementById("bib-status");
  var noResults = document.getElementById("bib-no-results");
  var scopeButtons = Array.prototype.slice.call(app.querySelectorAll("[data-scope]"));
  var navLinks = Array.prototype.slice.call(app.querySelectorAll(".bib-nav a[data-cat]"));
  var sections = Array.prototype.slice.call(app.querySelectorAll(".bib-section"));
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var canHighlight = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

  var scope = "all";
  var currentTerms = [];

  var FOLD_MAP = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", " ": " " };
  function fold(s) {
    s = s || "";
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var f = FOLD_MAP[c];
      if (!f) {
        f = c.normalize ? c.normalize("NFD").charAt(0) : c;
        f = f.toLowerCase().charAt(0) || c;
      }
      out += f;
    }
    return out;
  }

  function textOf(root, selector) {
    var n = root.querySelector(selector);
    return n ? n.textContent : "";
  }

  function linkify(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (/https?:\/\//.test(node.nodeValue) && !node.parentNode.closest("a")) nodes.push(node);
    }
    nodes.forEach(function (n) {
      var text = n.nodeValue;
      var re = /(?:\\?url\{?)?(https?:\/\/[^\s<>"{}]+)\}?/g;
      var frag = document.createDocumentFragment();
      var last = 0;
      var m;
      while ((m = re.exec(text))) {
        var url = m[1].replace(/[.,;:)\]]+$/, "");
        var start = m.index + m[0].indexOf(m[1]);
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        var a = document.createElement("a");
        a.href = url;
        a.textContent = url;
        a.target = "_blank";
        a.rel = "noopener";
        frag.appendChild(a);
        last = start + url.length;
        if (text.charAt(last) === "}") last++;
        re.lastIndex = last;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
  }

  Array.prototype.forEach.call(app.querySelectorAll(".bib-ref"), linkify);

  var entries = Array.prototype.slice.call(app.querySelectorAll(".bib-entry")).map(function (el, i) {
    var d = el.dataset;
    var refText = textOf(el, ".bib-ref");
    return {
      el: el,
      li: el.parentNode,
      list: el.parentNode.parentNode,
      key: d.key,
      year: parseInt(d.year, 10) || 0,
      sortName: fold(d.sortName || "").replace(/^[^a-z0-9]+/, ""),
      order: i,
      fields: {
        title: fold(d.title),
        author: fold(d.authors),
        all: fold([refText, d.authors, d.title, d.key].join(" \u0000 "))
      }
    };
  });

  var lists = [];
  entries.forEach(function (e) { if (lists.indexOf(e.list) === -1) lists.push(e.list); });

  function parseTerms(q) {
    var out = [];
    var re = /"([^"]+)"|(\S+)/g;
    var m;
    q = fold(q);
    while ((m = re.exec(q))) {
      var t = (m[1] || m[2]).trim();
      if (t) out.push(t);
    }
    return out;
  }


  function addRanges(root, terms, ranges) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var f = fold(node.nodeValue);
      terms.forEach(function (t) {
        var i = 0;
        while ((i = f.indexOf(t, i)) !== -1) {
          var r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + t.length);
          ranges.push(r);
          i += t.length;
        }
      });
    }
  }

  function highlight(terms) {
    if (!canHighlight) return;
    CSS.highlights.delete("bib-match");
    if (!terms.length) return;
    var ranges = [];
    entries.forEach(function (e) {
      if (!e.li.hidden) addRanges(e.el.querySelector(".bib-ref"), terms, ranges);
    });
    var h = new Highlight();
    ranges.forEach(function (r) { h.add(r); });
    CSS.highlights.set("bib-match", h);
  }

  function apply() {
    var terms = parseTerms(input.value);
    currentTerms = terms;
    var shown = 0;

    entries.forEach(function (e) {
      var hay = e.fields[scope];
      var ok = terms.every(function (t) { return hay.indexOf(t) !== -1; });
      e.li.hidden = !ok;
      if (ok) shown++;
    });

    sections.forEach(function (s) {
      var items = s.querySelectorAll("ol.bibliography > li");
      var visible = 0;
      Array.prototype.forEach.call(items, function (li) { if (!li.hidden) visible++; });
      s.hidden = visible === 0;
      var link = navLinks.filter(function (a) { return a.dataset.cat === s.dataset.cat; })[0];
      if (link) {
        link.parentNode.hidden = items.length === 0;
        link.classList.toggle("is-empty", visible === 0);
        link.querySelector(".bib-count").textContent = terms.length ? visible + "/" + items.length : items.length;
      }
    });

    var total = entries.length;
    statusEl.textContent = terms.length
      ? shown + " of " + total + " references match"
      : total + " references";
    noResults.hidden = shown !== 0;

    highlight(terms);
    updateToggleLabel();
    syncURL();
  }

  function syncURL() {
    if (!window.history || !history.replaceState) return;
    try {
      var url = new URL(window.location.href);
      var q = input.value.trim();
      if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
      if (scope !== "all") url.searchParams.set("in", scope); else url.searchParams.delete("in");
      history.replaceState(history.state, "", url.toString());
    } catch (err) { /* ignore */ }
  }

  function setScope(next) {
    scope = next;
    scopeButtons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.scope === scope));
    });
  }

  function sortEntries(mode) {
    var compare = {
      newest: function (a, b) { return a.order - b.order; },
      oldest: function (a, b) { return (a.year || 9999) - (b.year || 9999) || a.order - b.order; },
      author: function (a, b) { return a.sortName.localeCompare(b.sortName) || b.year - a.year; }
    }[mode] || function (a, b) { return a.order - b.order; };
    lists.forEach(function (list) {
      entries
        .filter(function (e) { return e.list === list; })
        .sort(compare)
        .forEach(function (e) { list.appendChild(e.li); });
    });
  }

  function visibleEntries() {
    return entries.filter(function (e) { return !e.li.hidden; });
  }

  function updateToggleLabel() {
    var vis = visibleEntries();
    var allOpen = vis.length > 0 && vis.every(function (e) { return e.el.open; });
    toggleAllBtn.textContent = allOpen ? "Collapse all" : "Expand all";
  }

  function revealFromHash() {
    var id = "";
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (err) { return; }
    if (!id) return;
    var target = document.getElementById(id);
    if (!target) return;
    var entryEl = target.closest(".bib-entry");
    if (!entryEl) {
      var section = target.closest(".bib-section");
      if (section && section.hidden) { input.value = ""; apply(); target.scrollIntoView(); }
      return;
    }
    var rec = entries.filter(function (e) { return e.el === entryEl; })[0];
    if (rec && rec.li.hidden) { input.value = ""; apply(); }
    entryEl.open = true;
    entryEl.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    entryEl.classList.remove("bib-flash");
    void entryEl.offsetWidth;
    entryEl.classList.add("bib-flash");
  }

  function copyText(text, btn) {
    function done() {
      var label = btn.getAttribute("data-label") || btn.textContent;
      btn.setAttribute("data-label", label);
      btn.textContent = "Copied";
      clearTimeout(btn._bibTimer);
      btn._bibTimer = setTimeout(function () { btn.textContent = label; }, 1500);
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { if (document.execCommand("copy")) done(); } catch (err) { /* ignore */ }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  input.addEventListener("input", apply);
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && input.value) { input.value = ""; apply(); }
  });

  scopeButtons.forEach(function (b) {
    b.addEventListener("click", function () { setScope(b.dataset.scope); apply(); input.focus(); });
  });

  sortSelect.addEventListener("change", function () { sortEntries(sortSelect.value); });

  toggleAllBtn.addEventListener("click", function () {
    var vis = visibleEntries();
    var open = !vis.every(function (e) { return e.el.open; });
    vis.forEach(function (e) { e.el.open = open; });
    updateToggleLabel();
  });

  app.addEventListener("toggle", function (ev) {
    if (ev.target.classList && ev.target.classList.contains("bib-entry")) updateToggleLabel();
  }, true);

  app.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-bib-action]");
    if (!btn) return;
    var entryEl = btn.closest(".bib-entry");
    var pre = entryEl.querySelector(".bib-bibtex");
    switch (btn.getAttribute("data-bib-action")) {
      case "bibtex":
        pre.hidden = !pre.hidden;
        btn.setAttribute("aria-expanded", String(!pre.hidden));
        break;
      case "copy-bibtex":
        copyText(pre.textContent.trim(), btn);
        break;
      case "copy-link":
        copyText(btn.getAttribute("data-link"), btn);
        break;
    }
  });

  navLinks.forEach(function (a) {
    a.addEventListener("click", function () {
      var s = document.getElementById("cat-" + a.dataset.cat);
      if (s && s.hidden) { input.value = ""; apply(); }
    });
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    ev.preventDefault();
    input.focus();
  });

  window.addEventListener("hashchange", revealFromHash);

  if ("IntersectionObserver" in window) {
    var visibleSections = new Map();
    var observer = new IntersectionObserver(function (records) {
      records.forEach(function (r) { visibleSections.set(r.target, r.isIntersecting ? r.boundingClientRect.top : null); });
      var current = null;
      var bestTop = Infinity;
      visibleSections.forEach(function (top, s) {
        if (top !== null && !s.hidden && top < bestTop) { bestTop = top; current = s; }
      });
      navLinks.forEach(function (a) {
        a.setAttribute("aria-current", String(!!current && a.dataset.cat === current.dataset.cat));
      });
    }, { rootMargin: "-10% 0px -55% 0px" });
    sections.forEach(function (s) { observer.observe(s); });
  }

  try {
    var params = new URL(window.location.href).searchParams;
    if (params.get("q")) input.value = params.get("q");
    var initialScope = params.get("in");
    if (initialScope && ["all", "author", "title"].indexOf(initialScope) !== -1) setScope(initialScope);
  } catch (err) { /* ignore */ }

  apply();
  revealFromHash();
})();
