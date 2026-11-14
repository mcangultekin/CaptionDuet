// Core logic tests. They need a real URL implementation, so they run in a
// browser: serve the repo root and open tests/ (see README).
// The fixtures are hand-written in YouTube's json3 shape, not recorded responses.
(async () => {
const C = globalThis.DualSubsCore;
const out = [];
let failed = 0;
let count = 0;
function eq(name, got, want) {
  count++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    out.push(`FAIL ${name}\n   got: ${g}\n  want: ${w}`);
  }
}
const fixture = async (name) => (await fetch("fixtures/" + name)).text();
const MANUAL = await fixture("manual.en.json3");
const ASR = await fixture("asr.en.json3");
const texts = (list) => list.map((c) => c.text);
const BASE = "https://www.youtube.com/watch?v=VID";
const TT = "https://www.youtube.com/api/timedtext";

// ---- parseJson3 ----
const manual = C.parseJson3(MANUAL, "en");
eq("manual: joins lines, tightens punctuation, sorts", texts(manual), [
  "Hello and welcome to the show.",
  "Is this (really) working?",
  "Out of order cue",
  "No duration here.",
]);
eq("manual: timing", [manual[0].start, manual[0].end], [1200, 3600]);
eq("manual: default duration is 2s", manual[3].end - manual[3].start, 2000);

const asr = C.parseJson3(ASR, "en");
eq("asr: skips window and newline events", texts(asr), ["so today we begin", "with the basics"]);

const fr = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Comment ça va ? « Bien » !" }] }] });
eq("french keeps its spaces", texts(C.parseJson3(fr, "fr")), ["Comment ça va ? « Bien » !"]);
eq("french-canadian too", texts(C.parseJson3(fr, "fr-CA")), ["Comment ça va ? « Bien » !"]);
eq("other languages are tightened", texts(C.parseJson3(fr, "tr")), ["Comment ça va? «Bien»!"]);
eq("empty body (missing token)", C.parseJson3(""), []);
eq("not json", C.parseJson3("<html>"), []);
eq("json null", C.parseJson3("null"), []);
eq("no events", C.parseJson3("{}"), []);

// ---- activeText ----
eq("before first cue", C.activeText(manual, 0), "");
eq("inside a cue", C.activeText(manual, 2000), "Hello and welcome to the show.");
eq("exact start", C.activeText(manual, 3600), "Is this (really) working?");
eq("gap between cues", C.activeText(manual, 8000), "");
eq("after the last cue", C.activeText(manual, 60000), "");
eq("empty list", C.activeText([], 100), "");
eq("asr: overlapping cues show the newest", C.activeText(asr, 3000), "with the basics");
eq("asr: first line while alone", C.activeText(asr, 1000), "so today we begin");

// ---- word timing ----
eq("asr: steps are [offset, characters shown]", asr[0].steps, [[0, 2], [200, 8], [520, 11], [700, 17]]);
eq("manual: no steps", manual[0].steps, undefined);
const said = (ms) => {
  const c = C.activeCue(asr, ms);
  return c.text.slice(0, c.shown);
};
eq("asr: first word at the cue start", said(80), "so");
eq("asr: words appear as spoken", said(80 + 520), "so today we");
eq("asr: whole line once spoken", said(80 + 700), "so today we begin");
eq("manual: whole line at once", C.activeCue(manual, 2000), { text: "Hello and welcome to the show.", shown: 30 });
eq("nothing active", C.activeCue(manual, 0), { text: "", shown: 0 });
const spaced = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "Wenn " }, { utf8: "ich ", tOffsetMs: 200 }, { utf8: "?", tOffsetMs: 400 }] }] });
eq("steps follow the cleaned-up text", C.parseJson3(spaced, "de")[0], { start: 0, end: 900, text: "Wenn ich?", steps: [[0, 4], [200, 8], [400, 9]] });

// ---- pages ----
eq("watch page", C.videoIdFromUrl("/watch", "?v=abc123XYZ_-&t=5"), "abc123XYZ_-");
eq("watch page without v", C.videoIdFromUrl("/watch", ""), null);
eq("shorts page", C.videoIdFromUrl("/shorts/abc123XYZ_-"), "abc123XYZ_-");
eq("live page", C.videoIdFromUrl("/live/abc123XYZ_-", "?si=x"), "abc123XYZ_-");
eq("home page", C.videoIdFromUrl("/", ""), null);
eq("shorts index", C.videoIdFromUrl("/shorts/"), null);
eq("channel page", C.videoIdFromUrl("/@someone/shorts"), null);
eq("regular player", C.playerSelector("/watch"), "#movie_player");
eq("shorts player", C.playerSelector("/shorts/abc123XYZ_-"), "#shorts-player");

