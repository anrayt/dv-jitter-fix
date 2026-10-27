# DV Jitter Fix

Removes the up-and-down shake from camcorder clips recorded through a DVR
(ImmersionRC PowerPlay and similar). The DVR saves each interlaced half-frame
as its own frame, so every second frame sits about 1 px higher or lower.
The page measures that jump over the whole clip and moves the frames back into line. It also
follows the frame order through dropped frames, and lends the jump size from other clips in the
same batch to a clip too dark or flat to measure on its own.

Everything runs in the browser (WebCodecs). Videos are never uploaded.
Works in Chrome / Edge on desktop and Safari 17+ on Mac and iPhone.
HEVC clips need Safari or Chrome on a Mac.

## Deploy on Render

1. Put this folder in a GitHub repo (index.html, style.css, app.js, lib/, render.yaml at the root).
2. Render dashboard -> New -> Blueprint -> pick the repo -> Apply.
   (Or New -> Static Site, Build Command: leave the default echo, Publish directory: `./`.)
3. Render gives you a URL like https://dv-jitter-fix.onrender.com

## Files

- `index.html` - page markup
- `style.css` - styles
- `app.js` - measuring, shifting and re-encoding the clips
- `lib/` - mp4box.js 0.5.2 (read MOV/MP4), mp4-muxer 5.1.3 (write MP4)
- `render.yaml` - Render static site config
