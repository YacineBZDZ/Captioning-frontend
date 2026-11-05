# Caption Bench (frontend)

A static single-page app for an image-analysis pipeline. A user uploads one photo or many. A
separate backend (a Hugging Face Space) checks that each is a photograph (MobileNetV2), measures
noise and blur, cleans it if needed (U-Net `unet_mixed`) and writes an English caption
(InceptionV3 + GRU). The backend streams its progress as NDJSON, and this frontend shows each step
live: a timeline for one image (`POST /v1/process`, contract v1), a grid of cards for several
(`POST /v1/batch`, contract v1.1).

The frontend has no secrets and no model code. It is built with Vite and deployed to GitHub Pages.

- **Stack:** Vite, React 18, TypeScript (strict), plain CSS with custom properties. No router and
  no UI kit.
- **Tooling:** Vitest and React Testing Library, ESLint (flat config), Prettier.
- **Privacy:** images are held in memory only and sent to the server for processing. The app uses
  no cookies, no analytics and no storage.

## Scripts

| Script              | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run dev`       | Dev server against `VITE_API_URL`                                    |
| `npm run dev:mock`  | Dev server against the built-in mock backend, with a scenario picker |
| `npm run build`     | Type-check, then build to `dist/` (also writes `dist/404.html`)      |
| `npm run preview`   | Serve the production build                                           |
| `npm test`          | Run the test suite once                                              |
| `npm run lint`      | ESLint                                                               |
| `npm run typecheck` | `tsc -b`                                                             |
| `npm run format`    | Prettier                                                             |

## Configuration

All configuration is read **at build time** from `VITE_*` environment variables. See `.env.example`.

| Variable        | Default                 | Meaning                                                                         |
| --------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `VITE_API_URL`  | `http://localhost:7860` | Backend base URL, without a trailing slash (e.g. `https://user-space.hf.space`) |
| `VITE_BASE`     | `/`                     | Vite `base` (public path). Use `/<repo-name>/` for a GitHub Pages project site  |
| `VITE_MOCK`     | unset                   | `true` loads the built-in mock backend instead of calling `VITE_API_URL`        |
| `VITE_REPO_URL` | unset                   | Optional link to this README from the "How it works" section (set by CI)        |

The mock backend is loaded with a dynamic `import()` only when `VITE_MOCK === "true"`. Vite replaces
that condition with a constant, so production builds contain no mock code. To check:
`npm run build && grep -r createMockBackend dist || echo clean`.

## Running locally

Node 20 or newer.

```bash
npm ci
```

**Against the mock backend** (no Python needed):

```bash
npm run dev:mock
```

This uses `.env.mock` (`VITE_MOCK=true`). A "Mock backend" panel in the bottom-right corner selects
the scenario.

- **Single image:** clean photo, noisy photo, misclassified noisy photo rescued by
  reclassification, clean painting, degraded painting, invalid image, file too large, server busy,
  internal error, connection lost mid-stream, server starting, server offline. Each step waits a
  realistic 100 to 1500 ms.
- **Batch:** mixed batch (one of each), 12 clean photos, all not photos, only invalid files, 20
  images, 45 images (auto-split with the limit of 20), server busy, `TOO_MANY_FILES` (the server
  really allows 5; "Retry with smaller groups" re-reads the limit), connection lost mid-batch, only
  heartbeats then silence (the client gives up after 90 s, so this one takes about 100 s), one item
  with `BATCH_TIMEOUT` (it succeeds on "Retry failed"), and an old backend without `batch` in
  `/v1/info`. Choose a batch scenario, then press **Load N sample files**: the panel draws test
  images and puts them in the real file input.

In batch mode the mock decides each image's fate from its file name, so you can also drop your own
files: a name containing `bad` is an invalid file, `degraded` is rejected after the re-check,
`paint` is a rejected painting, `rescue` is misclassified then rescued, `noisy` is denoised, and
anything else is a clean photo. Each stage runs in micro-batches of 3 images.

**Against a local backend** listening on port 7860:

```bash
cp .env.example .env.local      # edit VITE_API_URL if needed
npm run dev                     # http://localhost:5173
```

