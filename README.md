# DV Jitter Fix (beta)

Removes the up-and-down shake from camcorder clips recorded through a DVR
(ImmersionRC PowerPlay and similar). The DVR saves each interlaced half-frame
as its own frame, so every second frame sits about 1 px higher or lower.
The page measures that jump over the whole clip and moves the frames back into line. It also
follows the frame order through dropped frames, and lends the jump size from other clips in the
same batch to a clip too dark or flat to measure on its own.

Everything runs in the browser (WebCodecs). Videos are never uploaded.
Works in Chrome / Edge on desktop and Safari 17+ on Mac and iPhone.
HEVC clips need Safari or Chrome on a Mac.

## Run it locally

The page needs no install or build. It runs on your computer the same way it runs online,
and it works without internet. Only the fonts need a connection; without it the page falls back
to system fonts.

### 1. Get the files

- **Without git:** on the GitHub page press **Code → Download ZIP** and unzip it.
- **With git:**
  ```sh
  git clone https://github.com/anrayt/dv-jitter-fix.git
  ```

### 2. Start a local server

Open Terminal in the `dv-jitter-fix` folder. On a Mac: right-click the folder in Finder,
then **New Terminal at Folder**. Run:

```sh
python3 -m http.server 8000
```

Python comes with macOS. On Windows, install it from [python.org](https://www.python.org/downloads/)
first, then run `python -m http.server 8000`.

### 3. Open the page

Go to **http://localhost:8000** in Chrome, Edge or Safari, then drop your clips onto it.

To stop the server, press **Ctrl + C** in Terminal.

> Opening `index.html` straight from the folder (double-click) often works in Chrome too, but some
> browsers block video processing on pages opened that way. The local server always works.

## Files

- `index.html` - page markup
- `style.css` - styles
- `app.js` - measuring, shifting and re-encoding the clips
- `lib/` - mp4box.js 0.5.2 (read MOV/MP4), mp4-muxer 5.1.3 (write MP4)
- `render.yaml` - Render static site config
