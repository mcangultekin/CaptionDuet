// Runs in the YouTube page itself (not the isolated extension world).
// 1) Watches the player's own /api/timedtext requests. Those URLs carry the
//    "pot" token YouTube now requires, so we reuse them for other languages.
// 2) Exposes the caption track list and can switch captions on.
// 3) Fetches subtitle files with the page's original fetch, so the request
//    looks exactly like the player's own.
(() => {
  // Loaded by the manifest with world: "MAIN". A browser that ignores "world"
  // would run this in the isolated world instead, where it is useless: bail
  // out there, and content.js carries on in fallback mode.
  const ext = globalThis.browser || globalThis.chrome;
  if (ext && ext.runtime && ext.runtime.id) return;
  if (window.__dualSubsInjected) return;
  window.__dualSubsInjected = true;

  const TAG = "DUALSUBS";
  const origFetch = window.fetch.bind(window);

  function report(url) {
    try {
      const abs = new URL(url, location.href).href;
      if (abs.includes("/api/timedtext")) {
        window.postMessage({ source: TAG, type: "timedtext", url: abs }, "*");
      }
    } catch (_) {}
  }

  // --- hook XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    report(String(url));
    return origOpen.apply(this, arguments);
  };

  // --- hook fetch ---
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url) report(url);
    } catch (_) {}
    return origFetch(input, init);
  };

  // Shorts run in their own player; the regular one stays in the page, hidden.
  function player() {
    return document.querySelector(location.pathname.startsWith("/shorts/") ? "#shorts-player" : "#movie_player");
  }

  function getInfo() {
    const p = player();
    let resp = null;
    try {
      resp = p && p.getPlayerResponse ? p.getPlayerResponse() : null;
    } catch (_) {}
    if (!resp) resp = window.ytInitialPlayerResponse || null;
    const r = resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer;
    const tracks = (r && r.captionTracks) || [];
    const text = (n, fallback) => (n && (n.simpleText || (n.runs || []).map((x) => x.text).join(""))) || fallback;
    let captionsOn = null;
    try {
      captionsOn = p && p.isSubtitlesOn ? !!p.isSubtitlesOn() : null;
    } catch (_) {}
    return {
      captionsOn, // null = unknown
      translations: ((r && r.translationLanguages) || []).map((t) => ({
        code: t.languageCode,
        name: text(t.languageName, t.languageCode),
      })),
      videoId: (resp && resp.videoDetails && resp.videoDetails.videoId) || null,
      tracks: tracks.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || "",
        vssId: t.vssId || "",
        isTranslatable: !!t.isTranslatable,
        name: text(t.name, t.languageCode),
      })),
      defaultTrackIndex:
        r && r.audioTracks && r.audioTracks[0] && typeof r.audioTracks[0].defaultCaptionTrackIndex === "number"
          ? r.audioTracks[0].defaultCaptionTrackIndex
          : null,
    };
  }

  // Ask the player to turn captions on, so it requests /api/timedtext itself.
  function enableCaptions(languageCode, force) {
    const p = player();
    if (!p) return false;
    try {
      // Reloading the module makes the player fetch the file again.
      if (force && p.unloadModule) p.unloadModule("captions");
      if (p.loadModule) p.loadModule("captions");
      if (p.setOption) {
        p.setOption("captions", "track", languageCode ? { languageCode } : {});
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Undo enableCaptions for a viewer who had captions off. Unloading the module
  // hides them without touching the viewer's saved caption preference.
  function disableCaptions() {
    const p = player();
    try {
      if (p && p.unloadModule) p.unloadModule("captions");
    } catch (_) {}
  }

  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.origin !== location.origin) return; // not from an embedded frame
    if (!d || typeof d !== "object" || d.source !== TAG + "_CS") return;

    if (d.type === "ping") {
      window.postMessage({ source: TAG, type: "ready" }, "*");
    } else if (d.type === "getInfo") {
      window.postMessage({ source: TAG, type: "info", id: d.id, info: getInfo() }, "*");
    } else if (d.type === "enableCaptions") {
      enableCaptions(d.languageCode, d.force);
    } else if (d.type === "disableCaptions") {
      disableCaptions();
    } else if (d.type === "fetch") {
      let ok = false;
      let text = "";
      try {
        // Subtitle files only: never a general-purpose credentialed fetch.
        const u = new URL(d.url, location.href);
        if (u.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(u.hostname) || !u.pathname.includes("/api/timedtext")) throw new Error("blocked url");
        const res = await origFetch(u.href, { credentials: "include" });
        ok = res.ok;
        text = await res.text();
      } catch (e) {
        text = String(e);
      }
      window.postMessage({ source: TAG, type: "fetchResult", id: d.id, ok, text }, "*");
    }
  });

  window.postMessage({ source: TAG, type: "ready" }, "*");
})();