The backend must allow the dev origin (`http://localhost:5173`) through CORS. Its contract allows
localhost origins.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` runs on every push to `main`. It installs, lints, type-checks, tests
and builds with `VITE_API_URL=${{ vars.API_URL }}` and `VITE_BASE=/<repo-name>/`, then publishes
`dist/` with `actions/deploy-pages`.

One-time setup in the GitHub repository:

1. **Settings → Pages → Build and deployment → Source = "GitHub Actions".**
2. **Settings → Secrets and variables → Actions → Variables → New repository variable:**
   `API_URL` = your Space URL, e.g. `https://<hf-user>-<space-name>.hf.space` (no trailing slash).
3. Push to `main`. The site is published at `https://<user>.github.io/<repo-name>/`.

The backend must allow the origin `https://<user>.github.io` through CORS.

## How the app behaves

- **Server status** (header). The app polls `GET /health` with a 5 s timeout.
  - online: polled every 20 s. Two consecutive failures while online switch it to offline.
  - starting (HTTP 503 `loading`): polled every 3 s.
  - offline (network or CORS error, timeout, or an HTML or unexpected body): polled after 10 s, with
    the delay doubling up to 60 s.
  - **Wake up server** pings every 5 s for up to 3 minutes and shows an elapsed timer.
  - Polling pauses while the tab is hidden and checks again as soon as the tab is visible.
  - `GET /v1/info` is fetched once, the first time the server is online. If that fails, the app uses
    10 MB and JPEG/PNG/WEBP/BMP.
- **Upload.** Drag and drop, a real `<input type="file" multiple>`, or paste from the clipboard.
  The app checks each file's type and size before uploading. One valid file gets the single-image
  flow with a large preview; two or more get the batch flow with a thumbnail grid.
- **Pipeline.** `POST /v1/process` is read as a stream. `src/api/ndjson.ts` holds the pure parser.
  `src/state/pipeline.ts` holds the reducer that drives the timeline. Only the terminal
  `result`/`error` event ends a run. A stream that closes without one is `CONNECTION_LOST`, and 60 s
  without any event is `TIMEOUT`.
- **Errors.** `src/api/errors.ts` maps each code to a title, a message and an action. The alert has
  `role="alert"` and receives focus, and the failed step is highlighted. `MODEL_NOT_READY` switches
  the status to starting and resends the same image automatically once the server is online.
  `SERVER_BUSY` waits for `Retry-After`.

## Analysing many images (batch)

Batch needs a server whose `GET /v1/info` contains `batch` (contract v1.1). On an older server the
file input accepts one file at a time and the page says "This server handles one image at a time".

**Limits**

| Limit                | Where it comes from               | What happens when exceeded                      |
| -------------------- | --------------------------------- | ----------------------------------------------- |
| Size per file        | `max_upload_mb` (default 10 MB)   | That file is listed as refused, others kept     |
| Type per file        | `allowed_types`                   | That file is listed as refused, others kept     |
| Images per request   | `batch.max_images` (e.g. 20)      | The selection is split into groups, not refused |
| Bytes per request    | `batch.max_total_mb` (e.g. 60 MB) | The selection is split into groups, not refused |
| Images per selection | Client cap: 200                   | The extra files are not added, with a message   |

**Selection.** Drop, pick or paste as many images as you like; each new drop adds to the
selection. The panel shows thumbnails with a remove button, "Clear all", and counters (images,
total size, number of groups). The Options (denoising, decoding) apply to every image. "Analyse N
images" is enabled only while the server is online, and a visible line explains why when it is not.

**Run.** Groups are sent one after another ("Group 2 of 3") and merged into one view, in upload
order:

- a stage strip (Upload › Classification › Quality › Denoising › Re-check › Captioning) with how
  many images went through each stage;
- a progress bar (images with a verdict / total), the elapsed time and **Cancel** (finished images
  are kept, the others are marked "Cancelled");
- one card per image with a thumbnail, a status pill (text and colour), the class ("Photo 97 %")
  and "Denoised" badges as soon as they are known, then the caption. Rejected images stay visible
  with a short explanation, amber for "Not a photo" and red for errors, and never show a caption.

Clicking a card (or pressing Enter on it) opens a dialog with the same details as the single-image
timeline: probability bars, quality values and thresholds, the before/after slider and the caption.
There are no per-image timings because the server only times stages.

