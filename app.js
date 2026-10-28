(() => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const supported = 'VideoDecoder' in window && 'VideoEncoder' in window && 'VideoFrame' in window;
  if (!supported) $('unsupported').hidden = false;

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  const results = []; // {name, blob}
  window.__results = results;
  const queue = [];
  const known = []; // jump sizes measured with confidence in this session, lent to flat clips
  let busy = false;

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, () => drop.classList.remove('drag')));
  drop.addEventListener('drop', (ev) => { ev.preventDefault(); addFiles(ev.dataTransfer.files); });
  drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('pick').click(); } });
  $('pick').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });

  function addFiles(list) {
    if (!supported) return;
    const files = [...list].filter((f) => /\.(mov|mp4|m4v)$/i.test(f.name) || f.type.startsWith('video/'));
    if (!files.length) return;
    $('tapesWrap').hidden = false;
    for (const file of files) queue.push({ file, ui: makeTape(file.name) });
    run();
  }

  function makeTape(name) {
    const el = document.createElement('div');
    el.className = 'tape';
    el.innerHTML = `<div class="name"></div><span class="state">Queued</span><div class="bar"><i></i></div><div class="meta"></div>`;
    el.querySelector('.name').textContent = name;
    $('tapes').appendChild(el);
    return {
      el,
      state(text, cls) { const s = el.querySelector('.state'); s.textContent = text; s.className = 'state ' + (cls || ''); },
      progress(p) { el.querySelector('.bar > i').style.width = Math.round(p * 100) + '%'; },
      meta(html) { el.querySelector('.meta').innerHTML = html; },
    };
  }

  async function run() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      try { await processFile(job); }
      catch (err) {
        if (err === DEFER) {
          job.deferred = true;
          queue.push(job);
          job.ui.state('Waiting', 'work');
          job.ui.meta('Too little detail to measure. Waiting for the other clips to borrow their jump.');
          continue;
        }
        console.error(err);
        job.ui.state('Failed', 'err');
        job.ui.meta(escapeHtml(err && err.message ? err.message : String(err)));
      }
    }
    busy = false;
  }

  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- demux ----------
  function demux(file) {
    return new Promise(async (resolve, reject) => {
      let buf;
      try { buf = await file.arrayBuffer(); } catch (e) { return reject(new Error('Could not read this file: ' + e.message)); }
      const mp4 = MP4Box.createFile();
      const out = { video: null, audio: null, vSamples: [], aSamples: [] };
      mp4.onError = (e) => reject(new Error('Could not read this file: ' + e));
      mp4.onReady = (info) => {
        out.info = info;
        out.video = info.videoTracks[0] || null;
        out.audio = info.audioTracks[0] || null;
        if (!out.video) return reject(new Error('No video track in this file.'));
        mp4.setExtractionOptions(out.video.id, 'v', { nbSamples: 1e9 });
        if (out.audio) mp4.setExtractionOptions(out.audio.id, 'a', { nbSamples: 1e9 });
        mp4.start();
      };
      mp4.onSamples = (id, user, samples) => {
        (user === 'v' ? out.vSamples : out.aSamples).push(...samples);
      };
      buf.fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();
      if (!out.video) return reject(new Error('This file is not a video MP4/MOV.'));
      // descriptions
      const vt = mp4.getTrackById(out.video.id);
      const ve = vt.mdia.minf.stbl.stsd.entries[0];
      const box = ve.avcC || ve.hvcC || ve.vpcC || ve.av1C;
      if (box) {
        const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(s);
        out.vDesc = new Uint8Array(s.buffer, 8);
      }
      if (out.audio) {
        const at = mp4.getTrackById(out.audio.id);
        const ae = at.mdia.minf.stbl.stsd.entries[0];
        try {
          const dsi = ae.esds.esd.descs[0].descs[0].data;
          out.aDesc = new Uint8Array(dsi);
        } catch { out.aDesc = findEsdsConfig(new Uint8Array(buf)); }
        // QuickTime .mov hides esds inside a 'wave' atom: fall back to building AAC-LC config
        if (!out.aDesc && /^mp4a/.test(out.audio.codec)) out.aDesc = aacLcConfig(out.audio.audio.sample_rate, out.audio.audio.channel_count);
        if (out.audio.codec === 'mp4a') out.audio.codec = 'mp4a.40.2';
      }
      // MOV edit lists hide the frames recorded before the start point (the DVR keeps ~1 s of pre-roll)
      out.vStart = editStart(mp4, out.video.id);
      out.aStart = out.audio ? editStart(mp4, out.audio.id) : 0;
      resolve(out);
    });
  }

  // walk an 'esds' atom found anywhere in the file to its DecoderSpecificInfo
  function findEsdsConfig(u) {
    const readLen = (p) => { let len = 0, b, n = 0; do { b = u[p++]; len = (len << 7) | (b & 0x7f); n++; } while (b & 0x80 && n < 4); return [len, p]; };
    for (let i = 0; i < u.length - 40; i++) {
      if (u[i] !== 0x65 || u[i + 1] !== 0x73 || u[i + 2] !== 0x64 || u[i + 3] !== 0x73) continue; // 'esds'
      try {
        let p = i + 8, l;
        if (u[p++] !== 0x03) continue;
        [l, p] = readLen(p); p += 2;
        const flags = u[p++];
        if (flags & 0x80) p += 2;
        if (flags & 0x40) p += 1 + u[p];
        if (flags & 0x20) p += 2;
        if (u[p++] !== 0x04) continue;
        [l, p] = readLen(p); p += 13;
        if (u[p++] !== 0x05) continue;
        [l, p] = readLen(p);
        if (l < 2 || l > 64) continue;
        return u.slice(p, p + l);
      } catch { /* keep scanning */ }
    }
    return null;
  }
  function aacLcConfig(rate, ch) {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const fi = rates.indexOf(rate);
    if (fi < 0 || !ch) return null;
    return new Uint8Array([(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]);
  }

  function editStart(mp4, id) {
    const e = mp4.getTrackById(id).edts?.elst?.entries?.find((x) => x.media_time >= 0);
    return e ? e.media_time : 0;
  }

  function chunkFor(sample, timescale) {
    return new EncodedVideoChunk({
      type: sample.is_sync ? 'key' : 'delta',
      timestamp: Math.round(sample.cts * 1e6 / timescale),
      duration: Math.round(sample.duration * 1e6 / timescale),
      data: sample.data,
    });
  }

  async function makeDecoder(d, onFrame) {
    const config = { codec: d.video.codec, codedWidth: d.video.video.width, codedHeight: d.video.video.height };
    if (d.vDesc) config.description = d.vDesc;
    const sup = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!sup.supported) throw new Error(`This browser can't decode ${d.video.codec.split('.')[0].toUpperCase()} video. Try Safari, or Chrome on a Mac.`);
    let error = null;
    const dec = new VideoDecoder({ output: onFrame, error: (e) => { error = e; } });
    dec.configure(config);
    return { dec, err: () => error };
  }

  // ---------- frames as YUV planes ----------
  // Work on the decoded Y/U/V planes directly: no RGB round trip, so colours stay exactly as recorded.
  const SD_COLOR = { primaries: 'bt470bg', transfer: 'bt709', matrix: 'smpte170m', fullRange: false };
  let rgbCanvas = null, rgbCtx = null;

  // returns tightly packed I420 {y, u, v, w, h, cw, ch}
  async function readI420(frame, out) {
    const w = frame.visibleRect.width, h = frame.visibleRect.height;
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    if (!out || out.w !== w || out.h !== h) {
      out = { w, h, cw, ch, buf: new Uint8Array(w * h + 2 * cw * ch) };
      out.y = out.buf.subarray(0, w * h);
      out.u = out.buf.subarray(w * h, w * h + cw * ch);
      out.v = out.buf.subarray(w * h + cw * ch);
    }
    const fmt = frame.format;
    if (fmt === 'I420' || fmt === 'I420A' || fmt === 'NV12') {
      const raw = new Uint8Array(frame.allocationSize());
      const lay = await frame.copyTo(raw);
      copyPlane(raw, lay[0], out.y, w, h);
      if (fmt === 'NV12') {
        const { offset, stride } = lay[1];
        for (let r = 0; r < ch; r++) {
          let s = offset + r * stride, d = r * cw;
          for (let c = 0; c < cw; c++, s += 2, d++) { out.u[d] = raw[s]; out.v[d] = raw[s + 1]; }
        }
      } else {
        copyPlane(raw, lay[1], out.u, cw, ch);
        copyPlane(raw, lay[2], out.v, cw, ch);
      }
      out.viaRgb = false;
      return out;
    }
    // other pixel formats: let the browser convert to RGB, then back to BT.601 limited-range YUV
    if (!rgbCanvas) { rgbCanvas = new OffscreenCanvas(w, h); rgbCtx = rgbCanvas.getContext('2d', { willReadFrequently: true }); }
    if (rgbCanvas.width !== w || rgbCanvas.height !== h) { rgbCanvas.width = w; rgbCanvas.height = h; }
    rgbCtx.drawImage(frame, 0, 0, w, h);
    const px = rgbCtx.getImageData(0, 0, w, h).data;
    for (let i = 0, p = 0; i < w * h; i++, p += 4) out.y[i] = 16.5 + 0.256788 * px[p] + 0.504129 * px[p + 1] + 0.097906 * px[p + 2];
    for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
      let R = 0, G = 0, B = 0, n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const x = 2 * c + dx, y = 2 * r + dy;
        if (x >= w || y >= h) continue;
        const p = (y * w + x) * 4; R += px[p]; G += px[p + 1]; B += px[p + 2]; n++;
      }
      R /= n; G /= n; B /= n;
      out.u[r * cw + c] = 128.5 - 0.148223 * R - 0.290993 * G + 0.439216 * B;
      out.v[r * cw + c] = 128.5 + 0.439216 * R - 0.367788 * G - 0.071427 * B;
    }
    out.viaRgb = true;
    return out;
  }
  function copyPlane(raw, { offset, stride }, dst, w, h) {
    for (let r = 0; r < h; r++) dst.set(raw.subarray(offset + r * stride, offset + r * stride + w), r * w);
  }

  // ---------- pass 1: measure the odd-frame shift ----------
  // Luma is cropped away from the edges and averaged in 8-px column blocks; rows stay at full resolution.
  const BX = 8, MX = 60, MY = 40;
  function lumaGrid(p) {
    const cols = Math.floor((p.w - 2 * MX) / BX), rows = p.h;
    const g = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      const src = y * p.w + MX;
      for (let c = 0; c < cols; c++) {
        let s = 0;
        for (let k = 0; k < BX; k++) s += p.y[src + c * BX + k];
        g[y * cols + c] = s / BX;
      }
    }
    // binomial low-pass down the columns: without it, noise in dark footage makes half-pixel shifts
    // look better than they are (interpolation smooths the noise away) and biases the measurement
    const out = new Float32Array(g.length);
    for (let y = 0; y < rows; y++) {
      const r = (d) => Math.min(rows - 1, Math.max(0, y + d)) * cols;
      const a = r(-2), b = r(-1), m = y * cols, e = r(1), f = r(2);
      for (let c = 0; c < cols; c++) out[m + c] = (g[a + c] + 4 * g[b + c] + 6 * g[m + c] + 4 * g[e + c] + g[f + c]) / 16;
    }
    return { g: out, cols, rows };
  }

  // mean squared error between test(y) and ref(y - s), ref sampled with Catmull-Rom (cubic) interpolation
  function err(test, ref, s) {
    const { cols, rows } = test;
    const a = test.g, b = ref.g;
    const t = s - Math.floor(s), k = Math.floor(s);
    // weights for taps at ry-1 .. ry+2 where ry = y - s = (y - k - 1) + (1 - t)
    const f = t === 0 ? 0 : 1 - t, ofs = t === 0 ? -k : -k - 1;
    const w0 = 0.5 * (-f + 2 * f * f - f * f * f), w1 = 0.5 * (2 - 5 * f * f + 3 * f * f * f);
    const w2 = 0.5 * (f + 4 * f * f - 3 * f * f * f), w3 = 0.5 * (-f * f + f * f * f);
    let sum = 0, n = 0;
    for (let y = MY; y < rows - MY; y++) {
      const r = y + ofs;
      const r0 = (r - 1) * cols, r1 = r * cols, r2 = (r + 1) * cols, r3 = (r + 2) * cols, ty = y * cols;
      for (let c = 0; c < cols; c++) {
        const d = a[ty + c] - (w0 * b[r0 + c] + w1 * b[r1 + c] + w2 * b[r2 + c] + w3 * b[r3 + c]);
        sum += d * d;
      }
      n += cols;
    }
    return sum / n;
  }
  // Every frame is compared with the average of its two neighbours, which cancels steady motion (a slow
  // tilt). For each frame we keep the whole error curve over a range of shifts; frames of one parity sit
  // +jump from their neighbours, the other parity −jump. The whole clip is scanned, so a shaky or dark
  // start doesn't decide the result.
  const GRID = [];
  for (let s = -2.5; s <= 2.5001; s += 0.1) GRID.push(+s.toFixed(2));
  const G = GRID.length, STEP = 0.1;

  // frame number from the timestamp: a dropped frame leaves a gap, so parity stays right across it
  function frameNo(us, d) { return Math.round((us - d.t0Us) / d.frameUs); }
  const parity = (n) => (n % 2 === 1 ? 1 : -1);

  async function analyse(d, ui) {
    const ts = d.video.timescale;
    let cap = 1024, count = 0;
    let nums = new Int32Array(cap), curves = new Float32Array(cap * G);
    let win = [], buf = null, pending = Promise.resolve();
    const total = d.vSamples.length;
    const { dec, err: decErr } = await makeDecoder(d, (frame) => {
      const n = frameNo(frame.timestamp, d);
      pending = pending.then(async () => {
        buf = await readI420(frame, buf);
        win.push({ n, g: lumaGrid(buf) });
        if (win.length > 3) win.shift();
        if (win.length < 3 || win[1].n - win[0].n !== 1 || win[2].n - win[1].n !== 1) return;
        const [a, mid, c] = win, test = mid.g;
        const ref = { g: new Float32Array(test.g.length), cols: test.cols, rows: test.rows };
        for (let k = 0; k < ref.g.length; k++) ref.g[k] = (a.g.g[k] + c.g.g[k]) / 2;
        const e = GRID.map((s) => err(test, ref, s));
        const mean = e.reduce((x, y) => x + y, 0) / G;
        if (!(mean > 0)) return;
        if (count === cap) {
          cap *= 2;
          const n2 = new Int32Array(cap); n2.set(nums); nums = n2;
          const c2 = new Float32Array(cap * G); c2.set(curves); curves = c2;
        }
        nums[count] = mid.n;
        for (let k = 0; k < G; k++) curves[count * G + k] = e[k] / mean;
        count++;
      }).finally(() => frame.close());
    });
    for (let k = 0; k < total; k++) {
      if (decErr()) throw decErr();
      dec.decode(chunkFor(d.vSamples[k], ts));
      while (dec.decodeQueueSize > 4) await sleep(1);
      await pending;
      if (k % 5 === 0) { ui.progress(0.4 * k / total); await sleep(0); }
    }
    await dec.flush();
    await pending;
    dec.close();
    return { count, nums: nums.subarray(0, count), curves: curves.subarray(0, count * G) };
  }

  // curve of frame k at shift s (linear between grid points)
  function at(A, k, s) {
    const x = Math.min(G - 1, Math.max(0, (s - GRID[0]) / STEP)), i = Math.min(G - 2, Math.floor(x)), f = x - i;
    return A.curves[k * G + i] * (1 - f) + A.curves[k * G + i + 1] * f;
  }

  // Sum the curves with each frame's sign applied (sign −1 mirrors the curve), find the minimum.
  function fitJump(A, sign) {
    const sum = new Float64Array(G);
    for (let k = 0; k < A.count; k++) {
      const o = k * G, mirror = sign[k] < 0;
      for (let j = 0; j < G; j++) sum[j] += A.curves[o + (mirror ? G - 1 - j : j)];
    }
    let m = 0;
    for (let j = 1; j < G; j++) if (sum[j] < sum[m]) m = j;
    let off = GRID[m];
    if (m > 0 && m < G - 1) {
      const l = sum[m - 1], c = sum[m], r = sum[m + 1], den = l - 2 * c + r;
      if (den > 0) off += STEP * (l - r) / (2 * den);
    }
    // contrast: how much worse a 1 px miss is than the best fit, per frame (each curve has mean 1)
    const idx = (s) => Math.max(0, Math.min(G - 1, Math.round((s - GRID[0]) / STEP)));
    const contrast = (Math.min(sum[idx(off - 1)], sum[idx(off + 1)]) - sum[m]) / A.count;
    return { off, contrast };
  }

  // Where does a frame actually sit, +jump or −jump? If the recorder slipped a field without leaving a
  // timestamp gap, the parity flips from that frame on. Find those flips from the picture itself.
  const WIN = 12;
  function findFlips(A, off) {
    const N = A.count;
    const score = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const p = parity(A.nums[k]);
      score[k] = at(A, k, -p * off) - at(A, k, p * off); // > 0: frame agrees with the plain parity
    }
    const label = new Int8Array(N);
    for (let k = 0; k < N; k++) {
      let s = 0, a = 0;
      for (let j = Math.max(0, k - WIN); j <= Math.min(N - 1, k + WIN); j++) { s += score[j]; a += Math.abs(score[j]); }
      label[k] = s > 0.3 * a ? 1 : s < -0.3 * a ? -1 : 0;
    }
    // undecided frames take the label of the nearest decided one before (or after, at the start)
    let last = 0;
    for (let k = 0; k < N; k++) { if (label[k]) last = label[k]; else label[k] = last; }
    last = 0;
    for (let k = N - 1; k >= 0; k--) { if (label[k]) last = label[k]; else label[k] = last; }
    if (!N || !label[0]) return [{ from: -Infinity, flip: 1 }];
    // runs shorter than the window are noise: give them the label before them
    let runs = toRuns(label);
    for (let changed = true; changed && runs.length > 1;) {
      changed = false;
      for (let r = 0; r < runs.length; r++) {
        if (runs[r].end - runs[r].start + 1 >= WIN) continue;
        const to = r > 0 ? runs[r - 1].flip : runs[r + 1].flip;
        for (let k = runs[r].start; k <= runs[r].end; k++) label[k] = to;
        runs = toRuns(label); changed = true; break;
      }
    }
    // put each boundary on the exact frame that best splits the evidence
    const segs = [{ from: -Infinity, flip: runs[0].flip }];
    for (let r = 1; r < runs.length; r++) {
      const a = runs[r - 1].flip, b = runs[r].flip;
      const lo = Math.max(runs[r - 1].start, runs[r].start - WIN), hi = Math.min(runs[r].end, runs[r].start + WIN);
      let best = runs[r].start, bv = -Infinity;
      for (let p = lo; p <= hi; p++) {
        let v = 0;
        for (let j = lo; j <= hi; j++) v += (j < p ? a : b) * score[j];
        if (v > bv) { bv = v; best = p; }
      }
      segs.push({ from: A.nums[best], flip: b });
    }
    return segs;
  }
  function toRuns(label) {
    const runs = [];
    for (let k = 0; k < label.length; k++) {
      if (runs.length && runs[runs.length - 1].flip === label[k]) runs[runs.length - 1].end = k;
      else runs.push({ start: k, end: k, flip: label[k] });
    }
    return runs;
  }
  function flipAt(segs, n) {
    let f = segs[0].flip;
    for (const s of segs) if (n >= s.from) f = s.flip;
    return f;
  }
  function signs(A, segs) {
    const s = new Int8Array(A.count);
    for (let k = 0; k < A.count; k++) s[k] = parity(A.nums[k]) * flipAt(segs, A.nums[k]);
    return s;
  }

  const MIN_CONTRAST = 0.02; // real clips measure 0.05–0.3, a capped lens ~0.003
  // borrowed: jump size measured on other clips, used when this clip is too flat to measure its own
  function solve(A, borrowed) {
    if (A.count < 5) return { off: 0, segs: [{ from: -Infinity, flip: 1 }], unsure: true };
    let segs = [{ from: -Infinity, flip: 1 }];
    let fit = fitJump(A, signs(A, segs));
    for (let pass = 0; pass < 2 && fit.contrast >= MIN_CONTRAST; pass++) {
      segs = findFlips(A, fit.off);
      fit = fitJump(A, signs(A, segs));
    }
    if (fit.contrast >= MIN_CONTRAST) return { off: fit.off, segs };
    if (!borrowed) return { off: 0, segs, unsure: true };
    // Knowing the size, only the direction is left to find, which needs far less detail.
    let total = 0, abs = 0;
    for (let k = 0; k < A.count; k++) {
      const p = parity(A.nums[k]);
      const v = at(A, k, -p * borrowed) - at(A, k, p * borrowed);
      total += v; abs += Math.abs(v);
    }
    if (A.count < 20 || Math.abs(total) < 0.2 * abs) return { off: 0, segs, unsure: true };
    const off = total > 0 ? borrowed : -borrowed;
    return { off, segs: findFlips(A, off), borrowed: true };
  }

  // ---------- pass 2: shift frames, encode, mux ----------
  // Vertical resample out(y) = in(y + t) with Lanczos-8 (16 taps). The short Lanczos-3 kept only 80–90 % of
  // the detail at a ¼–½ px shift; 16 taps keep ~100 %, so a fractional move costs no sharpness.
  // A whole-pixel t is a plain row copy. Edges repeat the last row (the black bars cover them).
  const TAPS = 8;
  function lanczos(x) {
    if (x === 0) return 1;
    if (Math.abs(x) >= TAPS) return 0;
    const px = Math.PI * x;
    return TAPS * Math.sin(px) * Math.sin(px / TAPS) / (px * px);
  }
  function shiftPlane(src, dst, w, h, t) {
    const k = Math.floor(t), f = t - k;
    if (f < 1e-4) {
      for (let y = 0; y < h; y++) {
        const sy = Math.min(h - 1, Math.max(0, y + k));
        dst.set(src.subarray(sy * w, sy * w + w), y * w);
      }
      return;
    }
    const n = 2 * TAPS, wt = new Float32Array(n), rows = new Int32Array(n);
    let sum = 0;
    for (let j = 0; j < n; j++) { wt[j] = lanczos(j - TAPS + 1 - f); sum += wt[j]; }
    for (let j = 0; j < n; j++) wt[j] /= sum;
    const acc = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      for (let j = 0; j < n; j++) rows[j] = Math.min(h - 1, Math.max(0, y + k + j - TAPS + 1)) * w;
      acc.fill(0.5);
      for (let j = 0; j < n; j++) {
        const r = rows[j], c = wt[j];
        for (let x = 0; x < w; x++) acc[x] += c * src[r + x];
      }
      dst.set(acc, y * w); // Uint8Array clamps to 0..255 and truncates (0.5 added above rounds)
    }
  }
  function shiftI420(p, out, t) {
    shiftPlane(p.y, out.y, p.w, p.h, t);
    shiftPlane(p.u, out.u, p.cw, p.ch, t / 2);
    shiftPlane(p.v, out.v, p.cw, p.ch, t / 2);
  }

  // Odd frames move by the whole-pixel part of the jump; the fractional rest is split between both frames
  // of a pair, so each is at most ¼ px off the pixel grid and both get the same treatment.
  function splitShift(off) {
    const e = off - Math.round(off);
    return { even: -e / 2, odd: Math.round(off) + e / 2 };
  }

  // Black bars `bar` luma rows high at top and bottom (bar is even, so chroma gets bar / 2 whole rows).
  // Painted on every frame, so the border is the same on both frames of a pair and doesn't flicker.
  function paintBars(p, bar) {
    const cb = bar / 2;
    p.y.fill(16, 0, bar * p.w); p.y.fill(16, (p.h - bar) * p.w);
    for (const c of [p.u, p.v]) { c.fill(128, 0, cb * p.cw); c.fill(128, (p.ch - cb) * p.cw); }
  }

  async function pickEncoderConfig(w, h, fps) {
    for (const codec of ['avc1.640029', 'avc1.4d4029', 'avc1.42e029']) {
      const cfg = { codec, width: w, height: h, bitrate: 40_000_000, bitrateMode: 'variable', framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' };
      const s = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
      if (s.supported) return cfg;
    }
    throw new Error("This browser can't encode H.264 video.");
  }

  const signed = (v) => (+v >= 0 ? '+' : '−') + String(v).replace('-', '');
  const DEFER = Symbol('defer');
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  async function processFile(job) {
    const { file, ui } = job;
    ui.state('Reading', 'work');
    const d = await demux(file);
    const ts = d.video.timescale;
    const w = d.video.video.width, h = d.video.video.height;
    // samples are stored in decode order; with B-frames that isn't display order, so sort the times first
    const shown = d.vSamples.filter((x) => x.cts >= d.vStart).map((x) => x.cts).sort((x, y) => x - y);
    const frameDur = shown.length > 1 ? median(shown.slice(1).map((c, k) => c - shown[k])) : d.vSamples[0].duration;
    const fps = Math.round(ts / Math.max(frameDur, 1));
    const dur = shown.length * frameDur / ts;
    const startUs = d.vStart * 1e6 / ts;
    d.frameUs = frameDur * 1e6 / ts;
    d.t0Us = Math.min(...d.vSamples.map((x) => Math.round(x.cts * 1e6 / ts)));
    ui.meta(`${w}×${h} · ${fps} fps · ${dur.toFixed(1)} s`);

    ui.state('Measuring', 'work');
    job.analysis ||= await analyse(d, ui);
    let m = solve(job.analysis, null);
    if (m.unsure && !known.length && queue.some((j) => !j.deferred)) throw DEFER;
    if (m.unsure && known.length) m = solve(job.analysis, median(known));
    if (!m.unsure && !m.borrowed) known.push(Math.abs(m.off));
    const off = m.off;
    const needs = Math.abs(off) >= 0.1;
    const flips = needs ? m.segs.length - 1 : 0;
    const note = !needs ? (m.unsure ? ' (too little detail to measure, re-saved as is)' : ' (clean, re-saved as is)')
      : (m.borrowed ? ' (size taken from your other clips)' : '') + (flips ? ` · ${flips} frame-order slip${flips > 1 ? 's' : ''} found` : '');
    const jumpText = `${w}×${h} · ${fps} fps · ${dur.toFixed(1)} s · jump <b>${signed(off.toFixed(2))} px</b>${note}`;
    ui.meta(jumpText);

    ui.state('Fixing', 'work');
    // muxer
    const hasAudio = !!(d.audio && d.aDesc && /^mp4a/.test(d.audio.codec));
    const encCfg = await pickEncoderConfig(w, h, fps);
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h, frameRate: fps },
      audio: hasAudio ? { codec: 'aac', numberOfChannels: d.audio.audio.channel_count, sampleRate: d.audio.audio.sample_rate } : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'cross-track-offset',
    });
    let encErr = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
    enc.configure(encCfg);

    const shift = needs ? splitShift(off) : { even: 0, odd: 0 };
    // rows pulled in from outside the frame, rounded up to even so chroma rows (pairs of luma rows) line up
    const reach = Math.ceil(Math.max(Math.abs(shift.even), Math.abs(shift.odd)) - 1e-4);
    const bar = reach + reach % 2;
    let kept = 0, src = null, dst = null, viaRgb = false, pending = Promise.resolve(), workErr = null;
    const total = d.vSamples.length;
    const { dec, err } = await makeDecoder(d, (frame) => {
      if (frame.timestamp < startUs - 1) { frame.close(); return; } // pre-roll: decoded for reference only
      const o = kept++;
      pending = pending.then(async () => {
        src = await readI420(frame, src);
        if (src.w !== w || src.h !== h) throw new Error(`Frame size ${src.w}×${src.h} doesn't match the track (${w}×${h}).`);
        viaRgb ||= src.viaRgb;
        if (!dst) { dst = { ...src, buf: new Uint8Array(src.buf.length) }; dst.y = dst.buf.subarray(0, w * h); dst.u = dst.buf.subarray(w * h, w * h + src.cw * src.ch); dst.v = dst.buf.subarray(w * h + src.cw * src.ch); }
        const n = frameNo(frame.timestamp, d);
        const t = parity(n) * flipAt(m.segs, n) > 0 ? shift.odd : shift.even;
        const out = t === 0 ? src : (shiftI420(src, dst, t), dst);
        if (bar) paintBars(out, bar);
        const vf = new VideoFrame(out.buf, {
          format: 'I420', codedWidth: w, codedHeight: h,
          timestamp: frame.timestamp - startUs, duration: frame.duration ?? undefined, colorSpace: SD_COLOR,
        });
        enc.encode(vf, { keyFrame: o % 50 === 0 });
        vf.close();
      }).catch((e) => { workErr ||= e; }).finally(() => frame.close());
    });
    for (let k = 0; k < total; k++) {
      if (err()) throw err();
      if (encErr) throw encErr;
      if (workErr) throw workErr;
      dec.decode(chunkFor(d.vSamples[k], ts));
      while (dec.decodeQueueSize > 4 || enc.encodeQueueSize > 8) await sleep(1);
      await pending;
      if (k % 10 === 0) { ui.progress(0.4 + 0.6 * k / total); await sleep(0); }
    }
    await dec.flush();
    await pending;
    if (workErr) throw workErr;
    dec.close();
    await enc.flush();
    enc.close();
    if (hasAudio) {
      const ats = d.audio.timescale;
      let first = true;
      for (const s of d.aSamples) {
        if (s.cts < d.aStart) continue;
        const meta = first ? { decoderConfig: { codec: d.audio.codec, numberOfChannels: d.audio.audio.channel_count, sampleRate: d.audio.audio.sample_rate, description: d.aDesc } } : undefined;
        muxer.addAudioChunkRaw(new Uint8Array(s.data), 'key', Math.round((s.cts - d.aStart) * 1e6 / ats), Math.round(s.duration * 1e6 / ats), meta);
        first = false;
      }
    }
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const outName = file.name.replace(/\.[^.]+$/, '') + '_fixed.mp4';
    results.push({ name: outName, blob });
    ui.progress(1);
    ui.state('Fixed', 'done');
    const extra = (hasAudio ? '' : (d.audio ? ' · audio format not supported, saved without sound' : '')) + (viaRgb ? ' · colours went through RGB in this browser' : '');
    ui.meta(`${jumpText} → fixed · ${(blob.size / 1048576).toFixed(1)} MB${extra}`);

    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    video.controls = true; video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'metadata';
    video.addEventListener('loadedmetadata', () => { try { video.currentTime = 0.1; } catch {} }, { once: true });
    ui.el.appendChild(video);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = document.createElement('button');
    btn.className = 'btn'; btn.type = 'button'; btn.textContent = shareable(outName, blob) ? 'Save video' : 'Save ' + outName;
    btn.addEventListener('click', () => saveOne(outName, blob, btn));
    actions.appendChild(btn);
    ui.el.appendChild(actions);
  }

  // Phones save downloads to Files, not to the gallery. The share sheet has "Save Video", which does.
  const touch = matchMedia('(pointer: coarse)').matches;
  function shareable(name, blob) {
    try { return touch && !!navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'video/mp4' })] }); }
    catch { return false; }
  }

  async function saveOne(name, blob, btn) {
    if (shareable(name, blob)) {
      try {
        await navigator.share({ files: [new File([blob], name, { type: 'video/mp4' })] });
        btn.textContent = 'Saved';
        return;
      } catch (e) {
        if (e.name === 'AbortError') return; // closed the share sheet
      }
    }
    download(name, blob);
    btn.textContent = 'Saved ' + name;
  }
})();
