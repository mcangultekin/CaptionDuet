const api = globalThis.browser || globalThis.chrome;

const { DEFAULTS } = globalThis.CaptionDuetCore;

const LANGS = [
  ["en", "İngilizce"],
  ["tr", "Türkçe"],
  ["de", "Almanca"],
  ["fr", "Fransızca"],
  ["es", "İspanyolca"],
  ["it", "İtalyanca"],
  ["pt", "Portekizce"],
  ["nl", "Felemenkçe"],
  ["ru", "Rusça"],
  ["uk", "Ukraynaca"],
  ["pl", "Lehçe"],
  ["ar", "Arapça"],
  ["fa", "Farsça"],
  ["ja", "Japonca"],
  ["ko", "Korece"],
  ["zh-Hans", "Çince (Basitleştirilmiş)"],
  ["zh-Hant", "Çince (Geleneksel)"],
  ["hi", "Hintçe"],
  ["sv", "İsveççe"],
  ["el", "Yunanca"],
];

const $ = (id) => document.getElementById(id);

function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

function group(label, items) {
  const g = document.createElement("optgroup");
  g.label = label;
  for (const [v, t] of items) g.appendChild(option(v, t));
  return g;
}

// What the open video offers; empty until the tab reports it.
let video = { tracks: [], translations: [] };
let settings = { ...DEFAULTS };

// Language menu: fixed choices, then the video's own subtitle tracks, then
// everything YouTube can auto-translate to (a built-in list until we know).
function fill(select, fixed, value) {
  select.textContent = "";
  for (const [v, t] of fixed) select.appendChild(option(v, t));
  const seen = new Set();
  const own = [];
  for (const t of video.tracks) {
    if (seen.has(t.code)) continue;
    seen.add(t.code);
    own.push([t.code, t.auto ? `${t.name} (otomatik)` : t.name]);
  }
  if (own.length) select.appendChild(group("Bu videodaki altyazılar", own));
  const translated = video.translations.length ? video.translations.map((t) => [t.code, t.name]) : LANGS;
  select.appendChild(group("Otomatik çeviri", translated));
  // A saved language this video doesn't list still has to show as selected.
  if (![...select.options].some((o) => o.value === value)) select.appendChild(option(value, value));
  select.value = value;
}

function fillLanguages() {
  fill($("primary"), [["auto", "Videonun kendi dili"]], settings.primary);
  fill($("secondary"), [["off", "Kapalı"], ["auto", "Videonun kendi dili"]], settings.secondary);
}

function show(s) {
  settings = s;
  $("enabled").checked = s.enabled;
  fillLanguages();
  $("fontScale").value = s.fontScale;
  $("background").value = s.background;
  $("secondaryColor").value = s.secondaryColor;
  $("fontScaleOut").textContent = Number(s.fontScale).toFixed(1);
  $("backgroundOut").textContent = Math.round(s.background * 100) + "%";
}

function save(patch) {
  api.storage.local.set(patch);
}

Promise.resolve(api.storage.local.get(DEFAULTS)).then((s) => {
  show({ ...DEFAULTS, ...s });
});

$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
$("primary").addEventListener("change", (e) => {
  settings.primary = e.target.value;
  save({ primary: e.target.value });
});
$("secondary").addEventListener("change", (e) => {
  settings.secondary = e.target.value;
  save({ secondary: e.target.value });
});
$("secondaryColor").addEventListener("input", (e) => save({ secondaryColor: e.target.value }));
$("fontScale").addEventListener("input", (e) => {
  $("fontScaleOut").textContent = Number(e.target.value).toFixed(1);
  save({ fontScale: Number(e.target.value) });
});
$("background").addEventListener("input", (e) => {
  $("backgroundOut").textContent = Math.round(e.target.value * 100) + "%";
  save({ background: Number(e.target.value) });
});

// ---------- state of the video in the current tab ----------
function showState(st) {
  if (!st) return;
  if (st.status) $("status").textContent = "Durum: " + st.status;
  const tracks = st.tracks || [];
  const translations = st.translations || [];
  // Rebuild the menus only when the lists changed, not on every status line.
  if (JSON.stringify([tracks, translations]) === JSON.stringify([video.tracks, video.translations])) return;
  video = { tracks, translations };
  fillLanguages();
}

// The content script keeps one entry per video in storage. Show the one for
// the video in this tab; if the tab's address can't be read, the newest one.
const { videoIdFromUrl } = globalThis.CaptionDuetCore;
let tabVideo; // undefined = unknown, null = this tab has no video

function pick(states) {
  const all = states || {};
  if (tabVideo === null) return null;
  if (tabVideo) return all[tabVideo] || null;
  return Object.values(all).sort((a, b) => b.at - a.at)[0] || null;
}

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const u = new URL(tab.url);
      tabVideo = videoIdFromUrl(u.pathname, u.search);
    }
  } catch (_) {
    // No access to the tab's address: fall back to the newest entry.
  }
  const got = await api.storage.local.get({ cdStates: {} });
  showState(pick(got.cdStates));
})();

api.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.cdStates) showState(pick(c.cdStates.newValue));
});
