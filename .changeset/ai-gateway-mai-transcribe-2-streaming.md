---
"vxasr": minor
---

Add `ai-gateway/microsoft/mai-transcribe-2-streaming`, the streaming version of MAI-Transcribe-2, through a new `ai-gateway` provider for the Vercel AI Gateway (`AI_GATEWAY_API_KEY`).

The model is offered only through the gateway, and is reached with the AI SDK's `experimental_streamTranscribe`, so `vxasr` now depends on `ai` and `@ai-sdk/gateway`. Partials come about every 0.3 s and the final 0.33–0.49 s after the audio ends. On clips with pauses between sentences it kept every sentence, which Gemini's push-to-talk mode did not. It costs $0.54 an hour.
