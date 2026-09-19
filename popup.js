const KEY_MODE = "rtlMode";      // "always" | "smart" | "auto"
const KEY_FONT = "fontEnabled";  // boolean
const KEY_OLD_RTL = "rtlEnabled"; // legacy boolean, migrated on load

const MODE_DESC = {
  always: "هر پاراگرافی که فارسی داشته باشه راست‌چین می‌شه",
  smart: "زبانِ خودِ جمله تعیین می‌کند؛ کد داخل بک‌تیک و لینک شمرده نمی‌شود",
  auto: "بدون تغییر جهت — فقط bidi و فونت اعمال می‌شن"
};

const fontEl = document.getElementById("toggle-font");
const descEl = document.getElementById("mode-desc");
const modeRadios = document.querySelectorAll('input[name="rtl-mode"]');

chrome.storage.sync.get(
  { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_OLD_RTL]: true },
  async (res) => {
    let mode = res[KEY_MODE];
    if (!mode) {
      mode = res[KEY_OLD_RTL] === false ? "auto" : "smart";
      await chrome.storage.sync.set({ [KEY_MODE]: mode });
    }
    setRadio(mode);
    fontEl.checked = res[KEY_FONT] === true;
  }
);

function setRadio(mode) {
  for (const r of modeRadios) r.checked = (r.value === mode);
  descEl.textContent = MODE_DESC[mode] || "";
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
    const mode = r.value;
    descEl.textContent = MODE_DESC[mode] || "";
    await chrome.storage.sync.set({ [KEY_MODE]: mode });
    pushToActiveTab({ type: "farsi-toggle", mode });
  });
}

fontEl.addEventListener("change", async () => {
  const enabled = fontEl.checked;
  await chrome.storage.sync.set({ [KEY_FONT]: enabled });
  pushToActiveTab({ type: "farsi-toggle", font: enabled });
});
