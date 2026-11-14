// Content script (isolated world). Loads two subtitle tracks and draws them
// over the YouTube player, in sync with the video.
//
// Paths, best first:
//  - Full: inject.js runs inside the page (the manifest loads it in the MAIN
//    world), gives the track list and fetches.
//  - Fallback (if the page script doesn't answer): the player's own subtitle
//    request is read from the Performance API, captions are switched on by
//    clicking the CC button, and files are fetched here.
// Pure logic lives in core.js (DualSubsCore).
(() => {
  const api = globalThis.browser || globalThis.chrome;
  const TAG = "DUALSUBS";
  const LOG = (...a) => console.log("[DualSubs]", ...a);

  const { DEFAULTS, timedtextUrl, videoIdFromUrl, playerSelector, pickOriginal, candidates, langOfUrl, parseJson3, activeCue } =
    globalThis.DualSubsCore;
  const SETTING_KEYS = Object.keys(DEFAULTS);

  let settings = { ...DEFAULTS };
  const capturedByVideo = new Map(); // videoId -> player's own timedtext URL
  const cueCache = new Map(); // "videoId|lang" -> parsed cues, so switching back is instant
  const CUE_CACHE_MAX = 12;
  let currentVideo = null;
  let loadToken = 0;
  let cues = { primary: [], secondary: [] };
  let overlay = null;
  let rafId = 0;
  let active = false; // cues are loaded and being drawn
  let video = null; // the player's <video>, cached between frames
  let lastDrawn = ""; // what the box currently shows, to skip identical frames
  let pageScriptOk = false; // inject.js has answered

  // ---------- state shown in the popup ----------
  // Written to storage under the video's id (the popup reads storage reliably
  // in every browser, and the id keeps tabs from overwriting each other).
  const state = { status: "", tracks: [], translations: [] };
  const STATES_MAX = 6;
  let publishing = Promise.resolve();
  function publish() {
    const videoId = currentVideo;
    if (!videoId) return;
    const entry = { ...state, at: Date.now() };
    // One write at a time, so a quick pair of updates can't land out of order.
    publishing = publishing
      .then(() => api.storage.local.get({ dsStates: {} }))
      .then((got) => {
        const all = { ...((got && got.dsStates) || {}), [videoId]: entry };
        const ids = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
        for (const id of ids.slice(STATES_MAX)) delete all[id];
        return api.storage.local.set({ dsStates: all });
      })
      .catch(() => {});
  }
  function setStatus(text) {
    LOG(text);
    state.status = text;
    publish();
  }
  function setLanguages(info) {
    state.tracks = info ? info.tracks.map((t) => ({ code: t.languageCode, name: t.name, auto: t.kind === "asr" })) : [];
    state.translations = (info && info.translations) || [];
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
    // Only YouTube's own endpoint: this URL is later fetched with cookies.
    const u = timedtextUrl(rawUrl);
    if (!u || ownRequests.has(u.href)) return;
    const v = u.searchParams.get("v");
    // Prefer a URL that carries the "pot" token.
    if (v && (u.searchParams.get("pot") || !capturedByVideo.has(v))) {
      capturedByVideo.set(v, u.href);
      captureWaiters.forEach((fn) => fn(v));
    }
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    // (No ev.source === window check: it is unreliable across worlds in Safari.)
    // The origin string is reliable, and keeps out messages from embedded frames.
    if (ev.origin !== location.origin) return;
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
    return videoIdFromUrl(location.pathname, location.search);
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
      const list = parseJson3(await fetchText(url), langOfUrl(url));
      if (list.length) return list;
    }
    return [];
  }

  // ---------- captions on ----------
  // force: if CC is already on, switch it off and on so the player re-requests.
  const captionButton = () => {
    const p = playerEl();
    return p && p.querySelector(".ytp-subtitles-button");
  };
  const captionButtonOn = () => {
    const b = captionButton();
    return b ? b.getAttribute("aria-pressed") === "true" : null;
  };

  async function clickCaptionButton(force) {
    const b = captionButton();
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
    return document.querySelector(playerSelector(location.pathname));
  }

  function findVideo() {
    const p = playerEl();
    return p && p.querySelector("video");
  }

  function ensureOverlay() {
    const p = playerEl();
    if (!p) return null;
    if (overlay && overlay.isConnected && overlay.parentElement === p) return overlay;
    overlay = document.createElement("div");
    overlay.className = "dualsubs-overlay";
    // One shared box for both languages. No innerHTML: YouTube enforces Trusted Types.
    const box = document.createElement("div");
    box.className = "ds-box";
    box.style.display = "none";
    for (const cls of ["ds-primary", "ds-secondary"]) {
      const line = document.createElement("div");
      line.className = "ds-line " + cls;
      line.style.display = "none";
      // Spoken part, then the part still to come (invisible, but it keeps its
      // place so the box doesn't jump as words appear).
      line.appendChild(document.createElement("span"));
      const rest = document.createElement("span");
      rest.className = "ds-rest";
      line.appendChild(rest);
      box.appendChild(line);
    }
    overlay.appendChild(box);
    p.appendChild(overlay);
    lastDrawn = null; // a new box starts hidden: force the next frame to fill it
    applyStyle();
    return overlay;
  }

  function applyStyle() {
    if (!overlay) return;
    const p = playerEl();
    // The short side, so a tall Shorts player doesn't get oversized text.
    const h = p ? Math.min(p.clientHeight, p.clientWidth) || p.clientHeight : 480;
    const px = Math.max(12, Math.round((h * settings.fontScale) / 100));
    overlay.style.setProperty("--ds-font", px + "px");
    overlay.style.setProperty("--ds-color2", settings.secondaryColor);
    overlay.style.setProperty("--ds-bg", `rgba(8,8,8,${settings.background})`);
  }

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => applyStyle()) : null;
  let observedPlayer = null;

  function setLine(el, cue) {
    el.firstChild.textContent = cue.text.slice(0, cue.shown);
    el.lastChild.textContent = cue.text.slice(cue.shown);
    el.style.display = cue.text ? "" : "none";
  }

  function render() {
    const ov = ensureOverlay();
    if (!video || !video.isConnected) video = findVideo();
    if (!video || !ov) return;
    const p = ov.parentElement;
    if (ro && p !== observedPlayer) {
      if (observedPlayer) ro.unobserve(observedPlayer);
      ro.observe(p);
      observedPlayer = p;
    }
    const ms = video.currentTime * 1000;
    const a = activeCue(cues.primary, ms);
    let b = activeCue(cues.secondary, ms);
    if (b.text === a.text) b = { text: "", shown: 0 }; // same text in both tracks: show it once
    const drawn = `${a.shown}|${b.shown}|${a.text}|${b.text}`;
    if (drawn === lastDrawn) return;
    const box = ov.firstChild;
    setLine(box.children[0], a);
    setLine(box.children[1], b);
    box.style.display = a.text || b.text ? "" : "none";
    box.classList.toggle("ds-both", !!(a.text && b.text));
    lastDrawn = drawn;
  }

  // Frames are only needed while the video is moving. Paused, the time changes
  // only through a seek, and that arrives as an event.
  function frame() {
    rafId = 0;
    if (!active) return;
    render();
    if (video && !video.paused && !video.ended) rafId = requestAnimationFrame(frame);
  }

  function kick() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  // Media events don't bubble, but they can be captured at the document. That
  // way a replaced <video> element is picked up without re-binding anything.
  const MEDIA_EVENTS = ["play", "playing", "pause", "seeking", "seeked", "timeupdate", "ended", "emptied"];
  function onMedia(ev) {
    const t = ev.target;
    if (!t || t.tagName !== "VIDEO" || !t.closest || !t.closest(playerSelector(location.pathname))) return;
    video = t;
    kick();
  }

  function start() {
    document.documentElement.classList.add("dualsubs-active");
    lastDrawn = null;
    video = findVideo();
    if (!active) {
      active = true;
      for (const type of MEDIA_EVENTS) document.addEventListener(type, onMedia, true);
    }
    kick();
  }

  function stop() {
    document.documentElement.classList.remove("dualsubs-active");
    if (active) {
      active = false;
      for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMedia, true);
    }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    video = null;
    cues = { primary: [], secondary: [] };
    if (overlay) overlay.remove();
    overlay = null;
  }

  function remember(key, list) {
    if (!list.length) return; // a failed download may work next time
    cueCache.delete(key);
    cueCache.set(key, list);
    if (cueCache.size > CUE_CACHE_MAX) cueCache.delete(cueCache.keys().next().value);
  }

  // ---------- main flow ----------
  async function load(videoId) {
    const token = ++loadToken;
    stop();
    if (!settings.enabled) return setStatus("Kapalı.");
    if (!videoId) return;
    setLanguages(null); // refilled below, once the player has told us its tracks

    const wantSecondary =
      settings.secondary && settings.secondary !== "off" && settings.secondary !== settings.primary;
    const pKey = videoId + "|" + settings.primary;
    const sKey = videoId + "|" + settings.secondary;
    const pCached = cueCache.get(pKey);
    const sCached = wantSecondary ? cueCache.get(sKey) : [];
    if (pCached && sCached) {
      // Seen before (e.g. a language switched back): no network, no caption toggling.
      cues = { primary: pCached, secondary: sCached };
      setStatus(`Çalışıyor (önbellek): ${pCached.length} + ${sCached.length} satır.`);
      start();
      // The popup's language list still wants this video's tracks.
      const cachedInfo = await getInfoFor(videoId);
      if (token === loadToken && cachedInfo) {
        setLanguages(cachedInfo);
        publish();
      }
      return;
    }
    setStatus("Video bulundu, altyazılar aranıyor…");

    const info = await getInfoFor(videoId);
    if (token !== loadToken) return;
    setLanguages(info);
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
        // Captions get switched on only to make the player request its file.
        // If the viewer had them off, put that back afterwards.
        const wasOff = pageScriptOk ? !!info && info.captionsOn === false : captionButtonOn() === false;
        if (pageScriptOk) ask("enableCaptions", { languageCode }, 1);
        else clickCaptionButton();
        if (!(await waitForCapture(videoId, 3000)) && token === loadToken) {
          if (pageScriptOk) ask("enableCaptions", { languageCode, force: true }, 1);
          else await clickCaptionButton(true);
          await waitForCapture(videoId, 5000);
        }
        if (wasOff && videoIdFromLocation() === videoId) {
          if (pageScriptOk) ask("disableCaptions", {}, 1);
          else if (captionButtonOn()) captionButton().click();
        }
      }
      if (token !== loadToken) return;
    }
    const captured = capturedByVideo.get(videoId) || null;
    if (!captured && !info) {
      return setStatus(`Altyazı isteği yakalanamadı (${mode}). Videoda CC düğmesine bir kez basmayı dene.`);
    }

    const pList = candidates(info, settings.primary, captured);
    const sList = wantSecondary ? candidates(info, settings.secondary, captured) : [];

    const [pc, sc] = await Promise.all([pCached || fetchFirst(pList), sCached || fetchFirst(sList)]);
    remember(pKey, pc);
    if (wantSecondary) remember(sKey, sc);
    if (token !== loadToken) return;
    if (!pc.length && !sc.length) {
      return setStatus(`Altyazı indirilemedi (${mode}, jeton: ${captured ? "var" : "yok"}).`);
    }
    cues = { primary: pc, secondary: sc };
    const missing = !pc.length ? " Üst dil bulunamadı." : sList.length && !sc.length ? " Alt dil bulunamadı." : "";
    setStatus(`Çalışıyor (${mode}): ${pc.length} + ${sc.length} satır.${missing}`);
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
  // inject.js may have announced itself before this script was listening; ask again.
  window.postMessage({ source: TAG + "_CS", type: "ping" }, "*");

  Promise.resolve(api.storage.local.get(DEFAULTS)).then(init, () => init(DEFAULTS));

  function init(stored) {
    settings = { ...DEFAULTS, ...(stored || {}) };
    // YouTube announces its in-page navigations; back/forward and a tab coming
    // back into view are checked too, as a cheap safety net.
    document.addEventListener("yt-navigate-finish", checkNavigation);
    window.addEventListener("popstate", checkNavigation);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkNavigation();
    });
    // The mobile site doesn't send yt-navigate-finish, so keep watching the URL there.
    if (location.hostname === "m.youtube.com") setInterval(checkNavigation, 1000);
    checkNavigation();
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!SETTING_KEYS.some((k) => k in changes)) return;
    const old = { ...settings };
    for (const k of SETTING_KEYS) if (k in changes) settings[k] = changes[k].newValue ?? DEFAULTS[k];
    const needsReload =
      old.enabled !== settings.enabled || old.primary !== settings.primary || old.secondary !== settings.secondary;
    if (needsReload) {
      if (currentVideo) load(currentVideo);
    } else {
      applyStyle();
    }
  });
})();
