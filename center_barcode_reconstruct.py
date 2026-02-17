#!/usr/bin/env python3
import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple
from datetime import datetime, timezone

import numpy as np

try:
    import cv2
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"OpenCV import failed: {exc}")


L_CODES = {
    "0001101": "0",
    "0011001": "1",
    "0010011": "2",
    "0111101": "3",
    "0100011": "4",
    "0110001": "5",
    "0101111": "6",
    "0111011": "7",
    "0110111": "8",
    "0001011": "9",
}
R_CODES = {
    "1110010": "0",
    "1100110": "1",
    "1101100": "2",
    "1000010": "3",
    "1011100": "4",
    "1001110": "5",
    "1010000": "6",
    "1000100": "7",
    "1001000": "8",
    "1110100": "9",
}


@dataclass
class Candidate:
    code: str
    score: float
    window_start: int
    module: float
    quant_error: float
    window_center_x: float
    center_proximity: float


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Recover a likely center UPC/EAN-style 1D barcode using multi-frame "
            "alignment, fusion, signal integration, and inference."
        )
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--image", type=Path, help="Path to single input image.")
    src.add_argument("--video", type=Path, help="Path to input video.")
    p.add_argument("--roi-frac", type=float, default=0.6, help="Center square ROI fraction (default 0.6).")
    p.add_argument("--max-frames", type=int, default=90, help="Max video frames to sample.")
    p.add_argument("--frame-step", type=int, default=2, help="Take every Nth frame from video.")
    p.add_argument("--superres", type=int, default=2, help="Super-res upsample factor (default 2).")
    p.add_argument("--deblur-sigma", type=float, default=1.2, help="PSF sigma for Wiener deblur (default 1.2).")
    p.add_argument("--freq-boost", type=float, default=1.8, help="Frequency-domain boost multiplier (default 1.8).")
    p.add_argument(
        "--center-priority",
        type=float,
        default=2.0,
        help="How strongly to prefer barcode windows closest to ROI center (default 2.0).",
    )
    p.add_argument(
        "--blur-threshold",
        type=float,
        default=12.0,
        help="Laplacian variance below this marks image as blurry (default 12).",
    )
    p.add_argument("--out-dir", type=Path, default=Path("barcode_reconstruct_out"), help="Directory for debug artifacts.")
    return p.parse_args()


def center_square(img: np.ndarray, frac: float) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
    h, w = img.shape[:2]
    size = int(max(10, min(h, w) * frac))
    x = (w - size) // 2
    y = (h - size) // 2
    return img[y:y + size, x:x + size].copy(), (x, y, size, size)


def load_frames(args: argparse.Namespace) -> List[np.ndarray]:
    frames: List[np.ndarray] = []
    if args.image:
        img = cv2.imread(str(args.image), cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit(f"Failed to read image: {args.image}")
        frames.append(img)
        return frames

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        raise SystemExit(f"Failed to open video: {args.video}")

    idx = 0
    while len(frames) < args.max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % max(1, args.frame_step) == 0:
            frames.append(frame)
        idx += 1
    cap.release()
    if not frames:
        raise SystemExit("No frames extracted from video.")
    return frames


def align_rois(rois: List[np.ndarray]) -> Tuple[List[np.ndarray], List[Tuple[float, float]]]:
    ref = cv2.cvtColor(rois[0], cv2.COLOR_BGR2GRAY).astype(np.float32)
    win = cv2.createHanningWindow((ref.shape[1], ref.shape[0]), cv2.CV_32F)
    aligned = [rois[0]]
    shifts = [(0.0, 0.0)]
    for roi in rois[1:]:
        g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY).astype(np.float32)
        try:
            (dx, dy), _ = cv2.phaseCorrelate(ref * win, g * win)
        except Exception:
            dx, dy = 0.0, 0.0
        m = np.float32([[1.0, 0.0, dx], [0.0, 1.0, dy]])
        warped = cv2.warpAffine(
            roi,
            m,
            (roi.shape[1], roi.shape[0]),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REFLECT,
        )
        aligned.append(warped)
        shifts.append((dx, dy))
    return aligned, shifts


