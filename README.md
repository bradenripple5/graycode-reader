# graycode_reader

## Live demo (GitHub Pages)

- https://bradenripple5.github.io/graycode-reader/

## Project background

This project started as a Gray code reader for robot rotation detection.

It quickly shifted to a simpler and more practical approach: use modern phone/laptop cameras and processors, show a high-contrast rotating match-stick target, and estimate angle directly from the image.

Current approach:

- Detect white match-stick pixels in the viewer.
- Use least squares line fitting to estimate the stick axis.
- Use the red tip to resolve direction (so the angle is not ambiguous by 180 degrees).

## How least squares works here (short version)

Given detected stick pixels `(x_i, y_i)`:

1. Compute the center (centroid):
   - `x_bar = average(x_i)`
   - `y_bar = average(y_i)`
2. Center points around the mean:
   - `dx_i = x_i - x_bar`
   - `dy_i = y_i - y_bar`
3. Build second-moment terms:
   - `Sxx = sum(dx_i^2)` (x variance term)
   - `Syy = sum(dy_i^2)` (y variance term)
   - `Sxy = sum(dx_i * dy_i)` (x/y covariance term)
4. The best-fit orientation comes from these variance/covariance terms (equivalently PCA's principal direction for a line cloud).

So yes, your intuition is right: the slope/orientation is determined by how points vary in x and y together, not just a simple rise-over-run between two points.

## Quick start

Initially, run the dev server:

```bash
npm run dev
```

Side note on versioning: the project includes `versioning.html` / `versioning.js` for the versioning UI/logic.

## Local server (HTTP)

Serves `index.html` and `pattern.json` over HTTP.

```bash
python3 server.py
```

## Phone camera access (HTTPS required)

Mobile browsers require a secure origin to access the camera. Use HTTPS with a
locally trusted CA:

1) Generate a local CA and server cert for your IP (auto-detects if omitted):

```bash
./make-certs.sh 10.0.0.87
```

2) Install `ca.crt` on your phone as a CA certificate.

3) Run the HTTPS server:

```bash
python3 server.py --host 0.0.0.0 --port 8000 --https --cert server.crt --key server.key
```

4) Open:

`https://10.0.0.87:8000/`

## Android (Pattern) app scaffold

An Android Studio-ready pattern viewer lives in `android/`.

- Open `android/` in Android Studio (latest).
- `minSdk` is 24.
- JSON pattern data lives at `android/app/src/main/assets/pattern.json`.
- CLI build:
  - `cd android && ./gradlew assembleDebug`
- Install to a connected device:
  - `cd android && ./gradlew installDebug`
  - or `./android/install-debug.sh`
