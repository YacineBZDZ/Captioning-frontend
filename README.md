# Caption Bench (frontend)

A static single-page app for an image-analysis pipeline. A user uploads a photo. A separate backend
(a Hugging Face Space) checks that it is a photograph (MobileNetV2), measures noise and blur, cleans
it if needed (U-Net `unet_mixed`) and writes an English caption (InceptionV3 + GRU). The backend
streams its progress as NDJSON, and this frontend shows each step live.

The frontend has no secrets and no model code. It is built with Vite and deployed to GitHub Pages.

- **Stack:** Vite, React 18, TypeScript (strict), plain CSS with custom properties. No router and
  no UI kit.
- **Tooling:** Vitest and React Testing Library, ESLint (flat config), Prettier.
- **Privacy:** images stay in memory. The app uses no cookies, no analytics and no storage.

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
the scenario: clean photo, noisy photo, misclassified noisy photo rescued by reclassification, clean
painting, degraded painting, invalid image, file too large, server busy, internal error, connection
lost mid-stream, server starting, server offline. Each step waits a realistic 100 to 1500 ms.

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
- **Upload.** Drag and drop, a real `<input type="file">`, or paste from the clipboard. The app
  checks the type and size before uploading and shows a preview.
- **Pipeline.** `POST /v1/process` is read as a stream. `src/api/ndjson.ts` holds the pure parser.
  `src/state/pipeline.ts` holds the reducer that drives the timeline. Only the terminal
  `result`/`error` event ends a run. A stream that closes without one is `CONNECTION_LOST`, and 60 s
  without any event is `TIMEOUT`.
- **Errors.** `src/api/errors.ts` maps each code to a title, a message and an action. The alert has
  `role="alert"` and receives focus, and the failed step is highlighted. `MODEL_NOT_READY` switches
  the status to starting and resends the same image automatically once the server is online.
  `SERVER_BUSY` waits for `Retry-After`.

### Source layout

```
src/
  api/        types.ts (contract), ndjson.ts, client.ts (health/info/process), errors.ts
  state/      pipeline.ts (reducer), health.ts (status state machine), describe.ts (texts)
  hooks/      useServerStatus, usePipeline, useAnnouncer
  components/ StatusIndicator, UploadPanel, Timeline, ProbabilityBars, BeforeAfter,
              ErrorAlert, ResultCard, HowItWorks
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
