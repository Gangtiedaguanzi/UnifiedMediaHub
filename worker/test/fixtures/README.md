# Synthetic local fixtures

These files were generated locally for UnifiedMediaHub tests; they are not downloaded platform content.

- `synthetic-grid.mp4`: 1 second, 160 x 90 H.264 test pattern, 11,009 bytes. SHA-256 `aacde4542a5061a8767142d766f4581b14ebf51a03c9647055d8e0c7f2a174c3`.
- `synthetic-blue.png`: 64 x 64 solid blue image, 200 bytes. SHA-256 `7d1dc11be712c39a7c343e934740d84c936896959d13e9983cf15ea6c1473288`.

The controller generated and independently decoded the MP4 using its isolated validation-only ffmpeg. Tests serve these bytes over a local HTTP server and compare the saved bytes and SHA-256. No ffmpeg dependency is required by the worker test suite or shipped by this task.

Task4 engine adapters use `engine-child.mjs` for isolated child-process boundary
fixtures and intercepted Chromium responses for X account observations. All
identities, credentials and media manifests in these fixtures are synthetic;
no existing sessions are read and no platform/account calls are made.
`engine-help-smoke.mjs` is an explicit offline smoke script, outside automatic
platform fixtures. It launches only packaged engine help commands in fresh
private environment/storage roots and deletes them finally.

The inline 28-byte Telegram stripped-thumbnail golden fixture is a public
upstream gotd/td v0.140.0 test vector (not generated here and not user/platform
content). It reconstructs a 650-byte JPEG, 40 x 14 pixels, SHA-256
`a3c4ff73ba1ddd11599c823b448146d5e32e9429d04108ec7efafeccea100227`.
See `worker/THIRD-PARTY-ENGINE-NOTICES.txt` for original-source attribution and
license text. Thumbnail tests use the built-in Windows WPF decoder, not ffmpeg
or an original-media download, to prove that the reconstructed bytes decode.

`synthetic-telegram-photo.jpg` is the stored 650-byte reconstruction of that same
public gotd test vector (despite the fixture filename, it is not a newly created
scene). Its SHA-256 is the golden value above. Telegram adapter success tests
use this complete decodable JPEG and exact expected size; the 12-byte JPEG-header
fragment is now only a negative truncation fixture and must never earn a receipt.
