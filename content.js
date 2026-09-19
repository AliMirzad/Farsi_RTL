/*
 * Farsi_RTL — v1.15
 *
 * Direction (word-based):
 *   Regular text (p, li, ...):  Persian >= Latin -> RTL; else -> LTR;
 *                               no Persian -> not marked
 *   Preformatted (pre, code):   Persian STRICTLY > Latin -> RTL;
 *                               else not marked (real code stays LTR)
 *
 * Bidi isolation of Latin runs is done with <bdi> element wrapping — NOT
 * with LRI/PDI text markers. This means:
 *
 *   - Zero invisible characters ever land in the DOM's text content.
 *   - Copying, pasting, screen readers, external tools all see clean text.
 *   - Bidi isolation is provided by <bdi>'s default `unicode-bidi: isolate`
 *     (a browser feature specifically for this problem).
 *
 * The user's typing area (contenteditable, textarea) is never touched —
 * no direction mark, no bdi wrapping. Their prompt stays pristine.
 *
 * A cleanup pass also strips any leftover LRI/PDI from earlier extension
 * versions out of visible text nodes, so old chats become clean too.
 */

(function () {
  const KEY_RTL = "rtlEnabled";
  const KEY_FONT = "fontEnabled";
  const CLASS_RTL = "farsi-rtl-on";
  const CLASS_FONT = "farsi-font-on";
  const MARK = "data-farsi-rtl";
  const ISO_ATTR = "data-farsi-iso";

  const SEL =
    "p,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd," +
    "figcaption,summary,pre,code";

  const INPUT_SKIP =
    'textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[contenteditable="plaintext-only"]';

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

    // Our <bdi> wrappers explicitly LTR — isolates the Latin run inside a
    // parent that might be RTL. The `all: unset` first prevents inherited
    // display/font-weight from clobbering the token's rendering.
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
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;}";

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

  // Latin identifier only — letters, digits, dots and underscores inside an
  // alphanumeric-terminated body, plus an optional trailing `(...)` for
  // method-call syntax like `Level.lvl()`.
  //
  // Brackets and punctuation OUTSIDE this pattern (`A)`, `Object،`, etc.)
  // are intentionally left to the browser's native bidi algorithm. The
  // browser will mirror them and place them per the paragraph direction —
  // which for a Persian reader means `A)` renders as `A(` visually, with
  // A on the right (read first) and the mirrored paren after it. That is
  // the expected Persian reading order.
  const LATIN_RUN =
    /[A-Za-z](?:[A-Za-z0-9._]*[A-Za-z0-9])?(?:\([^()]*\))?/g;

  // Any leftover isolate control chars from earlier versions of this
  // extension (LRI, RLI, FSI, PDI). We strip these from the DOM as we walk.
  const OLD_ISOLATE_CHARS = /[⁦-⁩]/g;

  function wrapLatinInBdi(root) {
    // Collect target text nodes first, then mutate — this avoids the
    // walker seeing our own inserted <bdi> elements during traversal.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest && parent.closest(INPUT_SKIP)) continue;
      // Already inside one of our wrappers — nothing to do.
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
      else if (hasOld) {
        // No Latin to wrap but we still need to drop the old isolate chars.
        node.data = text;
        mutated = true;
      }
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
      if (m.index > lastIndex) {
        pieces.push({ text: text.slice(lastIndex, m.index), iso: false });
      }
      pieces.push({ text: m[0], iso: true });
      lastIndex = LATIN_RUN.lastIndex;
    }
    if (!pieces.some(function (p) { return p.iso; })) return false;
    if (lastIndex < text.length) {
      pieces.push({ text: text.slice(lastIndex), iso: false });
    }
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

  function detectDirection(text, strict) {
    if (!text) return null;
    let p = 0, l = 0;
    let wordHasPersian = false;
    let wordHasLatin = false;
    let inWord = false;
    // Last strong-character class we saw: 0 = neither, 1 = Persian, 2 = Latin.
    // Used as a tiebreaker for Latin-majority sentences that end in Persian
    // (e.g. "Wrapper Class چیست؟" — the ending "چیست" makes it a Persian
    // question and it should render RTL).
    let lastStrong = 0;

    for (let i = 0; i <= text.length; i++) {
      const c = i < text.length ? text.charCodeAt(i) : 32;
      const isSpace =
        c === 32 || c === 9 || c === 10 || c === 13 ||
        c === 0x00A0 || c === 0x2028 || c === 0x2029;
      if (isSpace) {
        if (inWord) {
          // A word with ANY Persian character counts as Persian.
          if (wordHasPersian) p++;
          else if (wordHasLatin) l++;
        }
        inWord = false;
        wordHasPersian = false;
        wordHasLatin = false;
        continue;
      }
      inWord = true;
      const isPersian =
        (c >= 0x0600 && c <= 0x06FF) ||
        (c >= 0x0750 && c <= 0x077F) ||
        (c >= 0x08A0 && c <= 0x08FF) ||
        (c >= 0xFB50 && c <= 0xFDFF) ||
        (c >= 0xFE70 && c <= 0xFEFF);
      const isLatin = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (isPersian) {
        wordHasPersian = true;
        lastStrong = 1;
      } else if (isLatin) {
        wordHasLatin = true;
        lastStrong = 2;
      }
    }

    if (p === 0) return null;
    if (strict) return p > l ? "rtl" : "ltr";
    // Non-strict rule: RTL if EITHER
    //   (a) Persian is at least ~1/3 of the strong words (p*2 >= l), OR
    //   (b) the sentence ends in Persian.
    // This covers Persian sentences that use many English technical terms:
    //   "تبدیل Primitive به Wrapper → Boxing"  (2P, 3L, ends Latin)  -> RTL
    //   "Wrapper Class چیست؟"                (1P, 2L, ends Persian) -> RTL
    //   "I prefer «شرط ثابت» ... term"         (4P, 12L, ends Latin) -> LTR
    if (p * 2 >= l) return "rtl";
    return lastStrong === 1 ? "rtl" : "ltr";
  }

  function isCodey(el) {
    const t = el.tagName;
    return t === "PRE" || t === "CODE";
  }

  function markOne(el) {
    if (el.closest && el.closest(INPUT_SKIP)) return;
    const current = el.getAttribute(MARK);
    const target = detectDirection(el.textContent, isCodey(el));
    if (!target) return;
    if (current !== target) el.setAttribute(MARK, target);
    wrapLatinInBdi(el);
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
    // Ignore mutations we ourselves caused inside a bdi wrapper.
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
            // Don't re-enqueue our own bdi insertions.
            if (n.tagName === "BDI" && n.getAttribute(ISO_ATTR) === "1") continue;
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
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function waitForBody(fn) {
    if (document.body) return fn();
    const mo = new MutationObserver(function () {
      if (document.body) {
        mo.disconnect();
        fn();
      }
    });
    mo.observe(document.documentElement, { childList: true });
  }

  // Belt-and-suspenders: if any stale LRI/PDI is still hanging around in
  // the DOM (from earlier versions before we removed them), clean the
  // clipboard on copy so the user never pastes them anywhere.
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
  document.addEventListener("copy", onCopy, true);

  function applyRtl(on) {
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_RTL, !!on);
    if (document.body) startObserver();
    else waitForBody(startObserver);
  }

  function applyFont(on) {
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_FONT, !!on);
    if (document.body) startObserver();
    else waitForBody(startObserver);
  }

  chrome.storage.sync.get(
    { [KEY_RTL]: true, [KEY_FONT]: false },
    function (res) {
      applyRtl(res[KEY_RTL] !== false);
      applyFont(res[KEY_FONT] === true);
    }
  );

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    if (changes[KEY_RTL])  applyRtl(changes[KEY_RTL].newValue !== false);
    if (changes[KEY_FONT]) applyFont(changes[KEY_FONT].newValue === true);
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== "farsi-toggle") return;
    if ("rtl"  in msg) applyRtl(msg.rtl);
    if ("font" in msg) applyFont(msg.font);
    if (sendResponse) sendResponse({ ok: true });
  });
})();
