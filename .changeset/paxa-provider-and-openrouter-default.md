---
"vxasr": minor
---

Add a `paxa` provider for Paxa Labs' speech-to-text endpoint, and make `microsoft/mai-transcribe-2` the OpenRouter default in place of `meta/muse-voice-transcribe-1.0`.

The default changed because the three OpenRouter models had been compared on transcript quality but never timed. Measured head to head, `muse-voice-transcribe-1.0` is four times slower than the other two (3.9 s vs 0.95 s on a 13 s clip) and produced the worst transcript of the three; `mai-transcribe-2` is the fastest and cheapest, with an identical transcript. Every OpenRouter configuration now names its model explicitly, so reordering that list can no longer rename a configuration id.

Paxa is batch, like OpenRouter, but takes JSON with base64 audio. It is the only model in `testdata/OBSERVATIONS.md` that needed no instruction to avoid filler tags, Thai word-spacing and English-to-Thai translation, and it returned byte-identical output across repeated runs. At roughly four times `mai-transcribe-2`'s price for near-identical speed it is offered alongside rather than as a default.
