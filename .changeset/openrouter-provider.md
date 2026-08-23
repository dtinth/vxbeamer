---
"vxasr": minor
---

Add an OpenRouter provider — a plain batch HTTP transcription call (`POST /v1/audio/transcriptions`), not a realtime protocol like every other provider here: the whole clip is buffered client-side and sent as one WAV file once `finish()` is called, with no partial output. `microsoft/mai-transcribe-1.5` is declared as a configuration preset (`openrouter/microsoft/mai-transcribe-1.5`), chosen after comparing it live against 18 sibling OpenRouter STT models on the fixture `testdata/OBSERVATIONS.md` uses.
