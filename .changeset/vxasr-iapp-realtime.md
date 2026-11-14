---
"vxasr": minor
---

Add an `iapp` provider for iApp's realtime speech-to-text (`chinda-asr-realtime-v1`, `wss://api.iapp.co.th/v3/store/speech/speech-to-text/realtime-v2`). It needs `IAPP_API_KEY` and is offered as `iapp/chinda-asr-realtime-v1`. Thai only: English words come back in Thai script. It accepts audio faster than real time (a 9.2 s clip at once finishes in about 1.7 s), so it is declared fast-dump capable; the vendor ends a session with `TOO_FAST` when more than 120 s of audio is waiting, so a long recording is sent 90 s at once and the rest at twice real time. Free during the vendor's launch, so the price defaults to zero. Also shares one `joinText` helper between the `xai`, `elevenlabs` and `iapp` providers.
