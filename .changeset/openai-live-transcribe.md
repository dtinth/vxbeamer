---
"vxasr": minor
---

Add OpenAI's `gpt-live-transcribe` (Realtime API) as an ASR provider — `openai` in the provider registry, raw-only for now (no `+groq` post-processing variant). Connects directly with the account's secret key rather than the ephemeral `client_secrets` token flow, since the backend is a trusted caller and the extra round trip would only add latency. Introduces `LinearResampler`, a reusable streaming resampler that carries state across chunks so it doesn't introduce a boundary artifact, used here to upsample the 16kHz capture to the API's 24kHz minimum.
