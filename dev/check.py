"""Reference measurements for checking the page's output (numpy + ffmpeg, slow but unbiased).

  python dev/check.py jump <clip...>          jump of odd frames vs their neighbours (median of first 60)
  python dev/check.py compare <src> <fixed>   frame count, jump before/after, detail per parity, colour drift
  python dev/check.py along <clip...>         jump in 16-frame windows every 60 frames (catches parity slips)
"""
import sys, subprocess, numpy as np
W, H = 720, 576


def load(path, n=None, fmt="gray"):
    cmd = ["ffmpeg", "-v", "error", "-i", path] + (["-frames:v", str(n)] if n else []) + ["-f", "rawvideo", "-pix_fmt", fmt, "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    if fmt == "gray":
        return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32), None
    a = np.frombuffer(raw, np.uint8).reshape(-1, W * H * 3 // 2).astype(np.float32)
    return a[:, :W * H].reshape(-1, H, W), a[:, W * H:]


def shift_rows(img, s):
    # sample img at y - s with Catmull-Rom interpolation
    y = np.arange(img.shape[0]) - s
    y0 = np.floor(y).astype(int); f = (y - y0)[:, None]
    def r(k): return img[np.clip(y0 + k, 0, img.shape[0] - 1)]
    p0, p1, p2, p3 = r(-1), r(0), r(1), r(2)
    return p1 + 0.5 * f * (p2 - p0 + f * (2*p0 - 5*p1 + 4*p2 - p3 + f * (3*(p1 - p2) + p3 - p0)))


def smooth(img):
    # binomial low-pass both ways; without it noise biases the fit towards half-pixel shifts
    k = np.array([1, 4, 6, 4, 1], np.float32) / 16
    img = np.apply_along_axis(lambda v: np.convolve(v, k, mode='same'), 0, img)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode='same'), 1, img)


def best(test, ref):
    """s such that test(y) ~ ref(y - s)"""
    test, ref = smooth(test), smooth(ref)
    c = (slice(40, -40), slice(60, -60))
    f = lambda s: np.mean((test[c] - shift_rows(ref, s)[c]) ** 2)
    ss = np.arange(-2.5, 2.5001, 0.1); s0 = ss[int(np.argmin([f(s) for s in ss]))]
    ss = np.arange(s0 - 0.1, s0 + 0.1001, 0.01)
    return float(ss[int(np.argmin([f(s) for s in ss]))])


def jumps(Y, frames):
    # odd frames sit +jump from the average of their neighbours, even frames -jump
    return [(1 if i % 2 else -1) * best(Y[i], (Y[i-1] + Y[i+1]) / 2) for i in frames]


def count(path):
    return subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v", "-show_entries",
                           "stream=nb_read_frames", "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip()


def detail(Y, k):
    return np.mean(np.abs(np.diff(Y[k::2, 40:-40], axis=1)))


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "jump":
        for p in args:
            Y, _ = load(p, 61); r = jumps(Y, range(1, len(Y) - 1))
            print(f"{p.split('/')[-1]}  median {np.median(r):+.2f}  iqr {np.subtract(*np.percentile(r, [75, 25])):.2f}")
    elif cmd == "compare":
        src, out = args
        Ys, Cs = load(src, 100, "yuv420p"); Y, C = load(out, 100, "yuv420p")
        c = (slice(None), slice(40, -40), slice(40, -40))
        js, jo = np.median(jumps(Ys, range(1, 39))), np.median(jumps(Y, range(1, 39)))
        print(f"{src.split('/')[-1]}  frames {count(src)}->{count(out)}  jump {js:+.2f} -> {jo:+.2f}px  "
              f"detail even {detail(Y, 0)/detail(Ys, 0)*100:.1f}% odd {detail(Y, 1)/detail(Ys, 1)*100:.1f}%  "
              f"mean diff Y {Y[c].mean()-Ys[c].mean():+.2f} UV {C.mean()-Cs.mean():+.2f} (of 255)")
    elif cmd == "along":
        for p in args:
            Y, _ = load(p)
            parts = [f"{c}:{np.median(jumps(Y, range(c, c + 16))):+.2f}" for c in range(20, len(Y) - 20, 60)]
            print(p.split('/')[-1], ' '.join(parts))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
