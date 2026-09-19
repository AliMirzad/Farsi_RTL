/*
 * Farsi_RTL — content script
 *
 * Three direction modes chosen from the popup:
 *   - "always" : any Persian character in the paragraph -> RTL
 *   - "smart"  : character-ratio + first-strong decision (see decideSync)
 *   - "auto"   : never override direction; only isolate risky Latin runs
 *
 * DESIGN NOTE — why this file is careful about WHEN it touches the DOM
 * -------------------------------------------------------------------
 * ChatGPT and Claude render their answers with React. React keeps direct
 * references to the exact text nodes it created. If we replace one of
 * those text nodes (which is what <bdi> wrapping does) while the answer is
 * still streaming, React's next commit writes to a node that is no longer
 * in the document, or calls insertBefore() with a reference node we
 * detached. That throws, the markdown subtree dies, and the whole answer
 * collapses into one unparsed blob of raw markdown — the "متن می‌ریزه
 * پشت هم" bug that forced a page refresh.
 *
 * So the rules are:
 *   1. Direction marking (an attribute + two inline styles) is safe at any
 *      time — it never restructures children. It happens immediately.
 *   2. Any structural change (splitting a text node into <bdi> pieces)
 *      happens ONLY when the element has been textually quiet for
 *      STREAM_QUIET_MS *and* no answer is streaming anywhere on the page.
 *   3. <pre> and <code> subtrees are never restructured at all. Syntax
 *      highlighters own that DOM and rebuild it constantly.
 *
 * Every paragraph respects a session-only user override: select any text
 * inside a paragraph, click the floating ⇄ button, and that paragraph
 * alone flips. A refresh wipes overrides.
 */