**When finished:** a summary ("9 captioned, 2 not photos, 1 error" and the total time), filter
chips (All / Captioned / Not a photo / Errors), **Copy all captions** (one `filename: caption` line
each), **Download CSV** (UTF-8 with BOM; columns `filename, status, predicted_class, confidence,
denoised, caption, error_code`), **Download JSON**, a Copy button per card, **Retry failed** and
**Process other images**. Downloads are built in the browser. "Retry failed" sends again only the
images that can succeed on a second try (`INTERNAL_ERROR`, `BATCH_TIMEOUT`, Interrupted, Cancelled),
from the files still held in memory. "Not a photo" and invalid files are not retried.

**Batch-level problems** show an alert above the results and never discard finished images.
`SERVER_BUSY` offers "Retry in N s" (from `Retry-After`). `MODEL_NOT_READY` switches the status to
"starting" and retries automatically once the server is online. `TOO_MANY_FILES` and
`BATCH_TOO_LARGE` (which the auto-split should prevent) re-read `/v1/info` and offer "Retry with
smaller groups". `SERVER_OFFLINE`, `CONNECTION_LOST`, `TIMEOUT` (90 s without any line, heartbeats
included) and `INTERNAL_ERROR` offer a retry of the unfinished images and show the request ID. A
stream that ends without `batch_result` marks the unfinished images "Interrupted".

### Source layout

```
src/
  api/        types.ts (contract v1 + v1.1), ndjson.ts, client.ts (health/info/process),
              batchClient.ts (/v1/batch, watchdog, group runner), errors.ts
  state/      pipeline.ts (single-run reducer, shared ImageRun shape), batch.ts (batch reducer),
              batchSplit.ts (auto-split, 200 cap), batchExport.ts (CSV/JSON/text),
              health.ts (status state machine), describe.ts + batchDescribe.ts (texts)
  hooks/      useServerStatus, usePipeline, useBatchRun, useAnnouncer, useThrottledAnnounce
  components/ StatusIndicator, UploadPanel, SelectionGrid, Timeline, ProbabilityBars,
              BeforeAfter, ErrorAlert, ResultCard, HowItWorks, batch/ (BatchView, BatchCard,
              BatchDialog, StageStrip, BatchAlert)
  mocks/      mockBackend.ts, DevPanel.tsx  (dev and tests only)
```

## API contract v1 (identical in both repos)

Base URL = backend root, e.g. `https://<hf-user>-<space-name>.hf.space` (no trailing slash).

### GET /health (no inference, < 100 ms, no auth)

```
200 {"status":"ok","models":{"classifier":true,"denoiser":true,"captioner":true},"uptime_s":812,"version":"1.0.0"}
503 {"status":"loading","models":{"classifier":true,"denoiser":false,"captioner":false},"uptime_s":4,"version":"1.0.0"}
```

### GET /v1/info

```
200 {"version":"1.0.0","max_upload_mb":10,"allowed_types":["image/jpeg","image/png","image/webp","image/bmp"],"classes":["Painting","Photo","Schematics","Sketch","Text"],"photo_threshold":0.5,"quality":{"calibrated":false,"noise_sigma_threshold":0.02,"sharpness_threshold":60.0},"models":{"classifier":"MobileNetV2","denoiser":"unet_mixed","captioner":"InceptionV3 + GRU"},"defaults":{"denoise":"auto","decoding":"beam"}}
```

### POST /v1/process (multipart/form-data)

Fields: `file` (required) | `denoise` = `auto|always|never` (default `auto`) | `decoding` =
`beam|greedy` (default `beam`).

Response 200, `Content-Type: application/x-ndjson`. One JSON object per line, each ending with
`"\n"`. Header `X-Request-ID` is set. Clients ignore blank lines.

Line types:

```
{"event":"started","request_id":"a1b2c3d4","filename":"cat.jpg","width":1024,"height":768,"bytes":183422}
{"event":"step","step":"<name>","status":"running"}
{"event":"step","step":"<name>","status":"done"|"skipped","elapsed_ms":123,"data":{...}}
{"event":"result", ...}   or   {"event":"error", ...}   <- exactly ONE terminal event, then the stream closes.
```

Step names: `validation`, `classification`, `quality`, `denoising`, `reclassification`,
`captioning`. Every emitted step sends `running` first, then `done` or `skipped`. Steps that do not
happen are not emitted.

