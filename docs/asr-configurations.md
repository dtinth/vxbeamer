# Model configurations

The raw results behind the notes below are in the {doc}`vendor notes <asr-vendor-notes>`; `vxasr` is described on its own {doc}`page <vxasr>`.

A configuration is a provider, a model, and the post-processing chain applied to it. Post-processing is part of a configuration's identity rather than a request flag, so a model raw and the same model with Groq formatting are two separately selectable configurations that can be compared on equal terms:

| Configuration id                                   | Needs                                         |
| -------------------------------------------------- | --------------------------------------------- |
| `qwen/qwen3-asr-flash-realtime-2025-10-27`         | `DASHSCOPE_API_KEY`                           |
| `qwen/qwen3-asr-flash-realtime-2025-10-27+groq`    | `DASHSCOPE_API_KEY`, `GROQ_API_KEY`           |
| `qwen/qwen3-asr-flash-realtime-2026-02-10`         | `DASHSCOPE_API_KEY`                           |
| `qwen/qwen3-asr-flash-realtime-2026-02-10+groq`    | `DASHSCOPE_API_KEY`, `GROQ_API_KEY`           |
| `qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15` | `DASHSCOPE_API_KEY`                           |
| `qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15`  | `DASHSCOPE_API_KEY`                           |
| `qwen-omni/qwen3-omni-flash-realtime-2025-12-01`   | `DASHSCOPE_API_KEY`                           |
| `qwen-omni/qwen3.8-omni-flash-realtime`            | `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID` |
| `qwen-audio/qwen-audio-3.1-asr-flash-message`      | `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID` |
| `qwen-audio/qwen-audio-3.1-asr-flash-streaming`    | `DASHSCOPE_API_KEY`, `DASHSCOPE_WORKSPACE_ID` |
| `byteplus/bigmodel_nostream`                       | `BYTEPLUS_API_KEY`                            |
| `byteplus/bigmodel_nostream+groq`                  | `BYTEPLUS_API_KEY`, `GROQ_API_KEY`            |
| `openai/gpt-live-transcribe`                       | `OPENAI_API_KEY`                              |
| `xai/grok-voice-transcribe-2.0`                    | `XAI_API_KEY`                                 |
| `elevenlabs/scribe_v2_realtime`                    | `ELEVENLABS_API_KEY`                          |
| `iapp/chinda-asr-realtime-v1`                      | `IAPP_API_KEY`                                |
| `openrouter/microsoft/mai-transcribe-2`            | `OPENROUTER_API_KEY`                          |
| `openrouter/meta/muse-voice-transcribe-1.0`        | `OPENROUTER_API_KEY`                          |
| `openrouter/microsoft/mai-transcribe-1.5`          | `OPENROUTER_API_KEY`                          |
| `openrouter/google/gemini-3.5-transcribe`          | `OPENROUTER_API_KEY`                          |
| `paxa/paxa-stt-lite-v1-preview`                    | `PAXA_API_KEY`                                |
| `paxa/paxa-stt-lite-realtime-v1-preview`           | `PAXA_API_KEY`                                |
| `meta/muse-voice-transcribe-1.0`                   | `META_API_KEY`                                |
| `gemini/gemini-3.5-transcribe-live`                | `GEMINI_API_KEY`                              |
| `ai-gateway/microsoft/mai-transcribe-2-streaming`  | `AI_GATEWAY_API_KEY`                          |
| `mock/mock`                                        | nothing                                       |

Every Qwen model id is a dated snapshot, not a floating one — the vendor repoints undated ids without notice, which would make a vote name a moving target. The Qwen Omni models need no `+groq` variant: their output is already well-formatted (Thai words in Thai, product names in Latin), which is what Groq formatting was tidying up for the plain ASR models — running it on top of Omni's output measurably added nothing.

BytePlus exposes two modes at two endpoints, and only `bigmodel_nostream` accepts a language — the bi-directional `bigmodel` mode covers Mandarin, English and a few Chinese dialects and nothing else, so on any other language it returns confident nonsense. Only `bigmodel_nostream` is offered as a configuration for that reason; the provider still serves `bigmodel` for deployments in those languages. Set `BYTEPLUS_LANGUAGE` (e.g. `th-TH`) or BytePlus falls back to that same Chinese/English default set. Note that `bigmodel_nostream` returns results only after 15 s of audio or the final packet, so it emits few or no partials — it is accuracy-tuned rather than low-latency.

