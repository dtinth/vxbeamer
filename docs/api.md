# API

The backend exposes a REST + SSE + WebSocket API on port 8787 (`PORT`). All endpoints require an access token, obtained by exchanging OIDC id_tokens, API keys or a pairing code, except `/healthz`, `/auth/*` and the `/pair` page.

## Endpoints

| Method      | Path                   | Description                                                               |
| ----------- | ---------------------- | ------------------------------------------------------------------------- |
| `GET`       | `/healthz`             | Health check                                                              |
| `GET`       | `/auth/config`         | OIDC configuration for the frontend                                       |
| `POST`      | `/auth/session`        | Exchange an OIDC `id_token` for access & refresh tokens                   |
| `POST`      | `/auth/token`          | Exchange an API key for an access token (no refresh)                      |
| `POST`      | `/auth/refresh`        | Exchange a refresh token for new access & refresh tokens                  |
| `POST`      | `/auth/pair`           | Redeem a pairing code for a session (rate-limited)                        |
| `GET`       | `/pair`                | The pairing page: signs in with OIDC and shows a pairing link and QR code |
| `POST`      | `/pair/codes`          | Mint a one-time pairing code, link and QR code                            |
| `GET`       | `/sse`                 | Server-Sent Events stream of all activity                                 |
| `GET`       | `/asr/configurations`  | List the selectable model configurations                                  |
| `GET`       | `/messages`            | List all messages (last 24 hours)                                         |
| `GET`       | `/messages/:id`        | Get a single message                                                      |
| `DELETE`    | `/messages/:id`        | Delete a message                                                          |
| `POST`      | `/messages/:id/swipe`  | Broadcast a swipe event for integrators                                   |
| `POST`      | `/messages/:id/winner` | Replace the primary answer with an eval winner's                          |
| `WebSocket` | `/ws`                  | Stream PCM audio for transcription                                        |
| `WebSocket` | `/asr/eval`            | Transcribe without storing a message, for comparing configurations        |

`POST /pair/codes` returns `{ code, link, svg, expires_in }`. `POST /auth/pair` takes `{ code }` and answers 401 for an invalid or expired code and 429 when rate-limited; see {ref}`pairing-a-client`.

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

Two more optional query parameters: `reference_id`, an id of your choosing that is stored on the message as `referenceId`, and `client_id`, an id a client makes up for each launch, which lets a provider that supports it (currently `qwen-omni`) keep a vendor connection open between recordings from the same client. A socket that sends no audio for `WS_IDLE_TIMEOUT_MS` is closed with code `1008`.

The `/asr/eval` WebSocket takes the same audio frames and the same `access_token` and `configuration` parameters, but stores no message: the web app opens one per configuration to replay a recording through each when comparing models.

The model configurations a client can select are on the {doc}`asr-configurations` page. Tokens are explained on the {doc}`authentication` page.
