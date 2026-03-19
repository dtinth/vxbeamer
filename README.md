# vxbeamer

vxbeamer is a self-hosted, personal speech transcriber with a real-time web interface.

## Overview

For most transcription needs, [Google Gemini](https://ai.google.dev/gemini-api/docs/audio) provides the highest accuracy. However, it comes with high latency. vxbeamer uses a different workflow: [Qwen3-ASR-Flash](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model&url=2840914_2&modelId=qwen3-asr-flash) handles real-time speech recognition, and gpt-oss-120b (an open-source model by OpenAI, served on [Groq](https://groq.com) for fast inference) does post-processing. This trades some accuracy for significantly faster feedback.

The frontend is a PWA that can be added to the home screen. Tap the record button to transcribe, watch the text stream in real time, swipe right to broadcast a transcription as an event (for integrators), and swipe left to delete it.

This project is primarily for personal use and is not designed to be particularly flexible. That said, the setup is documented below.

## Architecture

- **Frontend** — React PWA (`apps/website`), deployed statically
- **Backend** — Node.js/Hono server (`apps/backend`), deployed via Docker
- **ASR** — Qwen3-ASR-Flash via DashScope (Alibaba Cloud)
- **Post-processing** — gpt-oss-120b via Groq (optional, improves transcript quality)

## Deployment

The backend is distributed as a Docker image.

```sh
docker run -p 8787:8787 \
  -e API_KEYS=your-secret-key \
  -e DASHSCOPE_API_KEY=... \
  -e GROQ_API_KEY=... \
  ghcr.io/dtinth/vxbeamer:latest
```

### Environment variables

| Variable             | Required | Description                                                  |
| -------------------- | -------- | ------------------------------------------------------------ |
| `DASHSCOPE_API_KEY`  | Yes      | Alibaba Cloud DashScope key for Qwen3-ASR-Flash              |
| `API_KEYS`           | Yes\*    | Comma-separated static API keys for authentication           |
| `GROQ_API_KEY`       | No       | Groq API key for gpt-oss-120b post-processing                |
| `OIDC_DISCOVERY_URL` | No       | OIDC provider discovery URL (alternative to API keys)        |
| `OIDC_CLIENT_ID`     | No       | OIDC client ID (default: `vxbeamer-mobile`)                  |
| `OIDC_AUDIENCE`      | No       | Expected token audience (default: same as client ID)         |
| `OIDC_SECRET`        | No       | HMAC secret for session tokens (default: `local-dev-secret`) |
| `WEBHOOK_URL`        | No       | Endpoint to POST completed transcriptions to                 |
| `PORT`               | No       | HTTP port (default: `8787`)                                  |

\*Either `API_KEYS` or OIDC must be configured for authentication.

## API

The backend exposes a REST + SSE + WebSocket API on port 8787. All endpoints (except `/healthz` and `/auth/*`) require a bearer token — either a static API key or a session token obtained via OIDC.

### Endpoints

| Method      | Path                  | Description                                     |
| ----------- | --------------------- | ----------------------------------------------- |
| `GET`       | `/healthz`            | Health check                                    |
| `GET`       | `/auth/config`        | OIDC configuration for the frontend             |
| `POST`      | `/auth/session`       | Exchange an OIDC `id_token` for a session token |
| `POST`      | `/auth/refresh`       | Refresh a session token (3-day TTL)             |
| `GET`       | `/sse`                | Server-Sent Events stream of all activity       |
| `GET`       | `/messages`           | List all messages (last 24 hours)               |
| `GET`       | `/messages/:id`       | Get a single message                            |
| `DELETE`    | `/messages/:id`       | Delete a message                                |
| `POST`      | `/messages/:id/swipe` | Broadcast a swipe event for integrators         |
| `WebSocket` | `/ws`                 | Stream PCM audio for transcription              |

### SSE events

Connect to `/sse` to receive real-time events. Pass `?events=<type>` to filter, e.g. `?events=swiped` to receive only swipe events (the initial snapshot is skipped when a filter is active).

| Event type | Description                           |
| ---------- | ------------------------------------- |
| `snapshot` | Initial state — all current messages  |
| `created`  | A new recording session started       |
| `updated`  | Transcript updated (partial or final) |
| `deleted`  | A message was deleted                 |
| `swiped`   | A message was swiped right            |

### WebSocket protocol

Connect to `/ws?access_token=<token>`. Send raw PCM audio as binary frames (16 kHz, 16-bit signed, mono, little-endian). Send `{ "type": "stop" }` as a text frame to end the session gracefully.

### Authentication

Pass a token as:

- `Authorization: Bearer <token>` header, or
- `?access_token=<token>` query parameter