// ---- langOfUrl / timedtextUrl ----
eq("lang", C.langOfUrl(TT + "?v=VID&lang=en", BASE), "en");
eq("tlang wins", C.langOfUrl(TT + "?v=VID&lang=en&tlang=fr", BASE), "fr");
eq("bad url", C.langOfUrl("http://[", BASE), "");
eq("timedtext ok", !!C.timedtextUrl(TT + "?v=VID", BASE), true);
eq("relative ok", !!C.timedtextUrl("/api/timedtext?v=VID", BASE), true);
eq("mobile host ok", !!C.timedtextUrl("https://m.youtube.com/api/timedtext?v=VID", BASE), true);
eq("other host rejected", C.timedtextUrl("https://evil.example/api/timedtext?v=VID", BASE), null);
eq("lookalike host rejected", C.timedtextUrl("https://notyoutube.com/api/timedtext?v=VID", BASE), null);
eq("http rejected", C.timedtextUrl("http://www.youtube.com/api/timedtext?v=VID", BASE), null);
eq("other path rejected", C.timedtextUrl("https://www.youtube.com/youtubei/v1/player", BASE), null);

// ---- pickOriginal ----
const T = (languageCode, kind = "", isTranslatable = true) => ({
  baseUrl: `${TT}?v=VID&lang=${languageCode}${kind ? "&kind=" + kind : ""}&signature=SIG&expire=9`,
  languageCode,
  kind,
  isTranslatable,
});
eq("original: manual track in the spoken language", C.pickOriginal([T("de"), T("en"), T("en", "asr")]).kind, "");
eq("original: spoken language", C.pickOriginal([T("de"), T("en"), T("en", "asr")]).languageCode, "en");
eq("original: asr when no manual match", C.pickOriginal([T("de"), T("en", "asr")]).kind, "asr");
eq("original: first track without asr", C.pickOriginal([T("de"), T("en")]).languageCode, "de");
eq("original: none", C.pickOriginal([]), null);

// ---- withToken ----
const CAP = TT + "?v=VID&lang=en&kind=asr&fmt=srv3&pot=POT&c=WEB&signature=OLD&tlang=xx";
const wt = C.withToken(T("de").baseUrl, CAP, BASE).searchParams;
eq("token copied", [wt.get("pot"), wt.get("c")], ["POT", "WEB"]);
eq("track's own params kept", [wt.get("lang"), wt.get("signature"), wt.get("kind")], ["de", "SIG", null]);
eq("json3, no tlang", [wt.get("fmt"), wt.get("tlang")], ["json3", null]);
eq("no capture", C.withToken(T("de").baseUrl, null, BASE).searchParams.get("pot"), null);

// ---- candidates ----
const q = (href) => {
  const p = new URL(href).searchParams;
  return [p.get("lang"), p.get("kind"), p.get("tlang"), p.get("pot"), p.get("fmt")].join("|");
};
const info = { tracks: [T("en", "asr"), T("de")] };
// Track URLs come first; the rewritten player request (its own signature) is the spare.
eq("auto: original track, then the player's own request", C.candidates(info, "auto", CAP, BASE).map(q), [
  "en|asr||POT|json3",
  "en|asr||POT|json3",
]);
eq("own track first, then translation", C.candidates(info, "de", CAP, BASE).map(q), [
  "de|||POT|json3",
  "en|asr|de|POT|json3",
  "de|||POT|json3",
  "en|asr|de|POT|json3",
]);
eq("missing language: translation, then rewritten request", C.candidates(info, "tr", CAP, BASE).map(q), [
  "en|asr|tr|POT|json3",
  "tr|||POT|json3",
  "en|asr|tr|POT|json3",
]);
eq("candidates are unique", new Set(C.candidates(info, "de", CAP, BASE)).size, 4);
eq("regional variant matches", C.candidates({ tracks: [T("en-GB")] }, "en", null, BASE).map(q)[0], "en-GB||||json3");
eq("fallback mode, auto", C.candidates(null, "auto", CAP, BASE).map(q), ["en|asr||POT|json3"]);
eq("fallback mode, language", C.candidates(null, "tr", CAP, BASE).map(q), ["tr|||POT|json3", "en|asr|tr|POT|json3"]);
eq("nothing to go on", C.candidates(null, "tr", null, BASE), []);
eq("no translatable source", C.candidates({ tracks: [T("en", "", false)] }, "tr", null, BASE), []);

out.push(`${count - failed}/${count} passed`);
globalThis.testResult = { count, failed, text: out.join("\n") };
document.getElementById("out").textContent = globalThis.testResult.text;
document.title = failed ? "FAIL" : "PASS";
})().catch((e) => {
  globalThis.testResult = { count: 0, failed: 1, text: "CRASH " + (e && e.stack ? e.stack : e) };
  document.getElementById("out").textContent = globalThis.testResult.text;
  document.title = "FAIL";
});
