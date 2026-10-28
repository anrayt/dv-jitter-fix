# DV Jitter Fix — notes for Claude

Static web page that removes the every-other-frame vertical shake from camcorder clips captured
through an ImmersionRC PowerPlay DVR. Everything runs in the browser (WebCodecs); no build step,
no server code, no npm. Live at https://dv-jitter-fix.onrender.com, repo https://github.com/anrayt/dv-jitter-fix.

## The owner

- Writes in Russian; answer in Russian. The page UI and README are in English.
- Priorities: **output quality first**, then a dead-simple one-step UI. Prove quality claims with
  numbers from `dev/check.py`, not by eye.
- Asked for, and must stay this way: no animations (REC dot is static red), no timecode, no OSD
  labels at the bottom of the drop zone, no MiniDV/PAL/PowerPlay eyebrow, no zip / "Save all",
  a red **BETA** pill above the title with no subtitle, footer link to "Run it locally" in the README,
  CSS in `style.css`, JS in `app.js`. No "Deploy on Render" section in the README.
- Their test clips: `~/Downloads/REC20261027-*.mov` (5 clips, Sony DCR-PC115E → PowerPlay, HEVC
  720×576 50p, AAC 32 kHz mono, ~1 s hidden pre-roll via MOV edit list).

## Files

- `index.html` — markup only. `style.css` — tokens on `:root`, dark mode duplicated under
  `@media (prefers-color-scheme: dark)` and `[data-theme="dark"]`.
- `app.js` — one IIFE, sections in pipeline order (see below).
- `lib/mp4box.all.min.js` (0.5.2, demux), `lib/mp4-muxer.js` (5.1.3, mux). Vendored, don't edit.
- `render.yaml` — static site, publish dir `./`.
- `dev/` — test tools (below). Served on Render too; harmless.

## Pipeline (app.js)

1. `demux` — mp4box reads the whole file; collects samples, avcC/hvcC, AAC config (falls back to
   scanning for `esds`, then to building an AAC-LC config). `editStart` reads the edit list:
   `vStart`/`aStart` = first shown media time. Frames before it are decoded (needed as references)
   but **not encoded**; audio samples before it are dropped.
2. Frame timing — `frameDur` = median delta of **sorted** cts (samples are in decode order; with
   B-frames that is not display order — this once produced "13 fps"). `frameNo(us)` turns a
   timestamp into a frame number, so a timestamp gap keeps parity right.
3. `readI420` — `VideoFrame.copyTo` into tightly packed I420 (handles I420/I420A/NV12). Any other
   format falls back to canvas RGBA → BT.601 limited YUV and sets `viaRgb` (shown in the clip meta).
   Working on YUV directly is why colour drift is <0.1/255.
4. `analyse` (pass 1, whole clip) — for each frame with both neighbours present (n±1): luma cropped
   (`MX`=60, `MY`=40), averaged in `BX`=8 px column blocks, binomial-smoothed down columns
   (`lumaGrid`), then `err` = MSE vs the neighbour average shifted by s (Catmull-Rom), over
   `GRID` −2.5…2.5 step 0.1. Each curve is divided by its mean and stored.
5. `solve` — `fitJump` sums parity-signed curves (sign −1 mirrors the curve) and takes the parabola
   minimum → `off` (odd frames sit at +off: `odd(y) = even(y − off)`). `findFlips` scores each frame
   (`at(−p·off) − at(p·off)`), labels by a ±`WIN`=12 window (needs 60 % agreement), merges runs
   shorter than WIN, places each boundary on the best-splitting frame → `segs` [{from: frameNo,
   flip: ±1}]. Re-fit twice with the new signs. `contrast` < `MIN_CONTRAST` (0.02) = unsure.
   With `borrowed` (median of `known` jumps from this session) only the direction is decided
   (needs ≥20 frames and 20 % net agreement), else unsure → saved unchanged.
6. Batch borrowing — `run()` re-queues a job when `processFile` throws `DEFER` (unsure, nothing in
   `known`, other non-deferred jobs waiting). `job.analysis` is cached so it isn't re-measured.
7. `splitShift(off)` — e = off − round(off); even frames move −e/2, odd frames round(off)+e/2, so
   each frame is at most ¼ px off-grid and both get the same treatment. Frame sign in pass 2 =
   `parity(n) * flipAt(segs, n)`; `needs` only if |off| ≥ 0.1. `shiftPlane` — Lanczos-8 (16 taps,
   `TAPS`), weights normalised, edge rows repeated; `out(y) = in(y + t)`, chroma by t/2. Whole-pixel
   t is a plain row copy. Owner needs sharpness: Lanczos-3 kept ~91 % of fine vertical detail, a
   whole-pixel-only move kept 100 % but left 0.2–0.5 px of jitter; Lanczos-8 keeps ~99.6 % with no
   jitter left. Don't shorten the filter.
