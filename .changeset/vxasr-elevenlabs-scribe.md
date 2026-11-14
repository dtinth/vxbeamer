---
"vxasr": minor
---

Add an `elevenlabs` provider for Scribe Realtime v2 (`scribe_v2_realtime`) over ElevenLabs' realtime speech-to-text WebSocket. It needs `ELEVENLABS_API_KEY` and is offered as `elevenlabs/scribe_v2_realtime`. It accepts audio faster than real time (a 9.2 s clip at once finishes in about 1.6 s), so it is declared fast-dump capable. A recording under the vendor's 0.3 s commit minimum is padded with silence rather than refused. Billed at $0.22 per hour of audio.
