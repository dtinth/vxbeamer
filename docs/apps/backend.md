# Backend

The backend (`apps/backend`) is a Node.js server built with Hono. It receives PCM audio over a WebSocket, runs it through one or more ASR configurations with {doc}`vxasr <../vxasr>`, streams the transcripts to clients over SSE, and exposes the REST API described in {doc}`../api`.

It is distributed as a Docker image, `ghcr.io/dtinth/vxbeamer`; see {doc}`../getting-started` for a compose file and {doc}`../configuration` for the environment variables.

## Development

From the repository root:

```bash
vp install
vp run dev:backend
```

The server needs `DASHSCOPE_API_KEY` for the default provider (or `ASR_PROVIDER=mock`, which needs no key) and, to sign clients in, an OIDC provider or `API_KEYS`; see {doc}`../configuration`. Note that `OIDC_SECRET` falls back to `local-dev-secret`, which is only fit for local development. Run the {doc}`website <website>` alongside it and pair it with the backend, as described in {ref}`pairing-a-client`.