Step data:

```
validation/done: {"width":1024,"height":768,"format":"JPEG","bytes":183422}
classification/done and reclassification/done: {"predicted_class":"Photo","confidence":0.97,"probabilities":{"Painting":0.01,"Photo":0.97,"Schematics":0.0,"Sketch":0.01,"Text":0.01},"is_photo":true,"photo_threshold":0.5,"input":"original"|"denoised"}
quality/done: {"noise_sigma":0.031,"sharpness":148.2,"is_noisy":true,"is_blurry":false,"reason":"clean"|"noisy"|"blurry"|"noisy_and_blurry","needs_denoising":true,"thresholds":{"noise_sigma":0.02,"sharpness":60.0},"calibrated":false}
denoising/done: {"applied":true,"model":"unet_mixed","image":"data:image/jpeg;base64,...","width":192,"height":192}
denoising/skipped: {"applied":false,"reason":"clean"|"disabled_by_request"}
captioning/done: {"caption":"a brown bear is standing in the grass","decoding":"beam","beam_width":3,"input":"original"|"denoised"}
```

Terminal events:

```
{"event":"result","caption":"...","classification":{<final classification data>},"quality":{<quality data>},"denoising":{"applied":true},"timings_ms":{"classification":41,"quality":9,"denoising":212,"captioning":133},"total_ms":412}
{"event":"error","code":"NOT_A_PHOTO","step":"classification","message":"This image looks like a painting (93 %), not a photograph.","details":{<classification data>,"rechecked":false}}
```

Flows (a step whose data has `is_photo:false` is not an error; only the terminal event is):

- **A** clean photo: validation, classification, quality, denoising (skipped "clean"), captioning,
  result.
- **B** noisy/blurry photo: validation, classification, quality, denoising (done), captioning (input
  "denoised"), result.
- **C** clean non-photo: validation, classification (is_photo false), quality, then error
  NOT_A_PHOTO (rechecked false).
- **D** degraded image first called non-photo: ..., classification (is_photo false), quality
  (degraded), denoising (done), reclassification, then captioning + result, or error NOT_A_PHOTO
  (rechecked true, step "reclassification").

Error codes (same JSON shape in-stream and as the HTTP body of pre-stream failures; `step` may be
absent for pre-stream ones):

`INVALID_IMAGE` 400 (cannot decode, side < 32 px, too many pixels) | `INVALID_PARAMETER` 400 |
`FILE_TOO_LARGE` 413 | `UNSUPPORTED_TYPE` 415 | `SERVER_BUSY` 429 (Retry-After header) |
`MODEL_NOT_READY` 503 | `NOT_A_PHOTO` (in-stream) | `INTERNAL_ERROR` 500 or in-stream (generic
message, no stack trace).

Client-only codes: `CONNECTION_LOST`, `TIMEOUT`, `SERVER_OFFLINE`.

CORS: the backend allows the GitHub Pages origin (`https://<user>.github.io`); it also allows
localhost dev origins.

## API contract v1.1 (additions; identical in both repos)

Everything in v1 stays valid and unchanged.

### GET /v1/info adds

```
"version":"1.1.0"
"batch":{"max_images":20,"max_total_mb":60,"micro_batch_size":8,"max_seconds":600}
```

A server without a `batch` key does not support batches.

### POST /v1/batch (multipart/form-data)

Fields: `files` (required, repeated, 1..max_images) | `denoise` = `auto|always|never` | `decoding` =
`beam|greedy`. Query: `stream=true` (default) | `false`.

Response 200 `application/x-ndjson`, header `X-Request-ID`, one JSON object per line.

```
{"event":"batch_started","request_id":"a1b2c3d4","count":3,"items":[{"index":0,"filename":"a.jpg","bytes":183422,"width":1024,"height":768,"format":"JPEG","status":"accepted"},{"index":1,"filename":"b.txt","bytes":120,"status":"rejected","error":{"code":"UNSUPPORTED_TYPE","message":"..."}},{"index":2,...}]}   (count = files received; index = position in the upload)
{"event":"stage","stage":"classification","status":"running","count":2}
{"event":"stage","stage":"classification","status":"done","count":2,"elapsed_ms":88}
{"event":"item_step","index":0,"step":"classification","status":"done"|"skipped","data":{...same step data as v1...}}
{"event":"item_done","index":0,"status":"ok","caption":"...","classification":{...},"quality":{...},"denoising":{"applied":true}}
{"event":"item_done","index":2,"status":"error","error":{"code":"NOT_A_PHOTO","step":"classification","message":"...","details":{...,"rechecked":false}}}
{"event":"heartbeat","t":12}
```