OpenRouter is a batch HTTP endpoint fanning out to many backing vendors under one key, not a live socket like every other provider here — the whole clip is sent as one file once recording stops, so it produces no partial transcript. Three models are declared, each tried live on the same fixture `testdata/OBSERVATIONS.md` uses. `microsoft/mai-transcribe-2` is the default: when the three were finally timed against each other rather than compared on transcript alone, it was the fastest and the cheapest, and its transcript matched the best of them. `meta/muse-voice-transcribe-1.0` held the default before that on transcript quality, and turned out to be four times slower than the others; `microsoft/mai-transcribe-1.5` was the original pick from a comparison of 19 models.

The `meta` provider speaks to that same `muse-voice-transcribe-1.0` model directly over Meta's own realtime WebSocket endpoint instead of through OpenRouter's batch wrapper, so it is the only configuration of this model that actually streams partial transcripts. Live-tried against the same fixture (`testdata/OBSERVATIONS.md`): the transcript came back slightly less accurate than the OpenRouter route for this same model on that one clip, and usage is billed in whole seconds rounded up rather than OpenRouter's fractional cost — a genuine tradeoff, not a strict upgrade, which is why both configurations are kept.

Paxa Labs is a batch endpoint too, but takes JSON with the audio base64-encoded rather than a multipart upload. It is the only model compared in `testdata/OBSERVATIONS.md` that needed no instruction to behave: no filler tags, no spaces inserted between Thai words, no English translated into Thai, and byte-identical output across repeated runs of every clip. It costs roughly four times `mai-transcribe-2` for near-identical speed, so it is offered alongside rather than as a default. `PAXA_CONVENTION=written` renders numbers as digits and uses the Thai repetition mark; the vendor's default spells them as spoken.

`paxa/paxa-stt-lite-realtime-v1-preview` is Paxa's realtime WebSocket. The vendor detects the end of speech, so the final transcript arrives about 55 ms after the recording ends. It costs 1.5 times the batch rate, and the whole connection is charged, including silence.

Gemini 3.5 Transcribe is offered two ways. Through OpenRouter it is a batch call: accurate and cheap, but 4–6 s per request whatever the clip length. The `gemini` provider uses the Live model instead, in push-to-talk mode with smart transcription (fillers and false starts removed): partial transcripts about every 0.5 s, and the final 0.3–0.6 s after the audio ends. A Live session can stream for 10 minutes at most. In tests on clips joined from separate recordings, push-to-talk with smart transcription sometimes dropped a later sentence; see `testdata/OBSERVATIONS.md`.

`ai-gateway/microsoft/mai-transcribe-2-streaming` is the streaming version of MAI-Transcribe-2, offered only through the Vercel AI Gateway, and reached with the AI SDK's `experimental_streamTranscribe`. Partial transcripts come about every 0.3 s, and the final 0.33–0.49 s after the audio ends. On clips with pauses between sentences it kept every sentence. It costs $0.54 per hour of audio.

Ids contain `+`, which decodes to a space in a query string, so clients must URL-encode them — `URLSearchParams` does this automatically. The OpenRouter configuration id also contains `/` (the router's own model naming, e.g. `microsoft/mai-transcribe-1.5`), which needs no special handling in a query string value.

By default a configuration is selectable once the environment carries every credential it needs — which means `mock/mock`, needing none, is always selectable. Set `ASR_CONFIGURATIONS` to pin the list down explicitly. Requests naming an unknown, unconfigured, or disabled configuration are closed with code `1008` before any message is created.

## Discovering them

`GET /asr/configurations` returns the selectable set, so a client does not have to hardcode the table above:

```json
{
  "primaryConfigurationId": "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15",
  "configurations": [
    {
      "id": "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15",
      "label": "Qwen3.5-Omni-Flash Realtime (2026-03-15, raw)",
      "providerId": "qwen-omni",
      "model": "qwen3.5-omni-flash-realtime-2026-03-15",
      "postProcessing": [],
      "configured": true
    }
  ]
}
```

Every listed `id` is one `/ws` accepts in `?configuration=`, which is what makes this list usable as a fan-out plan: an eval opens one socket per entry. `primaryConfigurationId` names the configuration the primary path uses; it is listed alongside the rest, since it competes on the same terms.

`configured` is almost always true — a configuration normally earns its place here by being credentialled. It is false only where an `ASR_CONFIGURATIONS` entry (or the default, which is always listed) was named without its credentials; such an entry is shown rather than hidden so the gap is visible, but connecting to it would close immediately. The response never carries credentials — not their values, and not the names of the missing variables either; the `/ws` close reason is where an operator reads which one to set.
