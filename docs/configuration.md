# Configuration

The backend is configured with environment variables.

| Variable                             | Required         | Description                                                                                                                                                                                           |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DASHSCOPE_API_KEY`                  | Default provider | Alibaba Cloud DashScope key for Qwen3-ASR-Flash, Qwen Omni Realtime and Qwen-Audio ASR. The default provider is `qwen`, so it is needed unless `ASR_PROVIDER` names another one (`mock` needs no key) |
| `DASHSCOPE_WORKSPACE_ID`             | No               | Model Studio workspace id. Needed only by `qwen-omni/qwen3.8-omni-flash-realtime` and the `qwen-audio/*` models, which are served from `<id>.ap-southeast-1.maas.aliyuncs.com`                        |
| `API_KEYS`                           | No               | Comma-separated `sub:secret` pairs for API key exchange                                                                                                                                               |
| `GROQ_API_KEY`                       | No               | Groq API key for gpt-oss-120b post-processing; enables the `+groq` configurations                                                                                                                     |
| `ASR_CONFIGURATION`                  | No               | Default configuration id (default: derived from `ASR_PROVIDER`/`ASR_MODEL`/`GROQ_API_KEY`)                                                                                                            |
| `ASR_CONFIGURATIONS`                 | No               | Comma-separated configurations clients may select (default: every configuration with credentials)                                                                                                     |
| `ASR_PROVIDER`                       | No               | Provider for the derived default: `qwen` (default), `qwen-omni`, `qwen-audio`, `byteplus`, `openai`, `xai`, `elevenlabs`, `iapp`, `openrouter`, `meta`, `paxa`, `gemini`, `ai-gateway`, or `mock`     |
| `ASR_MODEL`                          | No               | Model for the derived default (default: the provider's own default model)                                                                                                                             |
| `BYTEPLUS_API_KEY`                   | No               | BytePlus key; enables the `byteplus` configurations                                                                                                                                                   |
| `BYTEPLUS_LANGUAGE`                  | No               | BytePlus language hint, e.g. `th-TH` (default: unset — Mandarin/English only)                                                                                                                         |
| `BYTEPLUS_RESOURCE_ID`               | No               | BytePlus resource id (default: `volc.seedasr.sauc.duration`)                                                                                                                                          |
| `BYTEPLUS_BASE_URL`                  | No               | BytePlus endpoint base, without the mode path segment                                                                                                                                                 |
| `OPENAI_API_KEY`                     | No               | OpenAI key; enables the `openai` (`gpt-live-transcribe`) configuration                                                                                                                                |
| `XAI_API_KEY`                        | No               | xAI key; enables the `xai` (`grok-voice-transcribe-2.0`, streaming) configuration                                                                                                                     |
| `ELEVENLABS_API_KEY`                 | No               | ElevenLabs key; enables the `elevenlabs` (`scribe_v2_realtime`) configuration                                                                                                                         |
| `IAPP_API_KEY`                       | No               | iApp key; enables the `iapp` (`chinda-asr-realtime-v1`, streaming, Thai only) configuration                                                                                                           |
| `OPENROUTER_API_KEY`                 | No               | OpenRouter key; enables the `openrouter` configurations (`microsoft/mai-transcribe-2`, `meta/muse-voice-transcribe-1.0`, `microsoft/mai-transcribe-1.5`, `google/gemini-3.5-transcribe`)              |
| `META_API_KEY`                       | No               | Meta key; enables the `meta` (`muse-voice-transcribe-1.0`, direct realtime API) configuration                                                                                                         |
| `PAXA_API_KEY`                       | No               | Paxa Labs key; enables the `paxa` configurations (batch and realtime)                                                                                                                                 |
| `PAXA_CONVENTION`                    | No               | `written` to render numbers as digits and use the Thai repetition mark (default: the vendor's `spoken`)                                                                                               |
| `GEMINI_API_KEY`                     | No               | Google Gemini API key; enables the `gemini` (`gemini-3.5-transcribe-live`) configuration                                                                                                              |
| `AI_GATEWAY_API_KEY`                 | No               | Vercel AI Gateway key; enables the `ai-gateway` (`microsoft/mai-transcribe-2-streaming`) configuration                                                                                                |
| `OIDC_DISCOVERY_URL`                 | No               | OIDC provider discovery URL (alternative to API keys)                                                                                                                                                 |
| `OIDC_CLIENT_ID`                     | No               | OIDC client ID (default: `vxbeamer-mobile`)                                                                                                                                                           |
| `OIDC_AUDIENCE`                      | No               | Expected token audience (default: same as client ID)                                                                                                                                                  |
| `OIDC_SECRET`                        | No               | HMAC secret for session tokens (default: `local-dev-secret`)                                                                                                                                          |
| `PUBLIC_URL`                         | No               | Address clients should use for pairing links (default: the address the request came in on)                                                                                                            |
| `WEBHOOK_URL`                        | No               | Endpoint to POST completed transcriptions to                                                                                                                                                          |
| `PORT`                               | No               | HTTP port (default: `8787`)                                                                                                                                                                           |
| `WS_IDLE_TIMEOUT_MS`                 | No               | How long a recording socket may go without audio before it is closed and its vendor connection released (default: `60000`; `0` disables)                                                              |
| `QWEN_OMNI_STICKY_LINGER_MS`         | No               | How long an unused Qwen Omni connection is kept open after a recording, for the next one from the same client (default: `30000`)                                                                      |
| `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` | No               | Audio a kept Qwen Omni connection may carry across recordings before it is retired (default: `180`)                                                                                                   |

## Eval storage

Where eval **votes** and **eval-sets** are saved. The backend only signs upload URLs; the browser uploads directly to the bucket, so recordings never pass through the server and no bucket credential ever reaches a browser. Setting `EVAL_STORAGE_BUCKET` turns the feature on; without it, evals still run and winners still apply, they are just not recorded.

| Variable                         | Required    | Description                                                           |
| -------------------------------- | ----------- | --------------------------------------------------------------------- |
| `EVAL_STORAGE_BUCKET`            | No          | S3-compatible bucket for votes and eval-sets. Enables eval storage    |
| `EVAL_STORAGE_ACCESS_KEY_ID`     | With bucket | Access key id used to sign upload URLs                                |
| `EVAL_STORAGE_SECRET_ACCESS_KEY` | With bucket | Secret access key used to sign upload URLs                            |
| `EVAL_STORAGE_REGION`            | No          | Bucket region (default: `us-east-1`)                                  |
| `EVAL_STORAGE_ENDPOINT`          | No          | Custom S3-compatible endpoint, e.g. MinIO or R2 (default: AWS)        |
| `EVAL_STORAGE_FORCE_PATH_STYLE`  | No          | Set to `true` for endpoints needing path-style addressing, e.g. MinIO |
| `EVAL_STORAGE_PREFIX`            | No          | Key prefix placed before `votes/` and `eval-sets/`                    |

Objects are keyed by kind, then UTC date, then time and message id:

```
votes/2026/07/16/2026-07-16T09-30-00-123Z-<messageId>.json
eval-sets/2026/07/16/2026-07-16T09-30-00-123Z-<messageId>.json
```

A **vote** (`{"type":"vote",…}`) is written on every winner pick and carries the winning configuration id, the full candidate list, per-candidate cost/latency/errors, and the audio's duration — but **no audio and no transcripts**, so it is safe to store unconditionally. An **eval-set** (`{"type":"eval-set",…}`) is written only when the user ticks save-for-eval, and adds the recording as a base64 WAV plus every candidate's transcript. A pick's vote and eval-set share a key suffix, so one finds the other.
