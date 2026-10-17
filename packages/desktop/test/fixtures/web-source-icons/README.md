# DeepSeek source-icon regression fixtures

These small public icons reproduce the user-reported missing source icons. Downloaded anonymously on 2026-10-17 from the exact `site_icon` URLs shown in the supplied screenshot; every request returned HTTP 200 without redirects. No DeepSeek API or credential was used.

`sources.json` records the original URL, actual Content-Type, byte length and SHA-256. The first four are rejected by the former MIME/format gate; the JPEG was already shown correctly. Two additional screenshot samples cover a multi-frame ICO and WebP served as binary/octet-stream. Tests replay these response bytes through mock transport and the real bounded decoder, with no live requests.

The logos and marks belong to their respective publishers. These files are regression test inputs only, not application UI assets.