Terminal (exactly one, last):

```
{"event":"batch_result","request_id":"a1b2c3d4","count":3,"succeeded":1,"failed":2,"timings_ms":{"classification":88,"quality":20,"denoising":410,"reclassification":60,"captioning":1300},"total_ms":1900,"items":[{"index":0,"filename":"a.jpg","status":"ok","caption":"...","classification":{...},"quality":{...},"denoising":{"applied":true}},{"index":2,"filename":"c.jpg","status":"error","error":{...}}]}
   or
{"event":"error","code":"INTERNAL_ERROR","message":"..."}
```

- Stage names are the v1 step names except validation (done before `batch_started`):
  classification, quality, denoising, reclassification, captioning. A stage with 0 images is not
  emitted. `running` precedes the stage's `item_step`s; `done` follows them.
- Per image, `item_step` events follow the v1 step order and denoising "skipped" keeps its v1
  reasons. There is no ordering between different images.
- Every index gets exactly one `item_done` (rejected-at-upload items get theirs right after
  `batch_started`; NOT_A_PHOTO items get theirs as soon as the decision is made).
- `batch_result.items` is in index order and omits denoised images.
- Clients ignore unknown events and fields.
- `stream=false` → HTTP 200 with the `batch_result` object as a single JSON body.

Pre-stream HTTP errors (same JSON shape as v1): `INVALID_PARAMETER` 400 (no files, bad fields) |
`TOO_MANY_FILES` 413 (details: `max_images`, `received`) | `BATCH_TOO_LARGE` 413 (details:
`max_total_mb`) | `SERVER_BUSY` 429 (Retry-After) | `MODEL_NOT_READY` 503. Per-file problems
(`FILE_TOO_LARGE`, `UNSUPPORTED_TYPE`, `INVALID_IMAGE`) never fail the batch; they appear as item
errors. New in-stream item code: `BATCH_TIMEOUT`.

Equivalence rule: for each accepted image, classification, quality, `denoising.applied` and caption
equal what `/v1/process` returns for that image alone with the same options.

## Decisions

Choices made where the brief left room:

- **Design.** The frontend-design skill was not available, so the design is hand-made. It aims for
  a "scientific instrument" look: warm off-white or near-black surfaces, a faint graph-paper grid,
  hairline rules, monospace for numbers and labels, and a single teal accent. Amber and red appear
  only for warnings and errors. The app loads no web fonts (system stacks only), so it makes no
  third-party requests.
- **React 18 and Vite 6.** Both are stable and run on Node 20 (CI) as well as newer Node versions.
- **Fetch injection.** The API client receives a `fetch` function. The mock backend is a
  `fetch`-compatible function that returns real `Response` objects with streaming bodies, so the
  mock, the tests and production share the same parsing and client code.
- **Mock splits lines.** The mock writes every NDJSON line as two chunks, so the buffering code is
  exercised all the time.
- **Health while online.** After one failure while online, the app checks again after 5 s rather
  than waiting the full 20 s, so a dead server is detected sooner. Any failure from checking,
  starting or offline counts as offline straight away.
- **Wake-up.** The wake-up loop keeps running while the server reports "starting" and ends when it
  is online. If the server is not online after 3 minutes, the app shows "did not wake up" and goes
  back to the normal offline backoff.
- **Client error code `HTTP_ERROR`.** A non-2xx response whose body is not a JSON error object is
  shown as a generic error with the HTTP status.
- **Retry-After.** The `Retry-After` header is used first, then `details.retry_after`.
- **Errors after the stream starts** are attached to `error.step`. If the event names no step, the
  step that was running is marked failed. Pre-stream errors mark no step.
- **Unknown or invalid lines** in the stream are ignored rather than aborting the run.
- **Provisional "not a photo"** is shown in amber while the run continues. If the run later
  succeeds, the first classification reads "… at first, recovered after cleaning".