def fuse_superres(aligned: List[np.ndarray], shifts: List[Tuple[float, float]], scale: int) -> np.ndarray:
    h, w = aligned[0].shape[:2]
    H, W = h * scale, w * scale
    acc = np.zeros((H, W), np.float32)
    weight = np.zeros((H, W), np.float32)
    for img, (dx, dy) in zip(aligned, shifts):
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        up = cv2.resize(g, (W, H), interpolation=cv2.INTER_CUBIC)
        m = np.float32([[1.0, 0.0, dx * scale], [0.0, 1.0, dy * scale]])
        shifted = cv2.warpAffine(
            up,
            m,
            (W, H),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REFLECT,
        )
        acc += shifted
        weight += 1.0
    fused = acc / np.maximum(weight, 1e-6)
    fused = np.clip(fused, 0, 255).astype(np.uint8)
    return cv2.GaussianBlur(fused, (3, 3), 0.6)


def row_integrated_signal(gray: np.ndarray) -> np.ndarray:
    # Barcode stripes are vertical; choose rows with strong x-gradients.
    gx = np.abs(np.diff(gray.astype(np.float32), axis=1))
    row_strength = gx.mean(axis=1)
    row_strength = row_strength / (row_strength.max() + 1e-6)
    weights = 0.2 + 0.8 * row_strength
    signal = (gray.astype(np.float32).T @ weights) / (weights.sum() + 1e-6)
    return signal


def wiener_deblur_1d(signal: np.ndarray, sigma: float, K: float = 0.01) -> np.ndarray:
    n = signal.shape[0]
    x = np.arange(n, dtype=np.float32) - n // 2
    psf = np.exp(-(x * x) / (2.0 * sigma * sigma))
    psf /= np.sum(psf) + 1e-8
    S = np.fft.fft(signal)
    H = np.fft.fft(np.fft.ifftshift(psf))
    Hw = np.conj(H) / (np.abs(H) ** 2 + K)
    out = np.fft.ifft(S * Hw).real
    return out.astype(np.float32)


def boost_frequency_1d(signal: np.ndarray, boost: float) -> np.ndarray:
    n = signal.shape[0]
    f = np.fft.rfft(signal.astype(np.float32))
    freq = np.fft.rfftfreq(n)
    band = (freq > 0.01) & (freq < 0.35)
    mult = np.ones_like(f, dtype=np.float32)
    mult[band] *= boost
    out = np.fft.irfft(f * mult, n=n)
    return out.astype(np.float32)


def estimate_focus(gray: np.ndarray) -> Tuple[float, float]:
    g = gray.astype(np.float32)
    lap = cv2.Laplacian(g, cv2.CV_32F)
    lap_var = float(np.var(lap))
    sobel_x = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    edge_x_mean = float(np.mean(np.abs(sobel_x)))
    return lap_var, edge_x_mean


