const api = globalThis.browser || globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  primary: "auto",
  secondary: "tr",
  fontScale: 4.2,
  secondaryColor: "#ffd75e",
  background: 0.55,
};

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

function fill(select, extra) {
  for (const [v, t] of extra.concat(LANGS)) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    select.appendChild(o);
  }
}

const $ = (id) => document.getElementById(id);
fill($("primary"), [["auto", "Videonun kendi dili"]]);
fill($("secondary"), [["off", "Kapalı"], ["auto", "Videonun kendi dili"]]);

function show(s) {
  $("enabled").checked = s.enabled;
  $("primary").value = s.primary;
  $("secondary").value = s.secondary;
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
$("primary").addEventListener("change", (e) => save({ primary: e.target.value }));
$("secondary").addEventListener("change", (e) => save({ secondary: e.target.value }));
$("secondaryColor").addEventListener("input", (e) => save({ secondaryColor: e.target.value }));
$("fontScale").addEventListener("input", (e) => {
  $("fontScaleOut").textContent = Number(e.target.value).toFixed(1);
  save({ fontScale: Number(e.target.value) });
});
$("background").addEventListener("input", (e) => {
  $("backgroundOut").textContent = Math.round(e.target.value * 100) + "%";
  save({ background: Number(e.target.value) });
});

function showStatus(t) {
  if (t) $("status").textContent = "Durum: " + t;
}
Promise.resolve(api.storage.local.get({ dsStatus: "" })).then((s) => showStatus(s.dsStatus));
api.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.dsStatus) showStatus(c.dsStatus.newValue);
});
