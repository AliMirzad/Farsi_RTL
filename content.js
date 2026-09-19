/*
 * Farsi_RTL — v1.21
 *
 * Three direction modes chosen from the popup:
 *   - "always" : any Persian character in the paragraph -> RTL
 *   - "smart"  : multi-signal vote (see below)
 *   - "auto"   : never override direction; only isolate Latin runs
 *
 * Smart mode combines three signals per paragraph in a weighted vote:
 *   1. CLD3 via chrome.i18n.detectLanguage (weight 2)
 *   2. Heuristic word count + last-strong tiebreaker  (weight 1)
 *   3. Context — this page's running Persian/Latin ratio (weight 1)
 *
 * Every paragraph respects a session-only user override: select any text
 * inside it, click the floating ⇄ button that appears below the
 * selection, and only that paragraph flips. Refreshing the page wipes
 * overrides; the mode picks direction again.
 *
 * Latin runs are wrapped in <bdi> so no invisible bidi chars land in the
 * DOM. Multi-word Latin phrases (letters, digits, dots, hyphens, commas
 * and spaces) stay in ONE bdi so the browser doesn't reverse their
 * visual order inside an RTL paragraph. Input areas (contenteditable and
 * textarea) are never marked or wrapped.
 */

(function () {
  const KEY_MODE = "rtlMode";
  const KEY_FONT = "fontEnabled";
  const KEY_OLD_RTL = "rtlEnabled";

  const CLASS_RTL = "farsi-rtl-on";
  const CLASS_FONT = "farsi-font-on";
  const MARK = "data-farsi-rtl";
  const ISO_ATTR = "data-farsi-iso";
  const BTN_ID = "farsi-flip-btn";

  const SEL =
    "p,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd," +
    "figcaption,summary,pre,code";

  const INPUT_SKIP =
    'textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[contenteditable="plaintext-only"]';

  const RTL_LANGS = new Set([
    "fa", "ar", "ur", "he", "iw", "yi", "ps", "sd", "ku", "ckb", "ug", "arc", "syr"
  ]);

  let mode = "smart";
  let fontOn = false;

  // Context signal: running counts of paragraphs marked on THIS page.
  let ctxRtl = 0;
  let ctxLtr = 0;

  // Session-only overrides. Kept in memory so a page refresh wipes them
  // and the paragraph goes back to whatever the current mode picks.
  const overrides = new Map();

  const FONT_REG  = chrome.runtime.getURL("fonts/Vazirmatn-Regular.woff2");
  const FONT_MED  = chrome.runtime.getURL("fonts/Vazirmatn-Medium.woff2");
  const FONT_BOLD = chrome.runtime.getURL("fonts/Vazirmatn-Bold.woff2");

  const CSS =
    "@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:400;" +
    "font-display:swap;src:url(\"" + FONT_REG + "\") format(\"woff2\");}\n" +
    "@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:500;" +
    "font-display:swap;src:url(\"" + FONT_MED + "\") format(\"woff2\");}\n" +
    "@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:700;" +
    "font-display:swap;src:url(\"" + FONT_BOLD + "\") format(\"woff2\");}\n" +

    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"]{" +
    "direction:rtl!important;text-align:right!important;" +
    "unicode-bidi:isolate!important;}\n" +

    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"]{" +
    "direction:ltr!important;text-align:left!important;" +
    "unicode-bidi:isolate!important;}\n" +

    "html." + CLASS_RTL + " ul[" + MARK + "=\"rtl\"]," +
    "html." + CLASS_RTL + " ol[" + MARK + "=\"rtl\"]{" +
    "padding-right:1.75em!important;padding-left:0!important;" +
    "margin-right:0!important;}\n" +

    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] code:not([" + MARK + "])," +
    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] pre:not([" + MARK + "])," +
    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"] code:not([" + MARK + "])," +
    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"] pre:not([" + MARK + "]){" +
    "direction:ltr!important;text-align:left!important;" +
    "unicode-bidi:isolate!important;}\n" +

    "html." + CLASS_RTL + " bdi[" + ISO_ATTR + "]{" +
    "direction:ltr!important;unicode-bidi:isolate!important;" +
    "display:inline;font:inherit;color:inherit;" +
    "background:transparent;padding:0;margin:0;border:0;}\n" +

    "html." + CLASS_FONT + " [" + MARK + "=\"rtl\"]{" +
    "font-family:'Vazirmatn',Tahoma,sans-serif!important;}\n" +

    "html." + CLASS_FONT + " [" + MARK + "] pre," +
    "html." + CLASS_FONT + " [" + MARK + "] code," +
    "html." + CLASS_FONT + " pre[" + MARK + "]," +
    "html." + CLASS_FONT + " code[" + MARK + "]{" +
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;}\n" +

    "#" + BTN_ID + "{" +
    "position:fixed!important;z-index:2147483647!important;" +
    "width:34px!important;height:34px!important;" +
    "padding:0!important;margin:0!important;" +
    "border:1px solid rgba(255,255,255,0.18)!important;" +
    "border-radius:50%!important;" +
    "background:linear-gradient(135deg,#10b981 0%,#059669 100%)!important;" +
    "color:#fff!important;line-height:1!important;" +
    "cursor:pointer!important;user-select:none!important;" +
    "box-shadow:0 6px 16px rgba(16,185,129,0.35)," +
    "0 2px 4px rgba(0,0,0,0.15)!important;" +
    "display:none!important;opacity:1!important;pointer-events:auto!important;" +
    "box-sizing:border-box!important;text-align:center!important;" +
    "align-items:center!important;justify-content:center!important;" +
    "text-decoration:none!important;overflow:hidden!important;" +
    "outline:none!important;font:0/0 a!important;}\n" +
    "#" + BTN_ID + ".on{display:flex!important;}\n" +
    "#" + BTN_ID + ":hover{" +
    "background:linear-gradient(135deg,#059669 0%,#047857 100%)!important;" +
    "box-shadow:0 8px 22px rgba(16,185,129,0.45)," +
    "0 3px 6px rgba(0,0,0,0.2)!important;}\n" +
    "#" + BTN_ID + ":active{" +
    "background:linear-gradient(135deg,#047857 0%,#065f46 100%)!important;" +
    "box-shadow:0 3px 8px rgba(16,185,129,0.35)!important;}\n" +
    "#" + BTN_ID + " svg{display:block!important;pointer-events:none!important;" +
    "width:16px!important;height:16px!important;}";

  let styleEl = null;
  let observer = null;
  let observing = false;
  const queue = [];
  const queued = new Set();
  let scheduled = false;

  const rIC =
    window.requestIdleCallback ||
    function (cb) {
      return setTimeout(function () {
        cb({ timeRemaining: function () { return 5; }, didTimeout: true });
      }, 16);
    };

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) {
      if (document.head && styleEl.parentNode !== document.head) {
        document.head.appendChild(styleEl);
      }
      return;
    }
    styleEl = document.createElement("style");
    styleEl.id = "farsi-rtl-style";
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
    if (!document.head) {
      const mo = new MutationObserver(function () {
        if (document.head && styleEl.parentNode !== document.head) {
          document.head.appendChild(styleEl);
          mo.disconnect();
        }
      });
      mo.observe(document.documentElement, { childList: true });
    }
  }

  // Latin run: a Latin phrase — letters, digits, dots, underscores,
  // hyphens, commas AND spaces — kept together in ONE <bdi>. Multi-word
  // phrases like "compile time" or "Auto-unboxing" have to stay in a
  // single L block; otherwise the browser's bidi algorithm reverses their
  // visual order in an RTL paragraph. The run always ends on an
  // alphanumeric character so trailing punctuation stays outside the bdi
  // (that's what lets `A)` render with the paren mirrored after A).
  const LATIN_RUN =
    /[A-Za-z](?:[A-Za-z0-9._\-, ]*[A-Za-z0-9])?(?:\([^()]*\))?/g;
  const OLD_ISOLATE_CHARS = /[⁦-⁩]/g;

  function wrapLatinInBdi(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest && parent.closest(INPUT_SKIP)) continue;
      if (parent.tagName === "BDI" && parent.getAttribute(ISO_ATTR) === "1") continue;
      const data = node.data;
      if (!data) continue;
      const hasOld = OLD_ISOLATE_CHARS.test(data);
      OLD_ISOLATE_CHARS.lastIndex = 0;
      if (!hasOld && (data.length < 2 || !/[A-Za-z]/.test(data))) continue;
      targets.push({ node, hasOld });
    }
    let mutated = false;
    for (let i = 0; i < targets.length; i++) {
      const { node, hasOld } = targets[i];
      let text = node.data;
      if (hasOld) text = text.replace(OLD_ISOLATE_CHARS, "");
      if (splitAndWrap(node, text)) mutated = true;
      else if (hasOld) { node.data = text; mutated = true; }
    }
    if (mutated && observer) observer.takeRecords();
    return mutated;
  }

  function splitAndWrap(textNode, text) {
    if (!text || text.length < 2 || !/[A-Za-z]/.test(text)) return false;
    LATIN_RUN.lastIndex = 0;
    const pieces = [];
    let lastIndex = 0;
    let m;
    while ((m = LATIN_RUN.exec(text))) {
      if (m.index > lastIndex) pieces.push({ text: text.slice(lastIndex, m.index), iso: false });
      pieces.push({ text: m[0], iso: true });
      lastIndex = LATIN_RUN.lastIndex;
    }
    if (!pieces.some(function (p) { return p.iso; })) return false;
    if (lastIndex < text.length) pieces.push({ text: text.slice(lastIndex), iso: false });
    const parent = textNode.parentNode;
    if (!parent) return false;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (!p.text) continue;
      if (p.iso) {
        const b = document.createElement("bdi");
        b.setAttribute(ISO_ATTR, "1");
        b.textContent = p.text;
        frag.appendChild(b);
      } else {
        frag.appendChild(document.createTextNode(p.text));
      }
    }
    parent.replaceChild(frag, textNode);
    return true;
  }

  function hasAnyPersian(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (
        (c >= 0x0600 && c <= 0x06FF) ||
        (c >= 0x0750 && c <= 0x077F) ||
        (c >= 0x08A0 && c <= 0x08FF) ||
        (c >= 0xFB50 && c <= 0xFDFF) ||
        (c >= 0xFE70 && c <= 0xFEFF)
      ) return true;
    }
    return false;
  }

  // Heuristic signal — word count + last strong char tiebreaker.
  function detectHeuristic(text, strict) {
    if (!text) return null;
    let p = 0, l = 0;
    let wordHasPersian = false, wordHasLatin = false;
    let inWord = false;
    let lastStrong = 0;
    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : 32;
      const isSpace = c === 32 || c === 9 || c === 10 || c === 13 ||
        c === 0x00A0 || c === 0x2028 || c === 0x2029;
      if (isSpace) {
        if (inWord) {
          if (wordHasPersian) p++;
          else if (wordHasLatin) l++;
        }
        inWord = false;
        wordHasPersian = false;
        wordHasLatin = false;
        continue;
      }
      inWord = true;
      const isP =
        (c >= 0x0600 && c <= 0x06FF) ||
        (c >= 0x0750 && c <= 0x077F) ||
        (c >= 0x08A0 && c <= 0x08FF) ||
        (c >= 0xFB50 && c <= 0xFDFF) ||
        (c >= 0xFE70 && c <= 0xFEFF);
      const isL = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (isP) { wordHasPersian = true; lastStrong = 1; }
      else if (isL) { wordHasLatin = true; lastStrong = 2; }
    }
    if (p === 0) return null;
    if (strict) return p > l ? "rtl" : "ltr";
    if (p * 2 >= l) return "rtl";
    return lastStrong === 1 ? "rtl" : "ltr";
  }

  // Context signal — where does the surrounding chat lean?
  function detectContext() {
    const total = ctxRtl + ctxLtr;
    if (total < 3) return null;
    if (ctxRtl > ctxLtr) return "rtl";
    if (ctxLtr > ctxRtl) return "ltr";
    return null;
  }

  // CLD3 signal via Chrome's own detector. Returns null when uncertain.
  function detectCLD3(text, cb) {
    if (!text || text.length < 3) { cb(null); return; }
    try {
      chrome.i18n.detectLanguage(text, function (result) {
        if (!result || !result.languages || !result.languages.length) {
          cb(null); return;
        }
        let rtlPct = 0, ltrPct = 0;
        for (const lang of result.languages) {
          if (RTL_LANGS.has(lang.language)) rtlPct += lang.percentage;
          else ltrPct += lang.percentage;
        }
        if (rtlPct === 0 && ltrPct === 0) { cb(null); return; }
        // Slight bias toward RTL so ties go to Persian on a Persian-focused
        // extension (matches user expectation).
        cb(rtlPct >= ltrPct ? "rtl" : "ltr");
      });
    } catch (_) { cb(null); }
  }

  // Simple, stable text hash for override keys. Only the first ~200 chars
  // are hashed so streaming responses that grow the paragraph don't lose
  // their override.
  function hashText(text) {
    let h = 0x811c9dc5;
    const n = Math.min(text.length, 200);
    for (let i = 0; i < n; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function getOverride(text) {
    if (!text) return null;
    return overrides.get(hashText(text)) || null;
  }

  function setOverride(text, dir) {
    overrides.set(hashText(text), dir);
  }

  function isCodey(el) {
    const t = el.tagName;
    return t === "PRE" || t === "CODE";
  }

  // Compute the target direction using the current mode. Async because
  // CLD3 is a callback API.
  function computeTarget(el, cb) {
    const text = el.textContent;

    // Overrides win over everything, in every mode.
    const overrideDir = getOverride(text);
    if (overrideDir) { cb(overrideDir); return; }

    if (mode === "auto") { cb(null); return; }
    if (mode === "always") {
      cb(hasAnyPersian(text) ? "rtl" : null);
      return;
    }

    // Smart mode: multi-signal vote. Persian is required — an all-Latin
    // paragraph is left alone.
    if (!hasAnyPersian(text)) { cb(null); return; }

    const isCode = isCodey(el);
    const heur = detectHeuristic(text, isCode);
    const ctx = detectContext();
    detectCLD3(text, function (cld3) {
      // Vote. CLD3 has weight 2 because it is the most accurate signal.
      let r = 0, l = 0;
      if (cld3 === "rtl") r += 2; else if (cld3 === "ltr") l += 2;
      if (heur === "rtl") r += 1; else if (heur === "ltr") l += 1;
      if (ctx === "rtl") r += 1; else if (ctx === "ltr") l += 1;
      if (r === 0 && l === 0) { cb("rtl"); return; }
      cb(r >= l ? "rtl" : "ltr");
    });
  }

  function applyMarkTo(el, target) {
    const current = el.getAttribute(MARK);
    if (current === target) return;
    if (target === null) {
      if (current) el.removeAttribute(MARK);
      // Clean up inline styles we set below.
      el.style.removeProperty("direction");
      el.style.removeProperty("text-align");
      return;
    }
    el.setAttribute(MARK, target);
    // Belt-and-suspenders: also write direction/text-align as inline
    // styles with !important. Some sites set inline direction on their
    // own elements, which would otherwise beat our external CSS. Inline
    // !important is the strongest override we can apply from JS.
    el.style.setProperty("direction", target, "important");
    el.style.setProperty("text-align", target === "rtl" ? "right" : "left", "important");
    if (target === "rtl") ctxRtl++;
    else if (target === "ltr") ctxLtr++;
  }

  function markOne(el) {
    if (el.closest && el.closest(INPUT_SKIP)) return;
    computeTarget(el, function (target) {
      if (!el.isConnected) return;
      // Re-check override in case the user flipped this paragraph while
      // CLD3 was still async. Overrides always win.
      const overrideDir = getOverride(el.textContent);
      if (overrideDir) target = overrideDir;
      applyMarkTo(el, target);
      wrapLatinInBdi(el);
    });
  }

  function processNode(root) {
    if (!root || root.nodeType !== 1 || !root.isConnected) return;
    if (root.matches && root.matches(SEL)) markOne(root);
    const list = root.querySelectorAll ? root.querySelectorAll(SEL) : null;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) markOne(list[i]);
  }

  function drain(deadline) {
    scheduled = false;
    while (queue.length && deadline.timeRemaining() > 1) {
      const n = queue.shift();
      queued.delete(n);
      processNode(n);
    }
    if (queue.length) schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    rIC(drain, { timeout: 500 });
  }

  function enqueue(node) {
    if (!node || queued.has(node)) return;
    queued.add(node);
    queue.push(node);
    schedule();
  }

  function enqueueHost(node) {
    if (!node) return;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return;
    if (el.tagName === "BDI" && el.getAttribute(ISO_ATTR) === "1") return;
    if (el.closest("bdi[" + ISO_ATTR + "=\"1\"]")) return;
    const host = el.closest(SEL);
    if (host) enqueue(host);
  }

  function onMutations(muts) {
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === "childList") {
        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType === 1) {
            if (n.tagName === "BDI" && n.getAttribute(ISO_ATTR) === "1") continue;
            if (n.id === BTN_ID) continue;
            enqueue(n);
          } else if (n.nodeType === 3) {
            enqueueHost(m.target);
          }
        }
      } else if (m.type === "characterData") {
        enqueueHost(m.target);
      }
    }
  }

  function startObserver() {
    if (observing || !document.body) return;
    observing = true;
    enqueue(document.body);
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
  }

  function waitForBody(fn) {
    if (document.body) return fn();
    const mo = new MutationObserver(function () {
      if (document.body) { mo.disconnect(); fn(); }
    });
    mo.observe(document.documentElement, { childList: true });
  }

  function applyMode(m) {
    mode = m;
    ctxRtl = 0;
    ctxLtr = 0;
    ensureStyle();
    document.documentElement.classList.add(CLASS_RTL);
    if (document.body) { startObserver(); enqueue(document.body); }
    else waitForBody(function () { startObserver(); });
  }

  function applyFont(on) {
    fontOn = !!on;
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_FONT, fontOn);
  }

  // ------- Selection-based flip button (per-paragraph manual override) -------

  let flipBtn = null;
  let btnTarget = null;
  let selectionScheduled = false;

  let mousedownTarget = null;

  function ensureFlipBtn() {
    if (flipBtn && flipBtn.isConnected) return;
    flipBtn = document.createElement("button");
    flipBtn.id = BTN_ID;
    flipBtn.title = "تغییر جهت پاراگراف";
    flipBtn.setAttribute("aria-label", "تغییر جهت پاراگراف");
    // Crisp SVG icon — a symmetric "swap horizontal" that reads as
    // direction change on both sides of the button.
    flipBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/>' +
      '<path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';
    // Grab the target at mousedown, BEFORE any selectionchange from the
    // click can null-out btnTarget by hiding the button.
    flipBtn.addEventListener("mousedown", function (e) {
      mousedownTarget = btnTarget;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    flipBtn.addEventListener("click", onFlipClick, true);
    document.body.appendChild(flipBtn);
  }

  function hideFlipBtn() {
    if (flipBtn) flipBtn.classList.remove("on");
    btnTarget = null;
  }

  function positionAtSelection(rect, targetEl) {
    ensureFlipBtn();
    const btnW = 34, btnH = 34;
    const pRect = targetEl.getBoundingClientRect();
    // Horizontal: just outside the paragraph's right edge. This is
    //   - never on top of the text
    //   - never colliding with ChatGPT's own selection popup (that lands
    //     centered above the selection)
    //   - the "start" side for Persian readers, so the button lands where
    //     the eye naturally scans first
    // If the paragraph reaches the viewport's right edge, tuck the button
    // just inside instead.
    let left = pRect.right + 8;
    if (left + btnW > window.innerWidth - 4) {
      left = window.innerWidth - btnW - 4;
    }
    // Vertical: aligned with the selection's own vertical center.
    let top = rect.top + rect.height / 2 - btnH / 2;
    top = Math.max(4, Math.min(window.innerHeight - btnH - 4, top));
    flipBtn.style.setProperty("top", top + "px", "important");
    flipBtn.style.setProperty("left", left + "px", "important");
    flipBtn.classList.add("on");
    btnTarget = targetEl;
  }

  function onFlipClick(e) {
    e.stopPropagation();
    e.preventDefault();
    const target = mousedownTarget || btnTarget;
    mousedownTarget = null;
    if (!target || !target.isConnected) return;
    const text = target.textContent;
    // Default the "current" side to LTR when nothing is marked, so the
    // first flip always produces RTL — matches the Persian-first intent.
    const current = target.getAttribute(MARK) === "rtl" ? "rtl" : "ltr";
    const flipped = current === "rtl" ? "ltr" : "rtl";
    setOverride(text, flipped);
    applyMarkTo(target, flipped);
    // Force a synchronous style recompute so the direction change is
    // painted this frame instead of on the next mouse-idle tick.
    void target.offsetWidth;
    guardFlip(target, flipped);
    hideFlipBtn();
    try { document.getSelection().removeAllRanges(); } catch (_) {}
  }

  // If a framework re-render happens right after our click and undoes our
  // attribute/inline style, we re-apply the next frame. This ONLY runs
  // while the fix is actually needed — a stable paragraph produces zero
  // repaint cost after the initial click.
  function guardFlip(el, dir, retriesLeft) {
    if (typeof retriesLeft !== "number") retriesLeft = 6;
    if (!el.isConnected || retriesLeft <= 0) return;
    requestAnimationFrame(function () {
      if (!el.isConnected) return;
      const needAttr = el.getAttribute(MARK) !== dir;
      const needStyle =
        el.style.getPropertyValue("direction") !== dir ||
        el.style.getPropertyPriority("direction") !== "important";
      if (needAttr || needStyle) {
        applyMarkTo(el, dir);
        guardFlip(el, dir, retriesLeft - 1);
      }
    });
  }

  function handleSelection() {
    const sel = document.getSelection && document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideFlipBtn();
      return;
    }
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node) { hideFlipBtn(); return; }
    // Target the TIGHTEST paragraph-level container the user's selection
    // sits inside — the individual <li>, <p>, <td> etc. — not some outer
    // <ul> or wrapper. That way flipping a single answer in a list only
    // flips that one line.
    const target = node.closest && node.closest(SEL);
    if (!target || target.closest(INPUT_SKIP)) { hideFlipBtn(); return; }
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideFlipBtn();
      return;
    }
    positionAtSelection(rect, target);
  }

  function onSelectionChange() {
    if (selectionScheduled) return;
    selectionScheduled = true;
    requestAnimationFrame(function () {
      selectionScheduled = false;
      handleSelection();
    });
  }

  // ------- Copy handler (strip legacy LRI/PDI markers) -------

  const ISO_STRIP_RE = /[⁦-⁩]/g;
  function onCopy(e) {
    try {
      const sel = document.getSelection && document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const text = sel.toString();
      if (!ISO_STRIP_RE.test(text)) return;
      ISO_STRIP_RE.lastIndex = 0;
      if (!e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text.replace(ISO_STRIP_RE, ""));
      try {
        const c = document.createElement("div");
        for (let i = 0; i < sel.rangeCount; i++) {
          c.appendChild(sel.getRangeAt(i).cloneContents());
        }
        e.clipboardData.setData("text/html", c.innerHTML.replace(ISO_STRIP_RE, ""));
      } catch (_) {}
    } catch (_) {}
  }

  // ------- Wire everything up -------

  document.addEventListener("selectionchange", onSelectionChange, true);
  // Hide the button when the user scrolls or clicks somewhere else that
  // doesn't produce a selection.
  window.addEventListener("scroll", hideFlipBtn, true);
  document.addEventListener("copy", onCopy, true);

  chrome.storage.sync.get(
    { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_OLD_RTL]: true },
    function (res) {
      let m = res[KEY_MODE];
      if (!m) {
        m = res[KEY_OLD_RTL] === false ? "auto" : "smart";
        chrome.storage.sync.set({ [KEY_MODE]: m });
      }
      applyMode(m);
      applyFont(res[KEY_FONT] === true);
    }
  );

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    if (changes[KEY_MODE]) applyMode(changes[KEY_MODE].newValue || "smart");
    if (changes[KEY_FONT]) applyFont(changes[KEY_FONT].newValue === true);
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== "farsi-toggle") return;
    if ("mode" in msg) applyMode(msg.mode);
    if ("font" in msg) applyFont(msg.font);
    if (sendResponse) sendResponse({ ok: true });
  });
})();