def threshold_signal(signal: np.ndarray) -> np.ndarray:
    s = signal - signal.min()
    if s.max() > 0:
        s = s / s.max()
    s8 = np.clip(s * 255, 0, 255).astype(np.uint8)
    thr, _ = cv2.threshold(s8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bits = (s8 < thr).astype(np.uint8)  # dark bars are 1
    return bits


def runs_from_bits(bits: np.ndarray) -> Tuple[List[int], List[int], List[int]]:
    lengths: List[int] = []
    values: List[int] = []
    starts: List[int] = []
    if bits.size == 0:
        return lengths, values, starts
    cur = int(bits[0])
    run_start = 0
    run_len = 1
    for i in range(1, bits.size):
        b = int(bits[i])
        if b == cur:
            run_len += 1
        else:
            lengths.append(run_len)
            values.append(cur)
            starts.append(run_start)
            cur = b
            run_start = i
            run_len = 1
    lengths.append(run_len)
    values.append(cur)
    starts.append(run_start)
    return lengths, values, starts


def decode_upc_95(bitstr: str) -> Optional[str]:
    if len(bitstr) != 95:
        return None
    if bitstr[:3] != "101" or bitstr[45:50] != "01010" or bitstr[92:95] != "101":
        return None
    left = []
    for i in range(6):
        seg = bitstr[3 + 7 * i: 3 + 7 * (i + 1)]
        if seg not in L_CODES:
            return None
        left.append(L_CODES[seg])
    right = []
    for i in range(6):
        seg = bitstr[50 + 7 * i: 50 + 7 * (i + 1)]
        if seg not in R_CODES:
            return None
        right.append(R_CODES[seg])
    code = "".join(left + right)
    nums = [int(c) for c in code]
    odd = nums[0] + nums[2] + nums[4] + nums[6] + nums[8] + nums[10]
    even = nums[1] + nums[3] + nums[5] + nums[7] + nums[9] + nums[11]
    if ((odd * 3 + even) % 10) != 0:
        return None
    return code


def infer_candidates(signal: np.ndarray, center_priority: float) -> List[Candidate]:
    s = signal.astype(np.float32)
    center_x = 0.5 * (s.shape[0] - 1)
    half_span = max(1.0, center_x)
    # Try both normal and inverted because polarity can flip.
    variants = [threshold_signal(s), 1 - threshold_signal(s)]
    out: List[Candidate] = []
    for bits in variants:
        lens, vals, starts = runs_from_bits(bits)
        if len(lens) < 20:
            continue
        small = sorted([l for l in lens if l > 0])
        base_count = max(6, min(20, len(small) // 3))
        module = float(np.mean(small[:base_count]))
        if module <= 0:
            continue
        # Build module stream with quantization error tracking.
        modules = []
        x_centers = []
        err_sum = 0.0
        n_sum = 0
        for ln, v, st in zip(lens, vals, starts):
            q = ln / module
            n = max(1, min(12, int(round(q))))
            err_sum += abs(q - n)
            n_sum += 1
            modules.extend([str(v)] * n)
            for i in range(n):
                x_centers.append(st + (i + 0.5) * module)
        quant_error = err_sum / max(1, n_sum)
        modstr = "".join(modules)
        if len(modstr) < 95:
            continue
        for i in range(0, len(modstr) - 94):
            chunk = modstr[i:i + 95]
            code = decode_upc_95(chunk)
            if not code:
                continue
            # Score uses run quantization + contrast around transitions.
            score = 1.0 / (0.15 + quant_error)
            left = int(max(0, x_centers[i] - module))
            right = int(min(s.shape[0] - 1, x_centers[i + 94] + module))
            local = s[left:right + 1]
            contrast = float(np.std(local))
            score += contrast / 32.0
            window_center_x = 0.5 * (x_centers[i] + x_centers[i + 94])
            center_dist_norm = abs(window_center_x - center_x) / half_span
            center_proximity = float(np.clip(1.0 - center_dist_norm, 0.0, 1.0))
            score += center_priority * center_proximity
            out.append(
                Candidate(
                    code=code,
                    score=score,
                    window_start=i,
                    module=module,
                    quant_error=quant_error,
                    window_center_x=window_center_x,
                    center_proximity=center_proximity,
                )
            )
    return out


def optional_external_decode(gray: np.ndarray) -> dict:
    result = {"opencv_barcode": None, "pyzbar": None}
    # OpenCV barcode module (if built in this OpenCV build).
    try:
        if hasattr(cv2, "barcode_BarcodeDetector"):
            det = cv2.barcode_BarcodeDetector()
            ok, decoded_info, _, _ = det.detectAndDecode(gray)
            if ok and decoded_info:
                if isinstance(decoded_info, (list, tuple)):
                    decoded = [d for d in decoded_info if d]
                    result["opencv_barcode"] = decoded[0] if decoded else None
                elif decoded_info:
                    result["opencv_barcode"] = str(decoded_info)
    except Exception:
        pass
    # pyzbar (optional)
    try:
        from pyzbar.pyzbar import decode as zdecode  # type: ignore

        hits = zdecode(gray)
        if hits:
            result["pyzbar"] = hits[0].data.decode("utf-8", errors="ignore")
    except Exception:
        pass
    return result


def save_debug(
    out_dir: Path,
    input_path: Optional[Path],
    roi_ref: np.ndarray,
    fused: np.ndarray,
    signal: np.ndarray,
    deblurred: np.ndarray,
    boosted: np.ndarray,
    best: Optional[Candidate],
    candidates_count: int,
    frames_used: int,
    extras: dict,
    focus_laplacian_var: float,
    focus_edge_x_mean: float,
    blur_detected: bool,
    used_blur_recovery: bool,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_dir / "roi_ref.png"), roi_ref)
    cv2.imwrite(str(out_dir / "fused_superres.png"), fused)

    def signal_img(sig: np.ndarray, h: int = 240) -> np.ndarray:
        s = sig.astype(np.float32)
        s = s - s.min()
        if s.max() > 0:
            s /= s.max()
        w = s.shape[0]
        canvas = np.full((h, w), 255, np.uint8)
        ys = (h - 1 - (s * (h - 1))).astype(np.int32)
        for x in range(w):
            canvas[ys[x], x] = 0
        return canvas

    cv2.imwrite(str(out_dir / "signal_raw.png"), signal_img(signal))
    cv2.imwrite(str(out_dir / "signal_deblurred.png"), signal_img(deblurred))
    cv2.imwrite(str(out_dir / "signal_boosted.png"), signal_img(boosted))

    payload = {
        "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        "input_image": str(input_path) if input_path else None,
        "frames_used": frames_used,
        "candidates_count": candidates_count,
        "status": "barcode_found" if best else "no_barcode_found",
        "best_code": best.code if best else None,
        "best_score": best.score if best else None,
        "best_module_estimate": best.module if best else None,
        "best_quant_error": best.quant_error if best else None,
        "best_window_center_x": best.window_center_x if best else None,
        "best_center_proximity": best.center_proximity if best else None,
        "focus_laplacian_var": focus_laplacian_var,
        "focus_edge_x_mean": focus_edge_x_mean,
        "blur_detected": blur_detected,
        "used_blur_recovery": used_blur_recovery,
        "external_decoders": extras,
    }
    (out_dir / "result.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    frames = load_frames(args)
    rois = []
    roi_box = None
    for f in frames:
        roi, box = center_square(f, args.roi_frac)
        rois.append(roi)
        roi_box = box
    aligned, shifts = align_rois(rois)
    fused = fuse_superres(aligned, shifts, max(1, args.superres))

    signal = row_integrated_signal(fused)
    focus_laplacian_var, focus_edge_x_mean = estimate_focus(fused)
    blur_detected = focus_laplacian_var < max(1.0, args.blur_threshold)
    deblurred = wiener_deblur_1d(signal, sigma=max(0.2, args.deblur_sigma))
    boosted = boost_frequency_1d(deblurred, boost=max(1.0, args.freq_boost))
    candidates = infer_candidates(boosted, center_priority=max(0.0, args.center_priority))

    used_blur_recovery = False
    if blur_detected:
        used_blur_recovery = True
        rescue_deblur = wiener_deblur_1d(signal, sigma=max(0.3, args.deblur_sigma * 1.75), K=0.006)
        rescue_boost = boost_frequency_1d(rescue_deblur, boost=max(1.0, args.freq_boost + 0.8))
        rescue_candidates = infer_candidates(rescue_boost, center_priority=max(0.0, args.center_priority + 0.4))
        candidates.extend(rescue_candidates)

    best = max(candidates, key=lambda c: c.score) if candidates else None
    external = optional_external_decode(fused)
    # Promote external decode if inference had none.
    ext_code = external.get("opencv_barcode") or external.get("pyzbar")
    if not best and ext_code:
        best = Candidate(
            code=str(ext_code),
            score=2.0,
            window_start=0,
            module=0.0,
            quant_error=0.0,
            window_center_x=float(boosted.shape[0] * 0.5),
            center_proximity=0.5,
        )
    # If external decoder agrees, bump confidence notion.
    if best and (external.get("opencv_barcode") == best.code or external.get("pyzbar") == best.code):
        best.score += 2.0

    input_ref = args.image if args.image else args.video
    save_debug(
        args.out_dir,
        input_ref,
        rois[0],
        fused,
        signal,
        deblurred,
        boosted,
        best,
        len(candidates),
        len(frames),
        external,
        focus_laplacian_var,
        focus_edge_x_mean,
        blur_detected,
        used_blur_recovery,
    )

    print("Center ROI box (x,y,size,size):", roi_box)
    print("Frames used:", len(frames))
    print("Candidates found:", len(candidates))
    if best:
        print("Most likely barcode:", best.code)
        print("Score:", round(best.score, 3))
        print("Module estimate:", round(best.module, 3))
        print("Quantization error:", round(best.quant_error, 5))
        print("Center proximity:", round(best.center_proximity, 5))
    else:
        print("Most likely barcode: none")
    print("Focus Laplacian var:", round(focus_laplacian_var, 3))
    print("Focus edge-x mean:", round(focus_edge_x_mean, 3))
    print("Blur detected:", blur_detected)
    print("Blur recovery used:", used_blur_recovery)
    if external.get("opencv_barcode"):
        print("OpenCV barcode detector:", external["opencv_barcode"])
    if external.get("pyzbar"):
        print("pyzbar:", external["pyzbar"])
    print("Debug output:", args.out_dir)


if __name__ == "__main__":
    main()
