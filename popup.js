const KEY_RTL = "rtlEnabled";
const KEY_FONT = "fontEnabled";

const rtlEl = document.getElementById("toggle-rtl");
const fontEl = document.getElementById("toggle-font");

chrome.storage.sync.get({ [KEY_RTL]: true, [KEY_FONT]: false }, (res) => {
  rtlEl.checked = res[KEY_RTL] !== false;
  fontEl.checked = res[KEY_FONT] === true;
});

async function pushToActiveTab(payload) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const t of tabs) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(t.id, payload).catch(() => {});
    }
  } catch (_) { /* ignore */ }
}

rtlEl.addEventListener("change", async () => {
  const enabled = rtlEl.checked;
  await chrome.storage.sync.set({ [KEY_RTL]: enabled });
  pushToActiveTab({ type: "farsi-toggle", rtl: enabled });
});

fontEl.addEventListener("change", async () => {
  const enabled = fontEl.checked;
  await chrome.storage.sync.set({ [KEY_FONT]: enabled });
  pushToActiveTab({ type: "farsi-toggle", font: enabled });
});
