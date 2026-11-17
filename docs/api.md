# API

The backend exposes a REST + SSE + WebSocket API on port 8787. All endpoints (except `/healthz` and `/auth/*`) require an access token, obtained by exchanging OIDC id_tokens or API keys.

## Endpoints

| Method      | Path                   | Description                                              |
| ----------- | ---------------------- | -------------------------------------------------------- |
| `GET`       | `/healthz`             | Health check                                             |
| `GET`       | `/auth/config`         | OIDC configuration for the frontend                      |
| `POST`      | `/auth/session`        | Exchange an OIDC `id_token` for access & refresh tokens  |
| `POST`      | `/auth/token`          | Exchange an API key for an access token (no refresh)     |
| `POST`      | `/auth/refresh`        | Exchange a refresh token for new access & refresh tokens |
| `GET`       | `/sse`                 | Server-Sent Events stream of all activity                |
| `GET`       | `/asr/configurations`  | List the selectable model configurations                 |
| `GET`       | `/messages`            | List all messages (last 24 hours)                        |
| `GET`       | `/messages/:id`        | Get a single message                                     |
| `DELETE`    | `/messages/:id`        | Delete a message                                         |
| `POST`      | `/messages/:id/swipe`  | Broadcast a swipe event for integrators                  |
| `POST`      | `/messages/:id/winner` | Replace the primary answer with an eval winner's         |
| `WebSocket` | `/ws`                  | Stream PCM audio for transcription                       |

`POST /messages/:id/winner` takes `{ configurationId, transcript }` and replies with `{ ok: true, upload }`. When eval storage is configured, `upload` carries presigned PUT URLs for this pick's vote and eval-set; it is `null` otherwise. Signing is offline, so the URLs come back with the winner rather than costing a second round-trip — and because the winner is applied before they are minted, storage being unavailable can never fail the pick.

## SSE events

Connect to `/sse` to receive real-time events. Pass `?events=<type>` to filter, e.g. `?events=swiped` to receive only swipe events (the initial snapshot is skipped when a filter is active).

| Event type | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `snapshot` | Initial state — all current messages                             |
| `created`  | A new recording session started                                  |
| `updated`  | Transcript updated (partial or final)                            |
| `deleted`  | A message was deleted                                            |
| `swiped`   | A message was swiped right (`eventId` is unique per swipe event) |

## WebSocket protocol

Connect to `/ws?access_token=<token>`. Send raw PCM audio as binary frames (16 kHz, 16-bit signed, mono, little-endian). Send `{ "type": "stop" }` as a text frame to end the session gracefully.

Optionally add `?configuration=<id>` to transcribe with a specific **model configuration** instead of the default one. Omit it and the session uses the configured default.

The model configurations a client can select are on the {doc}`asr-configurations` page. Tokens are explained on the {doc}`authentication` page.
