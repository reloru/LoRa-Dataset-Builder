# LoRa-Dataset-Builder
Throw images in, get a trainer-ready ZIP out

A phone-first web app that turns photos into a correctly built training ZIP for
Pruna's two LoRA trainers, flags what Pruna's docs say to avoid, and can run the
training and put the weights on Hugging Face. It runs on Cloudflare Workers:
the pages are static files, and a small Worker relays calls to Pruna and
Hugging Face.

| Dataset | Trainer | Use the LoRA with |
|---|---|---|
| Photos + captions | `p-image-trainer` ($1.80 / 1,000 steps) | `p-image-lora` |
| Before / after pairs | `p-image-edit-trainer` ($4.00 / 1,000 steps) | `p-image-edit-lora` |

## Using it

1. **Start** — pick *Photos + captions* or *Before / after pairs*, or open a ZIP
   you already have to check and fix it. One dataset is kept at a time.
2. **Build** — add photos, or add pairs one at a time (before, then after), with
   optional extra reference images per pair. Write a caption or edit
   instruction for each. A trigger word can be added to the start of every
   caption automatically (skipped where a caption already contains it), and a
   default caption fills any left empty.
3. **Check** — everything Pruna's docs warn about is listed, per photo or pair,
   with a jump to it. Nothing blocks the ZIP; it is your call. Download the ZIP
   from here (the share sheet's *Save to Files* on an iPhone).
4. **Train** (optional) — enter a Pruna API key (kept only for this visit, or
   remembered on the device if you tick the box), adjust any setting (each
   shows its range and Pruna's default, and your changes are remembered), and
   start. The app uploads the ZIP, starts the job, and watches it. Leaving or
   closing the app is fine: reopening offers to pick the job back up. When it
   finishes, the LoRA ZIP is downloaded to the phone straight away, since
   Pruna's link expires about 30 minutes after training ends.
5. **Hugging Face** (optional) — with a *Write* token from
   [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens), the
   weights go to a model repository (created if missing, private by default) as
   `weights.safetensors`. The app then shows the exact `lora_weights` value to
   paste into Patchbay; for a private repository Patchbay also needs the token
   in its Hugging Face API token field.

## What the ZIP contains

A flat archive, no folders, in the layout Pruna's own training notebooks write:

```
image_000.jpg  image_000.txt  image_001.jpg  image_001.txt  …        photos
pair_000_start.jpg  pair_000_start2.jpg  pair_000_end.jpg  pair_000.txt  …   pairs
```

- Every image is re-encoded as JPEG, at most 1024 px on its long edge, quality
  0.9. On 15 camera photos (8–24 MP) that averaged 144 KB per image in
  Chromium — about 690 images or 345 pairs per 100 MB. iPhone Safari uses a
  different encoder, so sizes there may differ (not measured).
- A caption file is written for every item that has a caption (its own, the
  default, or the trigger word alone). Pruna fails training when captions are
  missing and no `default_caption` is set; Replicate's page for the same
  trainer says uncaptioned images are ignored. Writing one per item satisfies
  both.
- Pairs use `_start` / `_end` (Pruna's guide also accepts `_input` / `_target`;
  the API spec names only `_start` / `_end`). Extra references are
  `_start2`, `_start3`, … Masks are left out: they appear in Pruna's guide but
  not in the API's description of `image_data`.
- Before and after must be the same size and pixel-aligned. When they differ:
  same shape → both scaled to one size; different shape → the before is
  cropped at its center to the after's shape, then both scaled, and the pair
  is flagged so you can check alignment with **Flip**. Nothing is ever
  enlarged.
- The ZIP must stay under 99 MB to train from the app: Pruna's file upload
  refuses anything over 100 MB, and so does Cloudflare's Free plan for request
  bodies. A larger ZIP can still be downloaded.

## What gets flagged

Fewer than 10 photos · images under 512×512 · missing captions (before the
default caption is used) · captions without the trigger word · the same
caption on two photos (not flagged for pairs: Pruna's own edit notebook gives
every pair the same instruction) · near-duplicate images (a 64-bit difference
hash, within 5 bits) · pairs missing a side · pairs cropped to match · a ZIP
over the upload limit. Pruna's suggested dataset sizes are shown on the Check
step.

## Architecture

```
Browser (public/)                          Cloudflare Worker (src/worker.js)
  resize · caption · check · ZIP   ──►  /api/pruna/files   ──► api.pruna.ai /v1/files
  IndexedDB: dataset in progress        /api/pruna/train   ──► /v1/predictions (trainers only)
  localStorage: settings, job id        /api/pruna/status  ──► /v1/predictions/status/{id}
                                        /api/pruna/output  ──► Pruna delivery links only
                                        /api/hf/whoami     ──► huggingface.co /api/whoami-v2
                                        /api/hf/upload     ──► repos/create → LFS batch →
                                                               upload → verify → commit
```

- **Why a relay at all:** Pruna's API allows browser calls only from its own
  docs site (tested: `Access-Control-Allow-Origin` is returned for
  `https://docs.api.pruna.ai` and no other origin), so the key has to pass
  through a server. The key and the Hugging Face token travel as request
  headers on each call and are never stored by the Worker.
- **Logging is off** (`observability.enabled: false`): Workers Logs invocation
  logs record request headers in plain text, which would store visitors' keys.
- **Uploads are streamed** through `FixedLengthStream`, so a ZIP near 100 MB
  never sits in the Worker's 128 MB of memory, and it arrives upstream with its
  `Content-Length` (storage services such as S3 refuse chunked uploads).
- **Hugging Face upload** follows the Hub's OpenAPI spec for repository
  creation and commits, and `huggingface_hub`'s `lfs.py` for the large-file
  steps (single or multi-part). Hugging Face documents this path as still
  working for repositories on its newer Xet storage.
- **No library, no build step.** The ZIP writer/reader, CRC-32, image pipeline
  and UI are plain browser JavaScript; `wrangler` is the only dev dependency.
- **Content-Security-Policy** (`public/_headers`) allows scripts, styles and
  connections to this site only, which keeps any remembered key away from
  injected code.

## Not yet verified

- **On an iPhone:** HEIC photos, EXIF rotation, the share sheet, and JPEG sizes
  from Safari's encoder. The tests run in Chromium only.
- **Pruna accepting a ZIP through `/v1/files`:** its spec describes the
  endpoint as for images and video. A refused upload fails before any training
  job is created, so the first real run costs nothing if it does not work.
- **Hugging Face for real:** the upload was tested against a stand-in that
  follows the documented protocol, not against huggingface.co.

## Development

```bash
npm install
npm run dev          # wrangler dev on http://localhost:8787
npm test             # logic tests, then the end-to-end run in Chromium
npm run deploy
```

`npm test` needs Playwright installed globally (`npm i -g playwright`); it is
not a dependency of this repo. The end-to-end run starts `wrangler dev`
against `test/mock-upstream.mjs`, a stand-in for Pruna, Hugging Face and the
storage it uploads to, so no keys are needed and nothing is billed.

## License

[MIT](LICENSE)