(function () {
  "use strict";

  const KEY_MODE = "rtlMode";
  const KEY_FONT = "fontEnabled";
  const KEY_OLD_RTL = "rtlEnabled";

  const CLASS_RTL = "farsi-rtl-on";
  const CLASS_FONT = "farsi-font-on";
  const MARK = "data-farsi-rtl";
  const ISO_ATTR = "data-farsi-iso";
  const BTN_ID = "farsi-flip-btn";

  // `code:not(pre code)` keeps every <code> inside a code block out of the
  // query entirely: those must follow their <pre>'s direction, so matching
  // them only to reject them later was wasted work on every sweep.
  const SEL =
    "p,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd," +
    "figcaption,summary,pre,code:not(pre code)";

  const INPUT_SKIP =
    'textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[contenteditable="plaintext-only"]';

  // Subtrees we never restructure. Highlighters rebuild these constantly
  // and their layout depends on exact text-node boundaries.
  const WRAP_SKIP = "pre, code, " + INPUT_SKIP;

  // Site markers that mean "an answer is being generated right now".
  // Deliberately loose: these are a fast hint, not the only guard. If a
  // site renames every one of them the mutation-activity meter below still
  // catches the stream, so nothing here is load-bearing.
  const STREAM_MARKERS =
    '[data-is-streaming="true"], [data-streaming="true"], ' +
    '[data-message-streaming="true"], [class*="streaming"], ' +
    'button[data-testid*="stop"], button[aria-label*="Stop"], ' +
    'button[aria-label*="stop"]';

  // ---- tuning knobs -------------------------------------------------
  const STREAM_QUIET_MS = 450;  // element must be textually still this long
  const FRAME_BUDGET_MS = 8;    // work budget for one drain slice
  const MIN_BATCH = 24;         // always process at least this many nodes
  const STREAM_CACHE_MS = 150;  // how long the streaming probe is cached
  const HOT_MIN_MS = 120;       // min gap between visits to one element
  const FREEZE_LEN = 240;       // chars after which a direction is settled

  let mode = "smart";

  // Bumped whenever the mode changes. Baked into every cache key so a mode
  // switch invalidates all per-element bookkeeping at once.
  let epoch = 0;

  // Session-only manual overrides, keyed by a hash of the paragraph text.
  const overrides = new Map();

  // Per-element bookkeeping. One object per element rather than five
  // WeakMap lookups per visit, and all signatures are plain numbers so a
  // visit allocates nothing.
  //   ep    epoch this state belongs to (mode switches invalidate)
  //   sig   signature of the text last seen
  //   hot   timestamp the text last changed
  //   dir   signature the direction was decided at
  //   wrap  signature the bdi pass ran at
  //   visit timestamp of the last visit (throttles streaming re-entry)
  //   done  1 once fully processed; cleared by any mutation
  //   skip  cached "inside an input" / "is a <pre><code>" verdicts
  const stateMap = new WeakMap();

  function stateOf(el) {
    let st = stateMap.get(el);
    if (st === undefined) {
      st = { ep: epoch, sig: -1, hot: 0, dir: -1, wrap: -1, visit: -1e9,
             done: 0, skip: -1, preCode: -1, mark: undefined, len: 0 };
      stateMap.set(el, st);
    } else if (st.ep !== epoch) {
      st.ep = epoch; st.dir = -1; st.wrap = -1; st.done = 0;
    }
    return st;
  }

  function markDirty(el) {
    const st = stateMap.get(el);
    if (st !== undefined) st.done = 0;
  }

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

    // Inline code (NOT the <code> inside a <pre>) that sits inside a marked
    // container without its own mark: force LTR so technical identifiers
    // read correctly inside a Persian sentence.
    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] code:not(pre code):not([" + MARK + "])," +
    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"] code:not(pre code):not([" + MARK + "]){" +
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

  const now =
    (window.performance && performance.now)
      ? function () { return performance.now(); }
      : function () { return Date.now(); };

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

  // ------------------------- text analysis -------------------------

  const ARROWS = "\\u2190-\\u21FF\\u27F0-\\u27FF\\u2900-\\u297F";

  // A Latin run kept together in ONE <bdi>: letters, digits, identifier
  // punctuation, code punctuation, all four bracket pairs, spaces (so
  // "active != null" stays one L block) and arrows. The run must end on an
  // alphanumeric or a closing bracket so trailing spaces / Persian
  // punctuation don't sneak in. The second alternative catches standalone
  // arrow sequences like "چپ ← راست".
  const LATIN_RUN = new RegExp(
    "[\\[({]?[A-Za-z](?:[A-Za-z0-9._,;:=!<>+*/%&|?~^#\\[\\](){} " + ARROWS + "\\-]*" +
    "[A-Za-z0-9\\]})])?|[" + ARROWS + "]+",
    "g"
  );

  // Only runs containing one of these actually need an isolate. A plain
  // word or a multi-word phrase made of letters, digits, dots and hyphens
  // is already ordered correctly by the browser's own bidi algorithm
  // (rule N1), so wrapping it is pure DOM churn with no visual benefit —
  // and DOM churn is what breaks the site's renderer.
  const NEEDS_ISO = new RegExp("[\\[\\](){}<>=!+*/%&|?~^#;:," + ARROWS + "]");

  const HAS_WRAPPABLE = new RegExp("[A-Za-z" + ARROWS + "]");
  const OLD_ISOLATE_CHARS = /[⁦-⁩]/g;

  const P_RANGES = [
    [0x0600, 0x06FF], [0x0750, 0x077F], [0x08A0, 0x08FF],
    [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]
  ];

  function isPersianCode(c) {
    // Fast path: almost every character in these pages is either ASCII
    // (below 0x0600) or in the main Arabic block, so two compares settle
    // it before the range loop is ever entered.
    if (c < 0x0600) return false;
    if (c <= 0x06FF) return true;
    for (let i = 1; i < P_RANGES.length; i++) {
      if (c >= P_RANGES[i][0] && c <= P_RANGES[i][1]) return true;
    }
    return false;
  }

  function hasAnyPersian(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i++) {
      if (isPersianCode(text.charCodeAt(i))) return true;
    }
    return false;
  }

  // One pass over the text collecting every signal we need:
  //   pChars / lChars — strong character counts
  //   pWords / lWords — word counts (one long identifier counts once)
  //   first           — 1 if the first strong char is Persian, 2 if Latin
  //   woven           — true when Persian appears BETWEEN two Latin runs
  function scanText(text) {
    let pChars = 0, lChars = 0, pWords = 0, lWords = 0, first = 0;
    let wordP = false, wordL = false, inWord = false;
    let sawL = false, pAfterL = false, woven = false;
    const len = text ? text.length : 0;
    for (let i = 0; i <= len; i++) {
      const c = i < len ? text.charCodeAt(i) : 32;
      const isSpace = c === 32 || c === 9 || c === 10 || c === 13 ||
        c === 0x00A0 || c === 0x2028 || c === 0x2029;
      if (isSpace) {
        if (inWord) {
          if (wordP) pWords++;
          else if (wordL) lWords++;
        }
        inWord = false; wordP = false; wordL = false;
        continue;
      }
      inWord = true;
      if (isPersianCode(c)) {
        pChars++; wordP = true;
        if (first === 0) first = 1;
        if (sawL) pAfterL = true;
      } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        lChars++; wordL = true;
        if (first === 0) first = 2;
        if (pAfterL) woven = true;
        sawL = true;
      }
    }
    return { pChars: pChars, lChars: lChars, pWords: pWords, lWords: lWords,
             first: first, woven: woven };
  }

  /*
   * The direction decision: synchronous, deterministic, four rules.
   *
   * The question is never "which language has more of this paragraph". It
   * is "which language is the paragraph WRITTEN IN" — the matrix language.
   * Persian technical writing is Persian prose with English terms dropped
   * into it, and an English term is one token no matter how long it is.
   * Any rule that weighs characters treats `isAnnotationPresent()` as
   * nineteen votes for English and «متد» as three for Persian, which is
   * why that line came out backwards while «متد getClass()» came out
   * right. Same sentence, different answer, purely because of identifier
   * length. That is the fragility, not the threshold.
   *
   * Two changes remove it:
   *
   *   a) Inline code and URLs are excluded before counting (see proseOf).
   *      In these answers most of the English lives inside backticks, so
   *      after this the prose is usually unambiguous on its own.
   *
   *   b) What is left is judged by rules that are scale-free — they do not
   *      care how long a word is:
   *
   *        1. no Persian in the prose      -> leave the element alone
   *        2. no Latin in the prose        -> RTL
   *        3. the prose STARTS in Persian  -> RTL
   *           (this is exactly the first-strong rule behind HTML's
   *            dir="auto"; a sentence opens in its own language)
   *        4. Persian words >= Latin words -> RTL
   *           (words, not characters, so one long identifier counts once)
   *        5. Persian sits BETWEEN two Latin runs -> RTL
   *        6. otherwise                    -> LTR
   *
   * Rule 5 is the answer to "Compile Time و Runtime". A Persian word
   * wedged between two Latin ones is not an object the sentence is
   * talking about, it is the joint the sentence is built on — «و» there
   * is doing the same structural work "and" does in English. A language
   * only supplies connectives to a sentence it owns, so wherever Persian
   * is woven through the Latin rather than sitting at one end of it, the
   * sentence is Persian. No word list is needed to see this: it is
   * position, not vocabulary. Both orders read correctly (bidi keeps each
   * Latin run internally left-to-right either way), but only RTL puts the
   * line where a Persian reader's eye starts and aligns it with every
   * other line in the answer.
   *
   * That leaves rule 6 for prose that opens in Latin, is mostly Latin
   * words, AND keeps its Persian at the tail — «The Persian word for
   * runtime is زمان اجرا», where the Persian really is the object being
   * quoted. That is the only shape that still reads left to right.
   *
   * There is no confidence score and no async second opinion, so the same
   * paragraph always gets the same answer, on every page and every load.
   */
  function decideSync(s) {
    if (s.pChars === 0) return null;
    if (s.lChars === 0) return "rtl";
    if (s.first === 1) return "rtl";
    if (s.pWords >= s.lWords) return "rtl";
    if (s.woven) return "rtl";
    return "ltr";
  }

  // Text that does NOT count toward the language decision. An identifier
  // inside `backticks` is a foreign object embedded in the sentence, not
  // the language the sentence is written in — the same way a phone number
  // in an English paragraph doesn't make that paragraph "numeric". URLs
  // are the same kind of object.
  const PROSE_SKIP = "code, pre, kbd, samp, var, math, svg";
  const URL_RE = /\b(?:https?:\/\/|www\.)\S+/g;

  // The sentence as a reader sees it, minus embedded code and URLs. The
  // fast path (no code descendants) costs one querySelector.
  function proseOf(el, full) {
    let text = full;
    if (el.querySelector && el.querySelector(PROSE_SKIP)) {
      let walker;
      try {
        walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      } catch (_) { return full.replace(URL_RE, " "); }
      const parts = [];
      let n, memoPar = null, memoSkip = false;
      while ((n = walker.nextNode())) {
        const par = n.parentElement;
        if (!par) continue;
        // Consecutive text nodes almost always share a parent, so one
        // memo slot removes nearly every closest() walk here.
        if (par !== memoPar) {
          memoPar = par;
          memoSkip = !!(par.closest && par.closest(PROSE_SKIP));
        }
        if (memoSkip) continue;
        parts.push(n.data);
      }
      text = parts.join(" ");
      // A paragraph that is nothing but code has no prose to judge; fall
      // back to the full text so it is not silently left unmarked.
      if (!text.trim()) text = full;
    }
    return text.replace(URL_RE, " ");
  }

  // A list element's textContent is the concatenation of every item, so
  // scanning it in full means each <li> is scanned again for its <ul>,
  // and again for any enclosing <li> — quadratic on a long answer. A list
  // takes the direction of its items, so the first item decides it.
  function sampleText(el) {
    const tag = el.tagName;
    if (tag === "UL" || tag === "OL") {
      const first = el.firstElementChild;
      if (first) return first.textContent || "";
    }
    return el.textContent || "";
  }

  // Strict word-count rule for code blocks: Persian words must strictly
  // outnumber Latin ones before a code block flips.
  function codeDirection(text) {
    const s = scanText(text);
    if (s.pChars === 0) return null;
    return s.pWords > s.lWords ? "rtl" : "ltr";
  }

  // ------------------------- signatures -------------------------

  function fnv(text, cap) {
    let h = 0x811c9dc5;
    const n = Math.min(text.length, cap);
    for (let i = 0; i < n; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // Override keys hash only the first 200 chars so a streaming paragraph
  // that grows doesn't lose the flip the user applied to it.
  function hashText(text) { return fnv(text, 200); }

  // Change detector for an element's text. Hashing a whole 4000-character
  // answer on every token was the single most expensive thing this script
  // did; length plus the first and last 128 characters moves on any edit
  // that matters (a stream only ever grows) at a fixed ~256 operations,
  // and it returns a number, so comparing costs nothing either.
  const SIG_SAMPLE = 128;

  function computeSig(text) {
    const n = text.length;
    let h = (0x811c9dc5 ^ n) >>> 0;
    const head = n < SIG_SAMPLE ? n : SIG_SAMPLE;
    for (let i = 0; i < head; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    let tail = n - SIG_SAMPLE;
    if (tail < head) tail = head;
    for (let i = tail; i < n; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function getOverride(text) {
    if (!text) return null;
    return overrides.get(hashText(text)) || null;
  }

  function setOverride(text, dir) {
    overrides.set(hashText(text), dir);
  }

  // ------------------------- streaming probe -------------------------

  let streamCacheAt = -1e9;
  let streamCacheVal = false;
  let streamSince = 0;

  // True while the site says an answer is being generated. Cached briefly
  // because this runs on every queued element.
  //
  // Deliberately a whole-page signal rather than a per-element one. A
  // reasoning answer pauses for many seconds between bursts ("Worked for
  // 20s"), which the per-element quiet timer alone would read as
  // "settled" — and restructuring a paragraph that is about to receive
  // more tokens is exactly what breaks the renderer.
  //
  // STALL GUARD: if a site ever ships markup that keeps one of these
  // selectors permanently matched, the bdi pass must not be disabled
  // forever, so the signal expires after five minutes.
  // Site-agnostic backstop: a page that is rewriting its own DOM many
  // times a second is producing something. One entry per observer batch
  // (roughly one per frame), so streaming scores far above the threshold
  // while a ticking clock or a spinner scores well below it.
  const MUT_RING = 64;
  const mutTimes = new Float64Array(MUT_RING);
  let mutHead = 0;      // next slot to write
  let mutCount = 0;     // how many slots are valid
  const BUSY_WINDOW_MS = 1200;
  const BUSY_BATCHES = 8;

  let domVersion = 0;

  function noteMutationBatch(t) {
    domVersion++;
    mutTimes[mutHead] = t;
    mutHead = (mutHead + 1) % MUT_RING;
    if (mutCount < MUT_RING) mutCount++;
  }

  // Has anything at all changed on the page very recently? Used to decide
  // whether an element we are seeing for the first time might still be
  // growing, or is part of an already-rendered conversation.
  function recentMutation(t) {
    if (mutCount === 0) return false;
    return t - mutTimes[(mutHead + MUT_RING - 1) % MUT_RING] < 800;
  }

  function isPageBusy(t) {
    let n = 0;
    for (let k = 1; k <= mutCount; k++) {
      if (t - mutTimes[(mutHead + MUT_RING - k) % MUT_RING] > BUSY_WINDOW_MS) break;
      if (++n >= BUSY_BATCHES) return true;
    }
    return false;
  }

  function isPageStreaming(t) {
    if (t - streamCacheAt < STREAM_CACHE_MS) return streamCacheVal;
    streamCacheAt = t;
    if (isPageBusy(t)) { streamCacheVal = true; return true; }
    let v = false;
    try {
      const hits = document.querySelectorAll(STREAM_MARKERS);
      for (let i = 0; i < hits.length; i++) {
        const n = hits[i];
        // A stop button that is still in the DOM but not rendered (some
        // sites keep it around hidden) does not mean anything is
        // streaming. Data attributes are trusted as-is.
        if (n.hasAttribute("data-is-streaming") ||
            n.hasAttribute("data-message-streaming") ||
            n.getClientRects().length) { v = true; break; }
      }
    } catch (_) { v = false; }
    if (!v) streamSince = 0;
    else {
      if (streamSince === 0) streamSince = t;
      if (t - streamSince > 300000) v = false;   // stuck selector, ignore it
    }
    streamCacheVal = v;
    return v;
  }

  // ------------------------- applying -------------------------

  function applyMarkTo(el, target) {
    const current = el.getAttribute(MARK);
    if (target === null) {
      if (current) {
        el.removeAttribute(MARK);
        el.style.removeProperty("direction");
        el.style.removeProperty("text-align");
      }
      return;
    }
    if (current !== target) el.setAttribute(MARK, target);
    // Belt and suspenders: inline !important beats any inline direction
    // the site sets on its own elements.
    if (el.style.getPropertyValue("direction") !== target ||
        el.style.getPropertyPriority("direction") !== "important") {
      el.style.setProperty("direction", target, "important");
      el.style.setProperty("text-align", target === "rtl" ? "right" : "left", "important");
    }
  }

  function isCodey(el) {
    const t = el.tagName;
    return t === "PRE" || t === "CODE";
  }

  // Direction only — never restructures children, so this is safe to run
  // on a paragraph that is still streaming.
  function applyDirection(el, text) {
    const ov = getOverride(text);
    if (ov) { applyMarkTo(el, ov); return ov; }

    let dir;
    if (mode === "auto") dir = null;
    else if (isCodey(el)) dir = codeDirection(text);
    else if (mode === "always") dir = hasAnyPersian(text) ? "rtl" : null;
    else dir = decideSync(scanText(proseOf(el, text)));

    applyMarkTo(el, dir);
    return dir;
  }

  // ------------------------- bdi wrapping -------------------------

  function splitAndWrap(textNode, text) {
    if (!text) return false;
    if (!HAS_WRAPPABLE.test(text)) return false;

    LATIN_RUN.lastIndex = 0;
    const pieces = [];
    let lastIndex = 0;
    let m;
    let anyIso = false;
    while ((m = LATIN_RUN.exec(text))) {
      const run = m[0];
      const iso = NEEDS_ISO.test(run);
      if (!iso) { continue; }                      // browser handles it fine
      if (m.index > lastIndex) {
        pieces.push({ text: text.slice(lastIndex, m.index), iso: false });
      }
      pieces.push({ text: run, iso: true });
      anyIso = true;
      lastIndex = LATIN_RUN.lastIndex;
    }
    if (!anyIso) return false;
    if (lastIndex < text.length) {
      pieces.push({ text: text.slice(lastIndex), iso: false });
    }

    const parent = textNode.parentNode;
    if (!parent || !parent.isConnected) return false;

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
    // Re-check right before the swap: an async render may have moved the
    // node out from under us between the walk and here.
    if (textNode.parentNode !== parent) return false;
    try {
      parent.replaceChild(frag, textNode);
    } catch (_) {
      return false;
    }
    return true;
  }

  function wrapLatinInBdi(root) {
    // Never restructure code. Highlighters own that DOM.
    if (isCodey(root) || (root.closest && root.closest(WRAP_SKIP))) return;
    // A list holds no prose of its own; its items are visited separately.
    if (root.tagName === "UL" || root.tagName === "OL") return;

    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    } catch (_) { return; }

    const targets = [];
    let node, memoPar = null, memoSkip = false;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent !== memoPar) {
        memoPar = parent;
        // Skip code, and skip anything that belongs to a nested element
        // which will be walked on its own visit — otherwise a <li> inside
        // a <ul> inside a <li> is walked three times.
        memoSkip = !!(parent.closest &&
          (parent.closest(WRAP_SKIP) || parent.closest(SEL) !== root));
      }
      if (memoSkip) continue;
      if (parent.tagName === "BDI" && parent.getAttribute(ISO_ATTR) === "1") continue;
      const data = node.data;
      if (!data) continue;
      OLD_ISOLATE_CHARS.lastIndex = 0;
      const hasOld = OLD_ISOLATE_CHARS.test(data);
      OLD_ISOLATE_CHARS.lastIndex = 0;
      if (!hasOld && !HAS_WRAPPABLE.test(data)) continue;
      targets.push({ node: node, hasOld: hasOld });
    }

    const wrapping = root.getAttribute(MARK) !== "ltr";

    for (let i = 0; i < targets.length; i++) {
      const node = targets[i].node;
      const hasOld = targets[i].hasOld;
      if (!node.isConnected) continue;
      let text = node.data;
      if (hasOld) text = text.replace(OLD_ISOLATE_CHARS, "");
      // In an LTR paragraph Latin needs no isolate — only strip legacy
      // control characters and leave the DOM alone.
      if (wrapping && splitAndWrap(node, text)) continue;
      if (hasOld) { try { node.data = text; } catch (_) {} }
    }
  }

  // ------------------------- scheduling -------------------------

  const revisit = new Set();
  let revisitTimer = 0;

  function armRevisit() {
    if (revisitTimer) return;
    revisitTimer = setTimeout(flushRevisit, STREAM_QUIET_MS + 60);
  }

  // A deferred element can only become eligible once the page stops
  // producing — that is the same condition for all of them. So while a
  // stream is running there is no point walking the deferred set at all;
  // re-arm and check again later. Without this, every paragraph on screen
  // was re-examined twice a second for the whole length of an answer.
  function flushRevisit() {
    revisitTimer = 0;
    if (revisit.size === 0) return;
    if (isPageStreaming(now())) { armRevisit(); return; }
    const list = [];
    revisit.forEach(function (n) { list.push(n); });
    revisit.clear();
    for (let i = 0; i < list.length; i++) {
      if (list[i].isConnected) enqueue(list[i]);
    }
  }

  function scheduleRevisit(el) {
    revisit.add(el);
    armRevisit();
  }

  function markOne(el, t) {
    if (!el.isConnected) return;
    const st = stateOf(el);

    // Already finished at this epoch and nothing has mutated it since.
    // This is what makes the repeated safety-net sweeps over a long
    // conversation cost one WeakMap lookup per element instead of a
    // textContent read and a language scan.
    if (st.done === 1) return;

    if (st.skip === -1) {
      st.skip = (el.closest && el.closest(INPUT_SKIP)) ? 1 : 0;
    }
    if (st.skip === 1) { st.done = 1; return; }

    // A <code> inside a <pre> must follow the <pre>'s direction, never
    // carry one of its own, or flipping a code block leaves its contents
    // pointing the other way.
    if (st.preCode === -1) {
      st.preCode = (el.tagName === "CODE" && el.closest("pre")) ? 1 : 0;
    }
    if (st.preCode === 1) { st.done = 1; return; }

    // While an answer is streaming, a paragraph that already carries a
    // direction and has enough text for that decision to be stable needs
    // no further looks until the stream ends. This is the cheapest exit
    // in the file and the most valuable: it skips reading textContent,
    // which is the one genuinely expensive thing markOne does, on every
    // frame of every answer. A paragraph still waiting for its first
    // Persian character (mark === null) keeps being evaluated, so nothing
    // sits un-flipped while it is being written.
    if (st.mark && st.len >= FREEZE_LEN && isPageStreaming(t)) {
      scheduleRevisit(el);
      return;
    }

    // While tokens are arriving the observer fires roughly once a frame.
    // Re-reading and re-scanning the paragraph sixty times a second buys
    // nothing — the direction is already applied and structural work is
    // deferred regardless — so collapse those visits.
    if (t - st.visit < HOT_MIN_MS) { scheduleRevisit(el); return; }
    st.visit = t;

    const text = sampleText(el);
    st.len = text.length;
    const sig = computeSig(text);
    if (st.sig !== sig) {
      // First sight is not evidence of change. An element we have never
      // seen on a page where nothing has mutated recently belongs to an
      // already-rendered conversation, so it is settled and can be
      // finished in this one visit instead of being deferred and walked
      // again. If anything IS moving, treat it as still growing.
      st.hot = (st.sig === -1 && !recentMutation(t)) ? 0 : t;
      st.sig = sig;
    }

    if (st.dir !== sig) { st.dir = sig; st.mark = applyDirection(el, text); }

    // Structural work waits for calm. This is the fix for the collapsing
    // answer: while tokens are still arriving we touch nothing but the
    // element's own attribute and inline style.
    if (t - st.hot < STREAM_QUIET_MS || isPageStreaming(t)) {
      scheduleRevisit(el);
      return;
    }
    if (st.wrap !== sig) { st.wrap = sig; wrapLatinInBdi(el); }
    st.done = 1;
  }

  function processNode(root, t) {
    if (!root || root.nodeType !== 1 || !root.isConnected) return;
    if (flat.has(root)) {
      flat.delete(root);
      markOne(root, t);
      return;
    }
    if (root.matches && root.matches(SEL)) markOne(root, t);
    const list = root.querySelectorAll ? root.querySelectorAll(SEL) : null;
    if (!list || !list.length) return;
    // A big subtree is broken into individually queued elements so one
    // drain slice can never monopolise the main thread.
    if (list.length > 60) {
      for (let i = 0; i < list.length; i++) {
        const st = stateMap.get(list[i]);
        if (st !== undefined && st.done === 1 && st.ep === epoch) continue;
        enqueue(list[i], true);
      }
      return;
    }
    for (let i = 0; i < list.length; i++) markOne(list[i], t);
  }

  /*
   * The old drain() was:
   *     while (queue.length && deadline.timeRemaining() > 1) { ... }
   * When requestIdleCallback fires because its 500ms timeout expired,
   * timeRemaining() is 0, so that loop body never ran — it just
   * rescheduled itself forever. On a busy page (ChatGPT's own boot) the
   * browser never hands out idle time, so nothing was ever processed, and
   * the extension looked dead until you switched modes and the queue was
   * re-primed on a now-idle page. That is the "smart mode doesn't work
   * until you toggle it" bug.
   *
   * Now: a wall-clock budget, plus a guaranteed minimum batch so there is
   * always forward progress no matter how busy the page is.
   */
  function drain(deadline) {
    scheduled = false;
    const start = now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    let processed = 0;
    // One clock read per slice, not per element: a slice is at most
    // FRAME_BUDGET_MS long, which is well inside the tolerance of every
    // timestamp comparison downstream.
    while (queue.length) {
      if (processed >= MIN_BATCH) {
        if (now() - start > FRAME_BUDGET_MS) break;
        if (hasDeadline && !deadline.didTimeout && deadline.timeRemaining() <= 1) break;
      }
      const n = queue.shift();
      queued.delete(n);
      processNode(n, start);
      processed++;
    }
    if (queue.length) schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    rIC(drain, { timeout: 300 });
  }

  // Elements queued by a subtree expansion: their descendants were queued
  // by the same expansion, so processNode must not query them again.
  const flat = new Set();

  function enqueue(node, alreadyExpanded) {
    if (!node) return;
    if (queued.has(node)) {
      if (!alreadyExpanded) flat.delete(node);
      return;
    }
    queued.add(node);
    if (alreadyExpanded) flat.add(node);
    queue.push(node);
    schedule();
  }

  // One selector walk answers both questions at once: if our own <bdi> is
  // nearer than the paragraph, the mutation came from us and is ignored.
  const HOST_SEL = SEL + ",bdi[" + ISO_ATTR + "=\"1\"]";

  // During a stream the same element mutates dozens of times a second, so
  // a single memo slot removes almost every one of these selector walks.
  let hostMemoEl = null;
  let hostMemoRes = null;

  function enqueueHost(node, streaming) {
    if (!node) return;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return;
    if (el.id === BTN_ID) return;
    let host;
    if (el === hostMemoEl) {
      host = hostMemoRes;
    } else {
      host = el.closest(HOST_SEL);
      if (host && host.tagName === "BDI") host = null;
      hostMemoEl = el;
      hostMemoRes = host;
    }
    if (!host) return;
    const st = stateMap.get(host);
    if (st !== undefined) st.done = 0;
    // A paragraph that is frozen for the duration of the stream would
    // only be queued, scheduled, drained and then skipped. Going straight
    // on the deferred list instead removes the entire round trip — which,
    // once the freeze above is in place, is all that was left of the
    // per-frame cost of an answer being written.
    if (streaming === true && st !== undefined && st.mark && st.len >= FREEZE_LEN) {
      revisit.add(host);
      armRevisit();
      return;
    }
    // Self only: anything that changed inside it raised its own record.
    enqueue(host, true);
  }

  /*
   * The old onMutations relied on observer.takeRecords() inside the wrap
   * pass to swallow the records our own DOM surgery generated. That threw
   * away every OTHER pending record too — including real streaming updates
   * from the page — so paragraphs silently stopped being processed.
   *
   * Now nothing is discarded. Self-inflicted records are harmless because
   * markOne() compares a text signature first: our bdi surgery does not
   * change textContent, so a re-entry costs one hash and exits.
   */
  function onMutations(muts) {
    const t = now();
    noteMutationBatch(t);
    const streaming = isPageStreaming(t);
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === "childList") {
        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType === 1) {
            if (n.id === BTN_ID) continue;
            if (n.tagName === "BDI" && n.getAttribute(ISO_ATTR) === "1") continue;
            enqueue(n);
          }
        }
        // The host paragraph itself changed shape, so its direction has
        // to be reconsidered even when the added node is an element.
        enqueueHost(m.target, streaming);
      } else if (m.type === "characterData") {
        enqueueHost(m.target, streaming);
      }
    }
  }

  function startObserver() {
    if (observing || !document.body) return;
    observing = true;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
    enqueue(document.body);
  }

  function waitForBody(fn) {
    if (document.body) return fn();
    const mo = new MutationObserver(function () {
      if (document.body) { mo.disconnect(); fn(); }
    });
    mo.observe(document.documentElement, { childList: true });
  }

  // Safety-net sweeps are frequent (startup, tab return, route change,
  // stream end) and each one is a whole-document query. If the observer
  // has seen no mutation since the last sweep there is, by construction,
  // nothing new to find, so the sweep is skipped outright.
  let sweptVersion = -1;
  let sweptEpoch = -1;

  function rescan() {
    if (!document.body) return;
    if (domVersion === sweptVersion && epoch === sweptEpoch) return;
    sweptVersion = domVersion;
    sweptEpoch = epoch;
    enqueue(document.body);
  }

  // Safety net for slow / late-hydrating app shells: a handful of sweeps
  // over the first few seconds, so a paragraph that existed before the
  // observer was wired up is never missed.
  function primeSweeps() {
    const delays = [0, 400, 1500, 4000, 9000];
    for (let i = 0; i < delays.length; i++) setTimeout(rescan, delays[i]);
  }

  function applyMode(m) {
    mode = m || "smart";
    epoch++;                       // invalidates every cached decision
    ensureStyle();
    document.documentElement.classList.add(CLASS_RTL);
    if (document.body) { startObserver(); rescan(); }
    else waitForBody(function () { startObserver(); primeSweeps(); });
    primeSweeps();
  }

  function applyFont(on) {
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_FONT, !!on);
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
    flipBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/>' +
      '<path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>';
    // Grab the target at mousedown, BEFORE any selectionchange from the
    // click can null out btnTarget by hiding the button.
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
    let left = pRect.right + 8;
    if (left + btnW > window.innerWidth - 4) left = window.innerWidth - btnW - 4;
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
    const current = target.getAttribute(MARK) === "rtl" ? "rtl" : "ltr";
    const flipped = current === "rtl" ? "ltr" : "rtl";
    setOverride(text, flipped);
    applyMarkTo(target, flipped);
    // A manual flip is an explicit request: keep the direction we just
    // set (so the next visit does not recompute it) but let the bdi pass
    // run again for this one element.
    const st = stateOf(target);
    st.sig = computeSig(text);
    st.dir = st.sig;
    st.wrap = -1;
    st.done = 0;
    void target.offsetWidth;
    guardFlip(target, flipped);
    enqueue(target);
    hideFlipBtn();
    try { document.getSelection().removeAllRanges(); } catch (_) {}
  }

  // If a framework re-render undoes our attribute/inline style right after
  // the click, re-apply on the next frame. Only runs while actually needed.
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
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideFlipBtn(); return; }
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node) { hideFlipBtn(); return; }
    let target = node.closest && node.closest(SEL);
    if (!target || target.closest(INPUT_SKIP)) { hideFlipBtn(); return; }
    // A <code> inside a <pre> means the user meant the whole code block.
    if (target.tagName === "CODE") {
      const pre = target.closest("pre");
      if (pre) target = pre;
    }
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideFlipBtn(); return; }
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
      ISO_STRIP_RE.lastIndex = 0;
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
  window.addEventListener("scroll", hideFlipBtn, true);
  document.addEventListener("copy", onCopy, true);

  // A tab that was hidden gets no idle callbacks, so re-prime on return.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) rescan();
  });

  // These are single-page apps: switching conversations replaces the whole
  // message list without a navigation the content script can hook. A cheap
  // URL poll catches it. (history.pushState can't be patched from a
  // content script — that runs in an isolated world.)
  // One timer does both jobs: notice a conversation switch, and notice
  // that a stream has ended so the bdi pass deferred during it can run.
  let lastHref = location.href;
  let wasStreaming = false;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      rescan();
      setTimeout(rescan, 500);
      setTimeout(rescan, 1500);
    }
    const s = isPageStreaming(now());
    if (wasStreaming && !s) { rescan(); setTimeout(rescan, 400); }
    wasStreaming = s;
  }, 500);

  chrome.storage.sync.get(
    { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_OLD_RTL]: true },
    function (res) {
      let m = res && res[KEY_MODE];
      if (!m) {
        m = (res && res[KEY_OLD_RTL] === false) ? "auto" : "smart";
        try { chrome.storage.sync.set({ [KEY_MODE]: m }); } catch (_) {}
      }
      applyMode(m);
      applyFont(res && res[KEY_FONT] === true);
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
