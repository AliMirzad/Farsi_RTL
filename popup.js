// Firefox exposes promise-returning APIs on `browser`; its `chrome` alias
// is callback-only. Wrapping the two calls that need a result keeps one
// popup.js working on both without a build step.
const api = typeof browser !== "undefined" ? browser : chrome;

function pget(defaults) {
  return new Promise((r) => api.storage.sync.get(defaults, r));
}
function pset(obj) {
  return new Promise((r) => api.storage.sync.set(obj, r));
}
function pquery(q) {
  return new Promise((r) => api.tabs.query(q, r));
}

const KEY_MODE = "rtlMode";       // "always" | "smart" | "auto"
const KEY_FONT = "fontEnabled";   // boolean
const KEY_DEBUG = "debugMode";    // boolean — developer diagnostics
const KEY_LH = "lineSpacing";     // boolean — looser line height
const KEY_SITES = "siteOff";      // { host: true } means switched off there
const KEY_OLD_RTL = "rtlEnabled"; // legacy boolean, migrated on load
const KEY_SCALE = "fontScale";    // percent, one of SCALES
const KEY_OVERRIDES = "overrides"; // storage.local: manual flips, hash -> dir

const SCALES = [90, 100, 110, 120, 130];

// Version label and its link come from the manifest, so they can never
// drift out of sync with a release.
const mf = api.runtime.getManifest();
const verEl = document.getElementById("ver");
if (verEl) {
  verEl.textContent = "v" + mf.version;
  if (mf.homepage_url) verEl.href = mf.homepage_url;
  else verEl.removeAttribute("href");
}

const fontEl = document.getElementById("toggle-font");
const modeRadios = document.querySelectorAll('input[name="rtl-mode"]');
const debugEl = document.getElementById("toggle-debug");
const lhEl = document.getElementById("toggle-lh");
const siteEl = document.getElementById("toggle-site");
const hostEl = document.getElementById("site-host");
const noteEl = document.getElementById("site-note");

const rowEl = document.getElementById("site-row");
const scaleEl = document.getElementById("scale");
const scaleDownEl = document.getElementById("scale-down");
const scaleUpEl = document.getElementById("scale-up");
const scaleValEl = document.getElementById("scale-val");
const resetEl = document.getElementById("reset");
const resetTextEl = document.getElementById("reset-text");
const resetBtnEl = document.getElementById("reset-btn");

// The tab this popup was opened over. Both facts about it matter: which
// host it is, and whether the extension runs there at all — the second
// comes from the manifest's own match list, so the popup can never
// disagree with what is actually injected.
async function currentTab() {
  try {
    const tabs = await pquery({ active: true, currentWindow: true });
    const url = (tabs && tabs[0] && tabs[0].url) || "";
    const patterns = api.runtime.getManifest().content_scripts[0].matches;
    return {
      url: url,
      host: url ? new URL(url).hostname.replace(/^www\./, "") : "",
      supported: FarsiMatch.matchesAny(url, patterns)
    };
  } catch (_) { return { url: "", host: "", supported: false }; }
}

let host = "";
let supported = false;

api.storage.sync.get(
  { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_DEBUG]: false,
    [KEY_LH]: false, [KEY_SITES]: {}, [KEY_OLD_RTL]: true,
    [KEY_SCALE]: 100 },
  async (res) => {
    const tab = await currentTab();
    host = tab.host;
    supported = tab.supported;
    const offMap = res[KEY_SITES] || {};
    const on = supported && offMap[host] !== true;
    hostEl.textContent = host || "این صفحه";
    siteEl.checked = on;
    siteEl.disabled = !supported;
    setSiteNote(on);
    let mode = res[KEY_MODE];
    if (!mode) {
      mode = res[KEY_OLD_RTL] === false ? "auto" : "smart";
      await pset({ [KEY_MODE]: mode });
    }
    for (const r of modeRadios) r.checked = (r.value === mode);
    fontEl.checked = res[KEY_FONT] === true;
    debugEl.setAttribute("aria-pressed", res[KEY_DEBUG] === true ? "true" : "false");
    lhEl.checked = res[KEY_LH] === true;
    showScale(SCALES.includes(res[KEY_SCALE]) ? res[KEY_SCALE] : 100);
  }
);

function setSiteNote(on) {
  if (!supported) {
    noteEl.textContent = "روی این سایت اجرا نمی‌شود";
    rowEl.classList.add("unsupported");
    rowEl.classList.remove("off");
    return;
  }
  rowEl.classList.remove("unsupported");
  rowEl.classList.toggle("off", !on);
  noteEl.textContent = on ? "در این سایت فعال است" : "در این سایت خاموش است";
}

