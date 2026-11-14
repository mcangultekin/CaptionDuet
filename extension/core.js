// Pure logic shared by content.js and popup.js: no DOM, no extension APIs.
// Kept separate so it can be tested outside the browser (see tests/).
(() => {
  const DEFAULTS = {
    enabled: true,
    primary: "auto", // "auto" = the video's own language
    secondary: "tr",
    fontScale: 4.2, // % of player height
    secondaryColor: "#ffd75e",
    background: 0.55,
  };

  const here = () => (globalThis.location ? globalThis.location.href : "https://www.youtube.com/");

  // www and m share the subtitle endpoint, so compare the site, not the exact origin.
  const isYouTube = (u) => u.protocol === "https:" && /(^|\.)youtube\.com$/.test(u.hostname);

  // A subtitle URL we are willing to fetch with cookies; null otherwise.
  function timedtextUrl(raw, base = here()) {
    try {
      const u = new URL(raw, base);
      return isYouTube(u) && u.pathname.includes("/api/timedtext") ? u : null;
    } catch (_) {
      return null;
    }
  }

  // Pages that have a player: /watch?v=ID, /shorts/ID, /live/ID.
  function videoIdFromUrl(pathname, search = "") {
    if (pathname === "/watch") return new URLSearchParams(search).get("v") || null;
    const m = /^\/(?:shorts|live)\/([\w-]{6,})/.exec(pathname);
    return m ? m[1] : null;
  }

  // Shorts run in their own player; the regular one stays in the page, hidden.
  function playerSelector(pathname) {
    return pathname.startsWith("/shorts/") ? "#shorts-player" : "#movie_player";
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

  function withToken(baseUrl, captured, base = here()) {
    const u = new URL(baseUrl, base);
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
  function candidates(info, lang, captured, base = here()) {
    const out = [];
    const tracks = info && info.tracks;

    if (tracks && tracks.length) {
      const original = pickOriginal(tracks);
      if (lang === "auto") {
        if (original) out.push(withToken(original.baseUrl, captured, base).href);
      } else {
        const own =
          tracks.find((t) => t.kind !== "asr" && t.languageCode === lang) ||
          tracks.find((t) => t.kind !== "asr" && sameLang(t.languageCode, lang)) ||
          tracks.find((t) => t.kind === "asr" && sameLang(t.languageCode, lang));
        if (own) out.push(withToken(own.baseUrl, captured, base).href);
        const src =
          (original && original.isTranslatable && original) ||
          tracks.find((t) => t.isTranslatable && t.kind !== "asr") ||
          tracks.find((t) => t.isTranslatable);
        if (src) {
          const u = withToken(src.baseUrl, captured, base);
          u.searchParams.set("tlang", lang);
          out.push(u.href);
        }
      }
    }

    // Fallback: rewrite the player's own request (lang isn't signed).
    if (captured) {
      const b = new URL(captured);
      b.searchParams.set("fmt", "json3");
      b.searchParams.delete("tlang");
      if (lang === "auto") {
        out.push(b.href);
      } else {
        const own = new URL(b.href);
        own.searchParams.set("lang", lang);
        own.searchParams.delete("kind");
        own.searchParams.delete("name");
        out.push(own.href);
        const tr = new URL(b.href);
        tr.searchParams.set("tlang", lang);
        out.push(tr.href);
      }
    }
    return [...new Set(out)];
  }

  // Language a subtitle URL will return.
  function langOfUrl(url, base = here()) {
    try {
      const p = new URL(url, base).searchParams;
      return p.get("tlang") || p.get("lang") || "";
    } catch (_) {
      return "";
    }
  }

  function parseJson3(text, lang = "") {
    // French puts a space before ? ! ; : and inside « », so leave it alone there.
    const tighten = !/^fr\b/i.test(lang);
    const clean = (raw) => {
      // Drop YouTube's hard line breaks and let the browser wrap the text.
      let t = raw.replace(/\u200b/g, "").replace(/\s+/g, " ");
      if (tighten) {
        // Auto-translations often put a space before punctuation ("olabilir ?").
        t = t.replace(/ +([?!.,;:…)\]»”])/g, "$1").replace(/([(\[«“¿¡]) +/g, "$1");
      }
      return t.trim();
    };
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return [];
    }
    const out = [];
    for (const e of (data && data.events) || []) {
      if (!e.segs) continue;
      const t = clean(e.segs.map((s) => s.utf8 || "").join(""));
      if (!t) continue;
      const start = e.tStartMs || 0;
      const cue = { start, end: start + (e.dDurationMs || 2000), text: t };
      // Auto-generated tracks time each word. Keep [offsetMs, characters shown]
      // steps so the line can fill in as it is spoken.
      if (e.segs.some((s) => s.tOffsetMs > 0)) {
        const steps = [];
        let raw = "";
        for (const s of e.segs) {
          raw += s.utf8 || "";
          const shown = Math.min(clean(raw).length, t.length);
          const at = s.tOffsetMs || 0;
          const last = steps[steps.length - 1];
          if (last && last[0] >= at) last[1] = shown;
          else steps.push([at, shown]);
        }
        cue.steps = steps;
      }
      out.push(cue);
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // Active cue = the most recently started cue that has not ended yet.
  // Returns its text and how many of its characters have been spoken so far.
  function activeCue(list, ms) {
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
      const c = list[i];
      if (c.end <= ms) continue;
      let shown = c.text.length;
      if (c.steps) {
        shown = 0;
        for (const [at, n] of c.steps) {
          if (c.start + at > ms) break;
          shown = n;
        }
      }
      return { text: c.text, shown };
    }
    return { text: "", shown: 0 };
  }

  const activeText = (list, ms) => activeCue(list, ms).text;

  globalThis.DualSubsCore = {
    DEFAULTS,
    isYouTube,
    timedtextUrl,
    videoIdFromUrl,
    playerSelector,
    pickOriginal,
    sameLang,
    withToken,
    candidates,
    langOfUrl,
    parseJson3,
    activeCue,
    activeText,
  };
})();
