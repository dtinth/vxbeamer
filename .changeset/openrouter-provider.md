---
"vxasr": minor
---

Add OpenRouter as a new ASR provider. This provider works differently from every other provider here. It sends one plain HTTP request (`POST /v1/audio/transcriptions`) for each recording. It does not use a live connection. The app collects the whole audio clip, sends it as one WAV file when you call `finish()`, and then waits for one response. There is no partial text while it works.

The model `microsoft/mai-transcribe-1.5` is now a preset. Its configuration ID is `openrouter/microsoft/mai-transcribe-1.5`. This model was picked after a live comparison test against 18 other OpenRouter speech-to-text models. All tests used the same audio file already used in `testdata/OBSERVATIONS.md`.