async function pushToActiveTab(payload) {
  try {
    const tabs = await pquery({ active: true, currentWindow: true });
    for (const t of tabs) {
      if (!t.id) continue;
      try { const r = api.tabs.sendMessage(t.id, payload); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}

for (const r of modeRadios) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    await pset({ [KEY_MODE]: r.value });
    pushToActiveTab({ type: "farsi-toggle", mode: r.value });
  });
}

fontEl.addEventListener("change", async () => {
  const enabled = fontEl.checked;
  await pset({ [KEY_FONT]: enabled });
  pushToActiveTab({ type: "farsi-toggle", font: enabled });
});

debugEl.addEventListener("click", async () => {
  const on = debugEl.getAttribute("aria-pressed") !== "true";
  debugEl.setAttribute("aria-pressed", on ? "true" : "false");
  await pset({ [KEY_DEBUG]: on });
  pushToActiveTab({ type: "farsi-toggle", debug: on });
});

lhEl.addEventListener("change", async () => {
  await pset({ [KEY_LH]: lhEl.checked });
  pushToActiveTab({ type: "farsi-toggle", lineSpacing: lhEl.checked });
});

siteEl.addEventListener("change", async () => {
  if (!supported || !host) return;
  const on = siteEl.checked;
  setSiteNote(on);
  // Read-modify-write: the map holds every site the user has switched off,
  // so it must not be replaced wholesale by this one tab's answer.
  const cur = await pget({ [KEY_SITES]: {} });
  const map = cur[KEY_SITES] || {};
  if (on) delete map[host];
  else map[host] = true;
  await pset({ [KEY_SITES]: map });
  pushToActiveTab({ type: "farsi-toggle", siteOn: on });
});

// ---------- text size ----------

let scale = 100;
const fa = (n) => n.toLocaleString("fa-IR");

function showScale(v) {
  scale = v;
  const i = SCALES.indexOf(v);
  scaleValEl.textContent = fa(v) + "٪";
  scaleEl.classList.toggle("changed", v !== 100);
  // aria-disabled rather than disabled: a disabled button drops keyboard
  // focus, so pressing + up to the top would throw the user out of the
  // control.
  scaleDownEl.setAttribute("aria-disabled", i <= 0 ? "true" : "false");
  scaleUpEl.setAttribute("aria-disabled", i >= SCALES.length - 1 ? "true" : "false");
}

async function stepScale(dir) {
  const i = SCALES.indexOf(scale) + dir;
  if (i < 0 || i >= SCALES.length) return;
  showScale(SCALES[i]);
  await pset({ [KEY_SCALE]: scale });
  pushToActiveTab({ type: "farsi-toggle", fontScale: scale });
}

scaleDownEl.addEventListener("click", () => stepScale(-1));
scaleUpEl.addEventListener("click", () => stepScale(1));
// Arrow keys anywhere in the control, as on a native number input.
scaleEl.addEventListener("keydown", (e) => {
  const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
  if (!d) return;
  e.preventDefault();
  stepScale(d);
});

// ---------- manual overrides ----------

function showOverrideCount(n) {
  resetEl.classList.remove("done");
  resetEl.hidden = !n;
  resetTextEl.textContent = "اصلاح‌های ذخیره‌شده: " + fa(n);
}

try {
  api.storage.local.get({ [KEY_OVERRIDES]: {} }, (res) => {
    showOverrideCount(Object.keys((res && res[KEY_OVERRIDES]) || {}).length);
  });
} catch (_) { /* no storage.local: leave the row hidden */ }

resetBtnEl.addEventListener("click", async () => {
  // Only the overrides key: every other setting lives in storage.sync and
  // is not touched. Open tabs see the removal through storage.onChanged
  // and re-evaluate; the message is for the tab in front of the user, so
  // it does not depend on event timing.
  await new Promise((r) => api.storage.local.remove(KEY_OVERRIDES, r));
  pushToActiveTab({ type: "farsi-toggle", clearOverrides: true });
  resetEl.classList.add("done");
  resetTextEl.textContent = "اصلاح‌ها پاک شد";
  // The button that had focus is gone; keep focus inside the callout
  // rather than dropping it on <body>.
  resetTextEl.setAttribute("tabindex", "-1");
  resetTextEl.focus();
});
