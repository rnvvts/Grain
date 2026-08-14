# Grain

A browser-based image format converter for PNG, JPEG, WEBP, AVIF, and SVG. It
also reads HEIC — the format iPhones shoot in — as an input, though HEIC can
never be an output. See [Format support](#format-support) for why.

## Privacy

Every conversion runs entirely in your browser. Images are never uploaded, never
sent to a server, and never leave your machine — there is no server to send them
to. The site is static files on GitHub Pages; the decoding, resizing, and
encoding all happen in local JavaScript and WebAssembly.

A practical consequence: once the page has loaded, it works offline. You can
disconnect from the network and keep converting.

HEIC is the one asterisk on that. Its decoder is a separate ~1.4 MB chunk that
is only fetched the first time you convert a HEIC file, so that one fetch needs
a connection. It comes from this same site, not a CDN, and once fetched it is
cached like the rest of the page. Your images are still never part of any
request.

## Format support

Browsers can decode PNG, JPEG, WEBP, and AVIF natively via `createImageBitmap()`,
and can encode PNG, JPEG, and WEBP natively via `canvas.toBlob()`. AVIF is the
gap — no browser implements AVIF encoding in `canvas.toBlob()`, so AVIF output
always goes through a bundled WebAssembly encoder.

HEIC is a wider gap, and an asymmetric one. Safari decodes it natively because
macOS and iOS ship the system HEVC codecs; no other browser does, so everywhere
else decoding falls back to WASM. Encoding is not a gap that can be closed at
all — see the note below the table.

| Format | Decode (reading your file) | Encode (writing the result) |
| --- | --- | --- |
| PNG | Native — `createImageBitmap()` | Native — `canvas.toBlob('image/png')` |
| JPEG | Native — `createImageBitmap()` | Native — `canvas.toBlob('image/jpeg')` |
| WEBP | Native — `createImageBitmap()` | Native — `canvas.toBlob('image/webp')` |
| AVIF | Native in Chrome 85+, Firefox 93+, Safari 16.4+; WASM fallback (`@jsquash/avif`) on older browsers | **WASM always** — `@jsquash/avif`. No browser can encode AVIF natively. |
| HEIC | Native on Safari (macOS/iOS, system codecs); WASM (`libheif-js`) everywhere else, ~1.4 MB fetched on the first HEIC only | **Never.** No HEVC encoder is available in WASM (patents), so HEIC cannot be an output format. |
| SVG | Native — the browser's own SVG renderer, drawn to a canvas like any other image | **Not a real encode.** See below. |

The AVIF codec is bundled with the site, not fetched from a CDN, so the offline
property holds for AVIF too. The HEIC decoder is served from the same site but
is code-split: it downloads on the first HEIC conversion and is cached from then
on, so nobody who never touches a HEIC pays 1.4 MB for it.

**HEIC is input-only, permanently.** A HEIC file's payload is an HEVC-coded
image, and the HEVC *encoder* is patent-encumbered — the WASM build of libheif
ships no encoder at all. This is not a gap waiting on browser support or a
faster machine; there is nothing to enable. HEIC therefore never appears in the
output format picker. Drop iPhone photos in and pick PNG, JPEG, WEBP, AVIF, or
SVG for the result.

Filename extensions and the `File.type` the OS reports are treated as hints
only; the magic bytes decide. That matters most for HEIC, since iOS frequently
reports no useful type at all, and because HEIC and AVIF are the same ISO-BMFF
container — they are told apart only by the brand recorded in the `ftyp` box.

**SVG output is not vectorisation.** No browser, and no WASM library shipped
here, turns a photo's pixels into vector paths — that is a fundamentally
different (and much harder) problem than format conversion. "Converting to
SVG" means embedding a losslessly-encoded PNG inside a minimal
`<svg><image></svg>` wrapper. The result is a valid, sharp `.svg` file that
scales in a layout like a vector, but it is exactly as sharp as the PNG inside
it and is usually *larger* than the source, not smaller — an SVG source file,
by contrast, decodes for real, since the browser's own SVG renderer draws it.

## Local development

```
npm install
npm run dev
```

Then build and check the production output locally:

```
npm run build
npm run preview
```

`npm run preview` serves the contents of `dist/` — worth doing before deploying,
since it is the only way to catch asset-path and WASM-loading problems that do
not appear in the dev server.

## Deployment

Deployment is automatic. Pushing to `main` triggers
`.github/workflows/deploy.yml`, which builds the site and publishes it to GitHub
Pages. The workflow can also be run manually from the Actions tab.

One-time setup on a fresh repository:

1. Open the repository on GitHub.
2. Go to **Settings** > **Pages**.
3. Under **Source**, select **GitHub Actions**.

That is the whole setup. If you skip it, the workflow will run and then fail at
the deploy step.

No path configuration is needed. `vite.config.ts` sets `base: './'`, which emits
relative asset URLs, so the same build works unchanged at
`user.github.io/repo-name/` and at `user.github.io/` or a custom domain. Do not
replace this with an absolute base or absolute asset paths — that is what breaks
project-page deployments.

## Limitations

**Metadata is not preserved.** EXIF, ICC color profiles, GPS tags, and
orientation flags are lost during conversion. This is inherent to the approach,
not an oversight: drawing an image to a canvas yields raw RGBA pixels and
discards everything else. The most visible symptom is a photo from a phone
camera that was stored rotated with an EXIF orientation flag — the output may
appear rotated compared to what your photo viewer showed. If the metadata
matters to you, keep the original file.

**Large images can exhaust browser memory.** Decoded images are held
uncompressed: a 12,000 x 8,000 pixel image is roughly 384 MB of RGBA pixel data
before any encoding begins, and the encoder needs its own working memory on top
of that. Very large images, or many large images at once, can slow the browser
down or cause the tab to crash. Converting in smaller batches helps.

**AVIF encoding is slow at high effort.** The effort setting trades time for
file size. High effort values can take many seconds per image, and the cost
grows with pixel count. If a conversion feels stuck, lower the effort first.
This is the nature of AVIF encoding, not a limitation of running it in the
browser.

**A HEIC yields only its primary image.** A HEIC container can hold several
pictures — a burst, or the still-plus-motion pair of a Live Photo. Only the
primary image is decoded and converted; the other frames and any motion track
are dropped. The output is one file per input file, the same as every other
format.

**HEIC is the slowest input.** Decoding HEVC costs considerably more than
decoding a JPEG or a PNG, and off Safari it runs in WASM rather than the
system codec. A large batch straight off a phone will take noticeably longer
than the same number of JPEGs, and the first HEIC in a session also pays the
one-time decoder download. Smaller batches keep it responsive.

**Color is treated as sRGB.** Since ICC profiles are dropped, images in wider
gamuts are converted as though they were sRGB, which can shift colors.
