# Testing camera features (barcode scan) on a phone

`navigator.mediaDevices` — and with it the camera barcode scanner in
[`barcode-scan.component.ts`](../packages/frontend/src/app/shared/barcode-scan.component.ts)
— only exists in a **secure context**: HTTPS, or the special-cased
`localhost`. The dev server already binds `0.0.0.0` so a phone on the same
Wi-Fi can reach it, but plain `http://<lan-ip>:4201` is not a secure context,
so the "Scan" button won't appear there. This sets up a locally-trusted HTTPS
cert so it does.

One-time setup, per dev machine + per phone you want to test from.

## 1. Install mkcert and create a local CA (dev machine)

Needs an elevated/admin terminal — it installs a root certificate into your
system and browser trust stores.

```powershell
choco install mkcert
mkcert -install
```

(No Chocolatey? Grab the `mkcert-vX.Y.Z-windows-amd64.exe` binary from the
[mkcert releases page](https://github.com/FiloSottile/mkcert/releases),
rename it `mkcert.exe`, put it on your `PATH`, then run `mkcert -install`.)

## 2. Issue a cert for this machine

Find your LAN IP (`ipconfig`, look for the adapter you're actually connected
to — Wi-Fi or Ethernet) and generate a cert covering it:

```powershell
cd packages/frontend
mkdir tls
mkcert -key-file tls/dev-key.pem -cert-file tls/dev-cert.pem localhost 127.0.0.1 ::1 <your-lan-ip>
```

`packages/frontend/tls/` is gitignored — these files are machine-specific and
must never be committed. Re-run this command if your LAN IP changes (e.g. new
network, DHCP lease change).

## 3. Trust the CA on the phone (once per phone)

mkcert trusting your dev machine doesn't make the phone trust it. Find the
root CA with `mkcert -CAROOT` (prints a folder containing `rootCA.pem`), get
that file onto the phone (AirDrop, or serve it over the LAN and open it in
Safari), then on the iPhone:

1. **Settings → General → VPN & Device Management** → install the profile.
2. **Settings → General → About → Certificate Trust Settings** → enable full
   trust for the mkcert root certificate.

## 4. Run the dev server over HTTPS

```powershell
npm run dev:backend        # separate terminal, unchanged
npm run dev:frontend:https
```

From the dev machine, `https://localhost:4201` should load with no cert
warning. From the phone (same Wi-Fi), browse to `https://<your-lan-ip>:4201`
— also no warning once step 3 is done. The pantry-item form's "Scan" button
should now appear, and tapping it will ask for camera permission and scan
using ZXing (iOS Safari has no native `BarcodeDetector`, so it always takes
that fallback path).

This is purely a dev convenience — it does not change how the app is built or
deployed, and no application code depends on it.
