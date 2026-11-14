// Content script (isolated world). Loads two subtitle tracks and draws them
// over the YouTube player, in sync with the video.
//
// Two paths:
//  - Full: inject.js runs inside the page, gives the track list and fetches.
//  - Fallback (if the page script can't load, e.g. Safari blocks it): the
//    player's own subtitle request is read from the Performance API, captions
//    are switched on by clicking the CC button, and files are fetched here.
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const TAG = "DUALSUBS";
  const LOG = (...a) => console.log("[DualSubs]", ...a);

  const DEFAULTS = {
    enabled: true,
    primary: "auto", // "auto" = the video's own language
    secondary: "tr",
    fontScale: 4.2, // % of player height
    secondaryColor: "#ffd75e",
    background: 0.55,
  };
  const SETTING_KEYS = Object.keys(DEFAULTS);

  let settings = { ...DEFAULTS };
  const capturedByVideo = new Map(); // videoId -> player's own timedtext URL
  let currentVideo = null;
  let loadToken = 0;
  let cues = { primary: [], secondary: [] };
  let overlay = null;
  let rafId = 0;
  let lastText = ["", ""];
  let pageScriptOk = false;

  // ---------- status (shown in the popup) ----------
  function setStatus(text) {
    LOG(text);
    try {
      api.storage.local.set({ dsStatus: text });
    } catch (_) {}
  }

  // ---------- inject page script ----------
  function injectPageScript() {
    const s = document.createElement("script");
    const url = api.runtime.getURL("inject.js");
    try {
      s.src = url;
    } catch (_) {
      // Page enforces Trusted Types for script URLs.
      try {
        const policy = window.trustedTypes.createPolicy("dualsubs", { createScriptURL: (u) => u });
        s.src = policy.createScriptURL(url);
      } catch (e) {
        LOG("page script blocked", e);
        return;
      }
    }
    s.onload = () => s.remove();
    s.onerror = () => LOG("page script failed to load");
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------- messaging with page script ----------
  let reqId = 0;
  const pending = new Map();
  function ask(type, payload = {}, timeout = 8000) {
    const id = ++reqId;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, timeout);
      pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
      window.postMessage({ source: TAG + "_CS", type, id, ...payload }, "*");
    });
  }

  const captureWaiters = new Set();
  const ownRequests = new Set(); // our fetches also show up in performance entries
  function onCaptured(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      if (!u.pathname.includes("/api/timedtext") || ownRequests.has(u.href)) return;
      const v = u.searchParams.get("v");
      // Prefer a URL that carries the "pot" token.
      if (v && (u.searchParams.get("pot") || !capturedByVideo.has(v))) {
        capturedByVideo.set(v, u.href);
        captureWaiters.forEach((fn) => fn(v));
      }
    } catch (_) {}
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    // (No ev.source === window check: it is unreliable across worlds in Safari.)
    if (!d || typeof d !== "object" || d.source !== TAG) return;
    pageScriptOk = true;
    if (d.type === "timedtext") {
      onCaptured(d.url);
    } else if (d.id && pending.has(d.id)) {
      const fn = pending.get(d.id);
      pending.delete(d.id);
      fn(d.type === "info" ? d.info : d);
    }
  });

  // Fallback capture: resource timing entries are shared with the page.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name.includes("/api/timedtext")) onCaptured(e.name);
    });
    po.observe({ type: "resource", buffered: true });
  } catch (_) {}
  function scanPerformance() {
    try {
      for (const e of performance.getEntriesByType("resource")) {
        if (e.name.includes("/api/timedtext")) onCaptured(e.name);
      }
    } catch (_) {}
  }

  function waitForCapture(videoId, ms) {
    scanPerformance();
    if (capturedByVideo.has(videoId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const fn = (v) => {
        if (v === videoId) {
          captureWaiters.delete(fn);
          clearTimeout(t);
          clearInterval(iv);
          resolve(true);
        }
      };
      const iv = setInterval(scanPerformance, 500);
      const t = setTimeout(() => {
        captureWaiters.delete(fn);
        clearInterval(iv);
        resolve(capturedByVideo.has(videoId));
      }, ms);
      captureWaiters.add(fn);
    });
  }

  // ---------- helpers ----------
  function videoIdFromLocation() {
    if (location.pathname !== "/watch") return null;
    return new URLSearchParams(location.search).get("v");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getInfoFor(videoId) {
    // Give the page script a moment; if it never answers, use fallback mode.
    for (let i = 0; i < 40; i++) {
      const info = await ask("getInfo", {}, pageScriptOk ? 2000 : 700);
      if (info && info.videoId === videoId) return info;
      if (!pageScriptOk && i >= 4) return null;
      await sleep(250);
    }
    return null;
  }

  function pickOriginal(tracks) {
    const asr = tracks.find((t) => t.kind === "asr");
    if (asr) {
      const manual = tracks.find((t) => t.kind !== "asr" && t.languageCode === asr.languageCode);
      return manual || asr;
    }
    return tracks[0] || null;
  }

  function sameLang(a, b) {
    return a === b || a.split("-")[0] === b.split("-")[0];
  }

  function withToken(baseUrl, captured) {
    const u = new URL(baseUrl, location.origin);
    if (captured) {
      const c = new URL(captured);
      const skip = new Set(["tlang", "fmt", "lang", "kind", "name"]);
      for (const [k, v] of c.searchParams) {
        if (!skip.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, v);
      }
    }
    u.searchParams.set("fmt", "json3");
    u.searchParams.delete("tlang");
    return u;
  }

  // Candidate URLs for a language, best first.
  function candidates(info, lang, captured) {
    const out = [];
    const tracks = info && info.tracks;

    if (tracks && tracks.length) {
      const original = pickOriginal(tracks);
      if (lang === "auto") {
        if (original) out.push(withToken(original.baseUrl, captured).href);
      } else {
        const own =
          tracks.find((t) => t.kind !== "asr" && t.languageCode === lang) ||
          tracks.find((t) => t.kind !== "asr" && sameLang(t.languageCode, lang)) ||
          tracks.find((t) => t.kind === "asr" && sameLang(t.languageCode, lang));
        if (own) out.push(withToken(own.baseUrl, captured).href);
        const src =
          (original && original.isTranslatable && original) ||
          tracks.find((t) => t.isTranslatable && t.kind !== "asr") ||
          tracks.find((t) => t.isTranslatable);
        if (src) {
          const u = withToken(src.baseUrl, captured);
          u.searchParams.set("tlang", lang);
          out.push(u.href);
        }
      }
    }

    // Fallback: rewrite the player's own request (lang isn't signed).
    if (captured) {
      const base = new URL(captured);
      base.searchParams.set("fmt", "json3");
      base.searchParams.delete("tlang");
      if (lang === "auto") {
        out.push(base.href);
      } else {
        const own = new URL(base.href);
        own.searchParams.set("lang", lang);
        own.searchParams.delete("kind");
        own.searchParams.delete("name");
        out.push(own.href);
        const tr = new URL(base.href);
        tr.searchParams.set("tlang", lang);
        out.push(tr.href);
      }
    }
    return [...new Set(out)];
  }

  function parseJson3(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const e of data.events || []) {
      if (!e.segs) continue;
      const t = e.segs.map((s) => s.utf8 || "").join("").replace(/​/g, "").trim();
      if (!t) continue;
      const start = e.tStartMs || 0;
      out.push({ start, end: start + (e.dDurationMs || 2000), text: t });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  async function fetchText(url) {
    ownRequests.add(new URL(url, location.href).href);
    if (pageScriptOk) {
      const res = await ask("fetch", { url }, 15000);
      if (res && res.ok && res.text) return res.text;
    }
    try {
      const res = await fetch(url, { credentials: "include" });
      return res.ok ? await res.text() : "";
    } catch (e) {
      LOG("fetch failed", e);
      return "";
    }
  }

  async function fetchFirst(urls) {
    for (const url of urls) {
      const list = parseJson3(await fetchText(url));
      if (list.length) return list;
    }
    return [];
  }

  // Active cue = the most recently started cue that has not ended yet.
  function activeText(list, ms) {
    let lo = 0;
    let hi = list.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= ms) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i = idx; i >= 0 && i > idx - 6; i--) {
      if (list[i].end > ms) return list[i].text;
    }
    return "";
  }

  // ---------- captions on ----------
  // force: if CC is already on, switch it off and on so the player re-requests.
  async function clickCaptionButton(force) {
    const b = document.querySelector("#movie_player .ytp-subtitles-button");
    if (!b) return false;
    if (b.getAttribute("aria-pressed") === "true") {
      if (!force) return false;
      b.click();
      await sleep(400);
    }
    b.click();
    return true;
  }

  // ---------- overlay ----------
  function playerEl() {
    return document.getElementById("movie_player");
  }

  function ensureOverlay() {
    const p = playerEl();
    if (!p) return null;
    if (overlay && overlay.isConnected && overlay.parentElement === p) return overlay;
    overlay = document.createElement("div");
    overlay.className = "dualsubs-overlay";
    // No innerHTML: YouTube enforces Trusted Types.
    for (const cls of ["ds-primary", "ds-secondary"]) {
      const line = document.createElement("div");
      line.className = "ds-line " + cls;
      line.style.display = "none";
      overlay.appendChild(line);
    }
    p.appendChild(overlay);
    applyStyle();
    return overlay;
  }

  function applyStyle() {
    if (!overlay) return;
    const p = playerEl();
    const h = p ? p.clientHeight : 480;
    const px = Math.max(12, Math.round((h * settings.fontScale) / 100));
    overlay.style.setProperty("--ds-font", px + "px");
    overlay.style.setProperty("--ds-color2", settings.secondaryColor);
    overlay.style.setProperty("--ds-bg", `rgba(8,8,8,${settings.background})`);
  }

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => applyStyle()) : null;
  let observedPlayer = null;

  function setLine(el, text) {
    el.textContent = text;
    el.style.display = text ? "" : "none";
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    const video = document.querySelector("#movie_player video");
    const ov = ensureOverlay();
    if (!video || !ov) return;
    const p = playerEl();
    if (ro && p && p !== observedPlayer) {
      if (observedPlayer) ro.unobserve(observedPlayer);
      ro.observe(p);
      observedPlayer = p;
    }
    const ms = video.currentTime * 1000;
    const a = activeText(cues.primary, ms);
    const b = activeText(cues.secondary, ms);
    if (a !== lastText[0]) setLine(ov.children[0], a);
    if (b !== lastText[1]) setLine(ov.children[1], b);
    lastText = [a, b];
  }

  function start() {
    document.documentElement.classList.add("dualsubs-active");
    lastText = [null, null];
    if (!rafId) rafId = requestAnimationFrame(tick);
  }

  function stop() {
    document.documentElement.classList.remove("dualsubs-active");
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    cues = { primary: [], secondary: [] };
    if (overlay) overlay.remove();
    overlay = null;
  }

  // ---------- main flow ----------
  async function load(videoId) {
    const token = ++loadToken;
    stop();
    if (!settings.enabled) return setStatus("Kapalı.");
    if (!videoId) return;
    setStatus("Video bulundu, altyazılar aranıyor…");

    const info = await getInfoFor(videoId);
    if (token !== loadToken) return;
    if (info && !info.tracks.length) return setStatus("Bu videoda altyazı yok.");
    const mode = info ? "tam mod" : "yedek mod";

    if (!capturedByVideo.has(videoId)) scanPerformance();
    if (!capturedByVideo.has(videoId)) {
      // Captions can't be switched on while an ad is playing.
      if (playerEl() && playerEl().classList.contains("ad-showing")) setStatus("Reklamın bitmesi bekleniyor…");
      for (let i = 0; i < 600 && playerEl() && playerEl().classList.contains("ad-showing"); i++) {
        await sleep(500);
        if (token !== loadToken) return;
      }
      if (!(await waitForCapture(videoId, 800))) {
        const orig = info && pickOriginal(info.tracks);
        const languageCode = orig && orig.languageCode;
        if (pageScriptOk) ask("enableCaptions", { languageCode }, 1);
        else clickCaptionButton();
        if (!(await waitForCapture(videoId, 3000))) {
          if (token !== loadToken) return;
          if (pageScriptOk) ask("enableCaptions", { languageCode, force: true }, 1);
          else await clickCaptionButton(true);
          await waitForCapture(videoId, 5000);
        }
      }
      if (token !== loadToken) return;
    }
    const captured = capturedByVideo.get(videoId) || null;
    if (!captured && !info) {
      return setStatus(`Altyazı isteği yakalanamadı (${mode}). Videoda CC düğmesine bir kez basmayı dene.`);
    }

    const pList = candidates(info, settings.primary, captured);
    const sList =
      settings.secondary && settings.secondary !== "off" && settings.secondary !== settings.primary
        ? candidates(info, settings.secondary, captured)
        : [];

    const [pc, sc] = await Promise.all([fetchFirst(pList), fetchFirst(sList)]);
    if (token !== loadToken) return;
    if (!pc.length && !sc.length) {
      return setStatus(`Altyazı indirilemedi (${mode}, jeton: ${captured ? "var" : "yok"}).`);
    }
    cues = { primary: pc, secondary: sc };
    setStatus(`Çalışıyor (${mode}): ${pc.length} + ${sc.length} satır.`);
    start();
  }

  function checkNavigation() {
    const v = videoIdFromLocation();
    if (v !== currentVideo) {
      currentVideo = v;
      if (v) load(v);
      else stop();
    }
  }

  // ---------- boot ----------
  injectPageScript();

  Promise.resolve(api.storage.local.get(DEFAULTS)).then(init, () => init(DEFAULTS));

  function init(stored) {
    settings = { ...DEFAULTS, ...(stored || {}) };
    document.addEventListener("yt-navigate-finish", checkNavigation);
    setInterval(checkNavigation, 1000);
    checkNavigation();
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!SETTING_KEYS.some((k) => k in changes)) return; // e.g. only dsStatus
    const old = { ...settings };
    for (const k of SETTING_KEYS) if (k in changes) settings[k] = changes[k].newValue;
    const needsReload =
      old.enabled !== settings.enabled || old.primary !== settings.primary || old.secondary !== settings.secondary;
    if (needsReload) {
      if (currentVideo) load(currentVideo);
    } else {
      applyStyle();
    }
  });
})();
