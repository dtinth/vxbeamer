---
"vxasr": minor
---

Add OpenAI's `gpt-live-transcribe` model as a new ASR provider. This is the `openai` entry in the provider list. For now, it only supports raw output — it has no `+groq` cleanup option. The connection uses the account's own secret key directly. It does not use the short-lived `client_secrets` method. The backend is a trusted caller, so the extra network round trip would only add delay.

This change also adds `LinearResampler`. This is a reusable tool that resamples streaming audio. It keeps state across audio chunks, so it does not create a glitch where one chunk ends and the next begins. It is used here to convert the app's 16 kHz audio up to the 24 kHz that this API requires.
