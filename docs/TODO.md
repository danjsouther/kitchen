# TODO

- implement recipe sharing
- add support for meal prep, recipe spans multiple days on the calendar
- pantry form: selecting a product should fill out `how much` and `units`
- ~~use phone camera to scan barcode~~ — done (`packages/frontend/src/app/shared/barcode-scan.component.ts`, native `BarcodeDetector` + `@zxing/browser` fallback). Needs HTTPS to test from a phone on the LAN — see [docs/DEV-HTTPS.md](DEV-HTTPS.md).
- add product for every match on scanned barcode