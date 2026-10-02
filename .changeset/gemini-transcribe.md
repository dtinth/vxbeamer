---
"vxasr": minor
---

Add Gemini 3.5 Transcribe two ways: `gemini/gemini-3.5-transcribe-live`, a new `gemini` provider for the Gemini Live API, and `openrouter/google/gemini-3.5-transcribe`, a batch configuration of the existing OpenRouter provider.

The Live model runs in push-to-talk mode with smart transcription (fillers and false starts removed). Partials come about every 0.5 s and the final 0.3–0.6 s after the recording ends. In tests on clips joined from separate recordings, push-to-talk with smart transcription sometimes dropped a later sentence; it was chosen anyway, to revisit if that shows up in real use. Through OpenRouter the same model is accurate and costs $0.18 an hour, but takes 4–6 s per request.
