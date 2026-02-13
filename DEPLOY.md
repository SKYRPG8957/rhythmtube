# 리듬튜브 Deployment Guide (YouTube Reliable Mode)

This app must run with the backend API (`/api/youtube/*`) enabled. Static-only hosting will break YouTube loading for many clients.

## Recommended: Deploy as One Web Service

Run frontend + backend from the same service/domain:

- Backend serves `dist/` and API together (`server/index.ts`)
- YouTube API calls stay same-origin (fewer CORS/origin issues)
- ffmpeg is available in container for better cross-client audio compatibility

## Option A: Render (recommended)

This repo includes `render.yaml` and `Dockerfile`, so Render can run frontend+backend as one service.

Steps:

1. Create a new Render Blueprint from this repo.
2. Confirm service `rhythmtube` is detected from `render.yaml`.
3. Deploy.
4. Verify:
   - `https://<your-service>.onrender.com/healthz`
   - game opens and YouTube URL load works.

## Option B: Docker Deployment

Build and run locally:

```bash
docker build -t rhythmtube .
docker run --rm -p 3001:3001 rhythmtube
```

Open: `http://localhost:3001`

## Option C: Non-Docker deployment

Requirements on server:

- Node.js 20+
- ffmpeg installed and accessible in PATH

Commands:

```bash
npm ci
npm run build
PORT=3001 npm run start
```

## Environment Variables

- `PORT` (server listen port, default `3001`)
- `VITE_API_BASE_URL` (optional; only needed if frontend is hosted separately)

If frontend and backend are deployed as one service/domain, do not set `VITE_API_BASE_URL`.

## Health Check

- `GET /healthz` -> `{ "ok": true }`

## Notes for YouTube Stability

- Keep backend running (no static-only mode)
- Keep ffmpeg installed (server prefers MP3 extraction path)
- iOS/macOS clients now request MP4-only fallback when needed
- `yt-dlp` is auto-detected (system binary) or downloaded at runtime