- **The denoised preview** (192×192) is stretched back to the original aspect ratio in the
  comparison and result views, because the U-Net works on a resized square.
- **Selecting a new file keeps the previous result** visible until the next run starts, as
  required. "Process another image" clears the result and the selection.
- **404.html.** It is copied from `index.html` by a small Vite plugin at build time, so CI needs no
  extra step.
- **Repo link.** The "How it works" link to this README comes from `VITE_REPO_URL`, which CI sets to
  the repository URL. Local builds without it show plain text instead.
- **Timeout.** The 60 s inactivity timeout covers the upload as well (no event yet).

### Batch (contract v1.1)

- **One file stays single.** One valid file always uses `/v1/process` and the timeline, even on a
  batch server, so the single-image experience is unchanged and works on older servers.
- **Feature detection waits for `/v1/info`.** Until it answers, several files can be selected but
  "Analyse" explains that the limits are being read. On a server without `batch`, the input loses
  `multiple`, a new file replaces the current one, and extra files in one drop are listed as "only
  the first was kept".
- **Adding, not replacing.** On a batch server, every pick, drop or paste adds to the selection
  (up to 200). The refusals shown are those of the latest addition.
- **Splitting** is greedy and keeps the upload order: a group closes when the next image would
  exceed `max_images` or `max_total_mb`. An image larger than `max_total_mb` on its own gets its own
  group, and the server reports it.
- **A batch-level failure stops the remaining groups.** Their images are marked "Interrupted"
  (retryable) and finished images are kept. Continuing to send groups to a busy, starting or
  unreachable server would only fail again.
- **"Retry with smaller groups"** uses the tightest of the re-read `/v1/info` limits and the limits
  named in the error details. If neither is smaller than the group that failed, it halves that
  group. The smaller limit is kept for later retries of the same batch and dropped when a new batch
  starts.
- **"Retry failed"** re-sends `INTERNAL_ERROR`, `BATCH_TIMEOUT`, Interrupted and Cancelled images,
  split again with the current limits. Their cards keep their position; other results stay as they
  are. The elapsed time adds up across attempts.
- **Stage strip counts** show how many images went through each stage out of the whole selection,
  so "Re-check 2 / 12" means two images were re-checked. A "Not a photo" image counts as having gone
  through the stage that rejected it. "Upload" counts images accepted by the server.
- **Item status** ("Classifying", "Cleaning"…) is derived from the stage the server reports as
  running and the image's next step, since `item_step` only reports finished steps.
- **Rendering is throttled.** Stream events are buffered and applied every 100 ms in one reducer
  action. Group start, end, cancel and finish flush the buffer first, so the order is kept.
- **Announcements** go through the polite live region at most once every 2 s. When several messages
  arrive in that window, the latest wins, so the final "All done: …" is never dropped.
- **Watchdog.** Any line resets the 90 s watchdog, including heartbeats, unknown events and invalid
  JSON. A terminal `error` event ends that group as a batch-level failure.
- **`stream=true`** is sent explicitly. The non-streaming mode is not used.
- **CSV.** CRLF line ends and RFC 4180 quoting. Cells starting with `=`, `+`, `-`, `@`, a tab or a
  carriage return get a leading apostrophe. `status` is one of `ok`, `not_a_photo`, `error`,
  `cancelled`, `interrupted`. `denoised` is empty for images that never reached that step. The
  caption is empty for every image that was not captioned. "Copy all captions" flattens line breaks
  so each image stays on one line.
- **Thumbnails** are the selection's object URLs in `<img loading="lazy" decoding="async">`, sized
  by CSS. A file the browser cannot decode shows "No preview". URLs are revoked when an image is
  removed, when the selection or results are reset, and on unmount. A new run of either kind
  replaces the previous results.
- **The detail dialog** is a custom `role="dialog"` with `aria-modal` (not `<dialog>`, which jsdom
  does not fully support). It traps Tab, closes on Esc or a backdrop click, locks page scroll and
  returns focus to the card. Below 600 px wide it is full screen.
- **Mock sample files.** The dev panel draws sample images on a canvas (dev only) and injects them
  through the real file input with a `DataTransfer`, so the scenarios exercise the same code path as
  a user.
