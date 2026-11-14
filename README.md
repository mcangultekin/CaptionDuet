# CaptionDuet

A Safari extension that shows two subtitle tracks at once on YouTube videos: the
video's own language on top (for example English) and a language you choose below
(for example German). When the video has no track in that language, YouTube's own
automatic translation is used.

> The popup and its status messages are currently in Turkish.

## Install

### Temporary (no Xcode needed)

1. Safari > Settings > Advanced > tick **"Show features for web developers"**.
2. Safari > Settings > **Developer** tab > **"Add Temporary Extension…"**.
3. Choose the `extension` folder. In the Extensions tab, enable CaptionDuet and allow it
   on youtube.com.

A temporary extension is removed when Safari quits; repeat steps 2–3 after reopening it.

### Permanent (needs Xcode)

1. Install Xcode from the App Store and open it once.
2. Make Xcode the active developer directory:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   ```
3. Create the app project:
   ```bash
   xcrun safari-web-extension-converter extension/ --project-location xcode --macos-only
   ```
4. Run the project in Xcode (⌘R), then enable CaptionDuet in Safari > Settings >
   Extensions. An unsigned build also needs Safari > Developer > "Allow Unsigned
   Extensions".

## Use

- Click the CaptionDuet icon in the toolbar to switch it on or off and to set the top
  and bottom languages, text size, background opacity and the bottom line's colour.
- The language menus list the open video's own subtitle tracks first, then every
  language YouTube can auto-translate to. The status line belongs to the video in the
  current tab.
- Works on regular videos, Shorts and live pages.
- On auto-generated captions the line holds its place and words appear as they are spoken.
- While the extension is on, YouTube's own captions are hidden. If you keep captions
  off, the extension switches them on for a moment to obtain the token, then off again.

### Known limits

- Players embedded on other sites (`/embed/`) are not supported.
- For videos without auto-generated captions, YouTube does not say which language is
  spoken. "The video's own language" then picks the first track in the list, which can
  be the wrong one; choose the language from the menu instead.

## How it works

YouTube only serves subtitle files to requests that carry a token (`pot`) produced by
its player. `inject.js` observes the player's own subtitle request, and `content.js`
reuses that token to download both languages as `json3` and draws them in sync with
the video.

| File | Role |
|---|---|
| `manifest.json` | Extension definition (Manifest V3) |
| `inject.js` | Runs inside the page: observes the subtitle request, lists the tracks, downloads |
| `core.js` | Pure logic: language choice, URL building, `json3` parsing, active line |
| `content.js` | Drives the flow and draws the overlay |
| `overlay.css` | Look of the subtitle overlay |
| `popup.*` | Settings menu |

The manifest loads `inject.js` straight into the page with `"world": "MAIN"` (confirmed
in Safari). If the page script does not answer, the extension falls back to reading the
player's request from the Performance API. The popup's status line shows which path is
in use: `tam mod` (full mode) or `yedek mod` (fallback mode).

## Tests

The tests need a real `URL` implementation, so they run in a browser:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

- <http://127.0.0.1:8765/tests/> — unit tests for `core.js`.
- <http://127.0.0.1:8765/tests/smoke.html> — the real `inject.js` and `content.js` wired
  end to end against a fake player. Keep the tab in front: a background tab gets no
  animation frames, so the test would wait forever.
- <http://127.0.0.1:8765/tests/popup.html> — the real popup against a fake tab.

The tab title becomes `PASS` or `FAIL`. The sample subtitle files are hand-written in
YouTube's `json3` shape, not recorded responses, so the tests cannot tell whether
YouTube's behaviour has changed.

## License

[MIT](LICENSE) © 2026 M. Can Gültekin

## Legal

CaptionDuet is an independent project. It is not affiliated with, endorsed by or
sponsored by YouTube or Google. YouTube is a trademark of Google LLC and is mentioned
here only to say which site the extension works on.
