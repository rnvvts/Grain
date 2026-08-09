# Grain

A browser-based image format converter for PNG, JPEG, WEBP, AVIF, and SVG.

## Privacy

Every conversion runs entirely in your browser. Images are never uploaded, never
sent to a server, and never leave your machine — there is no server to send them
to. The site is static files on GitHub Pages; the decoding, resizing, and
encoding all happen in local JavaScript and WebAssembly.

A practical consequence: once the page has loaded, it works offline. You can
disconnect from the network and keep converting.

## Format support

Browsers can decode PNG, JPEG, WEBP, and AVIF natively via `createImageBitmap()`,
and can encode PNG, JPEG, and WEBP natively via `canvas.toBlob()`. AVIF is the
gap — no browser implements AVIF encoding in `canvas.toBlob()`, so AVIF output
always goes through a bundled WebAssembly encoder.

| Format | Decode (reading your file) | Encode (writing the result) |
| --- | --- | --- |
| PNG | Native — `createImageBitmap()` | Native — `canvas.toBlob('image/png')` |
| JPEG | Native — `createImageBitmap()` | Native — `canvas.toBlob('image/jpeg')` |
| WEBP | Native — `createImageBitmap()` | Native — `canvas.toBlob('image/webp')` |
| AVIF | Native in Chrome 85+, Firefox 93+, Safari 16.4+; WASM fallback (`@jsquash/avif`) on older browsers | **WASM always** — `@jsquash/avif`. No browser can encode AVIF natively. |
| SVG | Native — the browser's own SVG renderer, drawn to a canvas like any other image | **Not a real encode.** See below. |

The WASM codecs are bundled with the site, not fetched from a CDN, so the
offline property holds for AVIF too.

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

**Color is treated as sRGB.** Since ICC profiles are dropped, images in wider
gamuts are converted as though they were sRGB, which can shift colors.
