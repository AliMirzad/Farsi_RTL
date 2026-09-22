const KEY_MODE = "rtlMode";       // "always" | "smart" | "auto"
const KEY_FONT = "fontEnabled";   // boolean
const KEY_DEBUG = "debugMode";    // boolean — developer diagnostics
const KEY_LH = "lineSpacing";     // boolean — looser line height
const KEY_SITES = "siteOff";      // { host: true } means switched off there
const KEY_OLD_RTL = "rtlEnabled"; // legacy boolean, migrated on load

// Version label and its link come from the manifest, so they can never
// drift out of sync with a release.
const mf = chrome.runtime.getManifest();
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

// The host of the tab this popup was opened over. Everything site-specific
// hangs off it, so it is resolved once, before the settings are read.
async function currentHost() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs && tabs[0] && tabs[0].url;
    if (!url) return "";
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) { return ""; }
}

let host = "";

chrome.storage.sync.get(
  { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_DEBUG]: false,
    [KEY_LH]: false, [KEY_SITES]: {}, [KEY_OLD_RTL]: true },
  async (res) => {
    host = await currentHost();
    const offMap = res[KEY_SITES] || {};
    const on = host ? offMap[host] !== true : true;
    hostEl.textContent = host || "این صفحه";
    siteEl.checked = on;
    siteEl.disabled = !host;
    setSiteNote(on);
    let mode = res[KEY_MODE];
    if (!mode) {
      mode = res[KEY_OLD_RTL] === false ? "auto" : "smart";
      await chrome.storage.sync.set({ [KEY_MODE]: mode });
    }
    for (const r of modeRadios) r.checked = (r.value === mode);
    fontEl.checked = res[KEY_FONT] === true;
    debugEl.setAttribute("aria-pressed", res[KEY_DEBUG] === true ? "true" : "false");
    lhEl.checked = res[KEY_LH] === true;
  }
);

function setSiteNote(on) {
  noteEl.textContent = on ? "در این سایت فعال است" : "در این سایت خاموش است";
}

async function pushToActiveTab(payload) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, payload).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

for (const r of modeRadios) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    await chrome.storage.sync.set({ [KEY_MODE]: r.value });
    pushToActiveTab({ type: "farsi-toggle", mode: r.value });
  });
}

fontEl.addEventListener("change", async () => {
  const enabled = fontEl.checked;
  await chrome.storage.sync.set({ [KEY_FONT]: enabled });
  pushToActiveTab({ type: "farsi-toggle", font: enabled });
});

debugEl.addEventListener("click", async () => {
  const on = debugEl.getAttribute("aria-pressed") !== "true";
  debugEl.setAttribute("aria-pressed", on ? "true" : "false");
  await chrome.storage.sync.set({ [KEY_DEBUG]: on });
  pushToActiveTab({ type: "farsi-toggle", debug: on });
});

lhEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [KEY_LH]: lhEl.checked });
  pushToActiveTab({ type: "farsi-toggle", lineSpacing: lhEl.checked });
});

siteEl.addEventListener("change", async () => {
  if (!host) return;
  const on = siteEl.checked;
  setSiteNote(on);
  // Read-modify-write: the map holds every site the user has switched off,
  // so it must not be replaced wholesale by this one tab's answer.
  const cur = await chrome.storage.sync.get({ [KEY_SITES]: {} });
  const map = cur[KEY_SITES] || {};
  if (on) delete map[host];
  else map[host] = true;
  await chrome.storage.sync.set({ [KEY_SITES]: map });
  pushToActiveTab({ type: "farsi-toggle", siteOn: on });
});