8. `paintBars` — `bar` = rows pulled in from outside (ceil of the largest |shift|) rounded up to even; the top and bottom `bar` luma rows (bar/2 chroma
   rows) are painted black (Y 16, UV 128) on **every** frame, so the border doesn't flicker. Size
   stays as in the input: no crop, no scaling.
9. Encode — H.264 level 4.1 (High → Main → Baseline, first supported; 4.0 caps at 25 Mbit/s), VBR at the bitrate from the `#quality` select (40 default / 24 / 16 Mbit/s, ≈290 / 175 / 115 MB per
   minute; 94 / 88 / 84 % of horizontal detail on clip 177), remembered in localStorage, `latencyMode: quality`,
   key frame every 50 encoded frames, frames tagged BT.601 (`SD_COLOR`). Timestamps = source − start,
   so frame count and timing match the source 1:1. Audio is copied, not re-encoded.
10. Save — desktop: `<a download>`. Touch devices with `navigator.canShare({files})`: share sheet
    (iOS "Save Video" puts it in Photos; plain downloads land in Files). AbortError = user closed it.

Progress bar: 0–0.4 analysing, 0.4–1 encoding. The clip meta line shows size/fps/duration, the
jump, "N frame-order slip(s) found", "(size taken from your other clips)", or why it was left as is.

## Reference numbers (owner's clips, keep these as regression targets)

Residuals below were measured with Lanczos-3 and full-height output; re-measure with Lanczos-8 and the
black bars when the clips are back (expect the same residuals, more detail).

| clip | jump (check.py) | page | residual after fix |
|---|---|---|---|
| 175 | −1.42 | −1.34 | ≤0.15 along the clip |
| 177 | 1.30 | −1.39 | 0.1–0.3 (handheld) |
| 178 | −1.21 | +1.17 | ≤0.10 |
| 179 | −1.50 (dark, handheld) | −1.48 | ~0.2 |
| 180 | −1.23 | −1.22 | ≤0.05 |

Signs can differ between the columns: the page counts frame parity from the first decoded frame
(pre-roll included), ffmpeg from the first shown one. Compare magnitudes.
Frame counts must match ffmpeg's visible count (402/361/231/122/183). Colour drift ≤0.06/255.
Detail 92–105 % of source. Synthetic tests: a frame dropped with renumbered timestamps must report
1 slip and stay ≈±0.1 on both sides; a dropped frame with a timestamp gap must report 0 slips.
The old page (before Oct 2026 rewrite) measured 0 on every clip and changed nothing — don't trust
any number that wasn't measured.

## Testing

Headless Chrome here **cannot read files from disk** (sandbox → `NotFoundError` on
`file.arrayBuffer()`), so clips are served over HTTP and injected as `File`s.

```sh
mkdir -p dev/clips && cp ~/Downloads/REC20261027-*.mov dev/clips/
python3 -m http.server 8811 --bind 127.0.0.1 &          # from repo root
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=<scratch>/chrome-prof --disk-cache-size=1 about:blank &
node dev/drive.mjs http://127.0.0.1:8811/ dev/out REC20261027-154809-180.mov
python3 -m venv dev/.venv && dev/.venv/bin/pip install numpy     # once
dev/.venv/bin/python dev/check.py compare dev/clips/X.mov dev/out/X_fixed.mp4
dev/.venv/bin/python dev/check.py along dev/out/X_fixed.mp4
```

Gotchas learned the hard way:
- Pass **one clip per drive.mjs run**; several large blobs in one tab spill to disk and fail to read.
- `drive.mjs` disables the HTTP cache; without it Chrome served a stale `app.js`.
- Don't pipe/redirect a node script that ends with `process.exit()` — buffered output is lost.
  `drive.mjs` closes its socket instead.
- `check.py` must smooth before fitting, or noisy dark footage reads ~0.4 px of fake residual.
- Kill Chrome and the servers when done (`pkill -f remote-debugging-port=9333`, `pkill -f http.server`).
- Syntax check: `node --check app.js`. Unit-test pure functions in Node by slicing them out of
  app.js with `new Function(src.slice(a, b) + 'return {…}')()`.
- Screenshots: CDP `Emulation.setDeviceMetricsOverride` at 1000 px and 390 px.

## Git and deploy

- Remote `origin` = https://github.com/anrayt/dv-jitter-fix.git, branch `main`. HTTPS push works via
  the macOS keychain (`GIT_TERMINAL_PROMPT=0 git push`); `gh` is installed but not logged in, SSH key
  is not on GitHub.
- Render auto-deploys on every push to `main`. Publish Directory must be `.` — it was once set to
  `libs` and the whole site 404'd. Render's root URL serves `index.html` by itself.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
