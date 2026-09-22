/*
 * Farsi_RTL — language decision engine
 *
 * Pure functions only: no DOM, no chrome APIs, no state. This file is a
 * separate content script so the same code that runs in the browser can be
 * loaded directly by the test runner in tools/, instead of being scraped
 * out of content.js with a regex. If it cannot be tested honestly, it
 * cannot be improved honestly.
 *
 * Everything here operates on PROSE — the sentence with inline code and
 * URLs already removed by the caller. See proseOf() in content.js.
 */

var FarsiEngine = (function () {
  "use strict";

  // Arabic, Arabic Supplement, Arabic Extended-A, and the two presentation
  // form blocks. Persian, Arabic, Urdu, Pashto and Kurdish all live here.
  const P_RANGES = [
    [0x0600, 0x06FF], [0x0750, 0x077F], [0x08A0, 0x08FF],
    [0xFB50, 0xFDFF], [0xFE70, 0xFEFF]
  ];

  function isPersianCode(c) {
    // Fast path: almost every character on these pages is either ASCII
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

  /*
   * One pass collecting every signal the decision needs:
   *   pChars / lChars — strong character counts
   *   pWords / lWords — word counts (one long identifier counts once)
   *   first           — 1 if the first strong char is Persian, 2 if Latin
   *   woven           — Persian appears BETWEEN two Latin runs
   */
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
   * The decision: synchronous, deterministic, six rules.
   *
   * The question is never "which language has more of this paragraph". It
   * is "which language is the paragraph WRITTEN IN" — the matrix language.
   * Persian technical writing is Persian prose with English terms dropped
   * into it, and an English term is one token no matter how long it is.
   * Weighing characters made `isAnnotationPresent()` nineteen votes for
   * English against three for «متد», so «متد getClass()» came out right
   * and «متد isAnnotationPresent()» came out backwards — the same sentence
   * answered differently because of identifier length.
   *
   *   1. no Persian in the prose      -> leave the element alone
   *   2. no Latin in the prose        -> RTL
   *   3. the prose STARTS in Persian  -> RTL
   *      (the first-strong rule behind HTML's dir="auto": a sentence opens
   *      in its own language)
   *   4. Persian words >= Latin words -> RTL
   *      (words, not characters, so one long identifier counts once)
   *   5. Persian sits BETWEEN two Latin runs -> RTL
   *      A Persian word wedged between two Latin ones is not an object the
   *      sentence is talking about, it is the joint the sentence is built
   *      on — «و» there does the work "and" does in English. A language
   *      only supplies connectives to a sentence it owns. This is
   *      position, not vocabulary, so no word list is needed.
   *   6. Latin-led, more Latin words, Persian only at the tail, AND the
   *      Latin part is long enough to be a sentence -> LTR
   *   7. otherwise                    -> RTL
   *
   * Rule 6 exists for one shape: an English SENTENCE that happens to end
   * with a Persian word, as in «The Persian word for runtime is زمان
   * اجرا», where the Persian really is the object being quoted.
   *
   * On three real conversations it fired about ten times in some nine
   * hundred paragraphs and was wrong every single time — on «Liara AI
   * قابلیت‌ها», «native method چیست», «Edge Case مثل», «Java Core عمیق».
   * Those are Persian headings whose first word or two happen to be a
   * technical term; the Latin part is not a sentence, it is a name. And
   * the failure had the old familiar shape: «JNI چیست» came out right
   * while «native method چیست» came out backwards, because one had two
   * Latin words instead of one.
   *
   * So rule 6 now also asks whether the Latin part is sentence-sized.
   * That IS a threshold, and it is worth being plain about it: the
   * harvested failures all had two Latin words, the legitimate cases all
   * had six or more, and four sits in the middle of that gap with room on
   * both sides. It is pinned by the corpus, so moving it is measurable
   * rather than a matter of taste.
   *
   * Returns the direction and the rule that produced it, so diagnostics
   * and the accuracy runner can report WHY, not just what.
   */
  // How many Latin words before the Latin part counts as a sentence
  // rather than a name. See the note on rule 6 above.
  const SENTENCE_WORDS = 4;

  function decide(s) {
    if (s.pChars === 0) return { dir: null,  rule: 1 };
    if (s.lChars === 0) return { dir: "rtl", rule: 2 };
    if (s.first === 1)  return { dir: "rtl", rule: 3 };
    if (s.pWords >= s.lWords) return { dir: "rtl", rule: 4 };
    if (s.woven)        return { dir: "rtl", rule: 5 };
    if (s.lWords >= SENTENCE_WORDS) return { dir: "ltr", rule: 6 };
    return { dir: "rtl", rule: 7 };
  }

  const RULE_NAMES = {
    1: "no Persian — left alone",
    2: "no Latin — RTL",
    3: "starts in Persian — RTL",
    4: "Persian words >= Latin words — RTL",
    5: "Persian woven between Latin — RTL",
    6: "English sentence with a Persian tail — LTR",
    7: "Latin-led but only a term, not a sentence — RTL"
  };

  // Code blocks are structural: flipping one because it carries Persian
  // comments would wreck its layout, so Persian must strictly outnumber.
  function codeDirection(text) {
    const s = scanText(text);
    if (s.pChars === 0) return null;
    return s.pWords > s.lWords ? "rtl" : "ltr";
  }

  // Convenience for callers that just want an answer from a string.
  function directionOf(prose) {
    return decide(scanText(prose || ""));
  }

  return {
    isPersianCode: isPersianCode,
    hasAnyPersian: hasAnyPersian,
    scanText: scanText,
    decide: decide,
    directionOf: directionOf,
    codeDirection: codeDirection,
    RULE_NAMES: RULE_NAMES
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FarsiEngine;
