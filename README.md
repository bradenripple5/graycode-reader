# graycode_reader

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
