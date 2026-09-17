---
"vxasr": minor
---

Add a `meta` provider that speaks to Meta's realtime speech-to-text WebSocket endpoint directly, offering `muse-voice-transcribe-1.0` (the same model already available through the OpenRouter provider) with genuine streaming partial transcripts, which the OpenRouter route cannot provide since it is batch-only. Tried live against the same fixture as every other provider here: the transcript came back slightly less accurate than the OpenRouter route for this model, and usage is billed in whole seconds rounded up rather than OpenRouter's fractional cost — both configurations of this model are kept rather than one replacing the other.
