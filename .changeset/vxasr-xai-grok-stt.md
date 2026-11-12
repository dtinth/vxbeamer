---
"vxasr": minor
---

Add an `xai` provider for Grok Voice Transcribe 2.0 over xAI's streaming speech-to-text WebSocket. It needs `XAI_API_KEY` and is offered as `xai/grok-voice-transcribe-2.0`. Partials arrive about a second in. The vendor's `transcript.done` carries no text, so the final text is built from its utterance finals. Billed at $0.20 per hour of audio.
