# Test audio fixture

`test-audio.bin` — **raw PCM, 16 kHz / 16-bit / mono, little-endian**. No header.

This is the exact format the app's AudioWorklet captures and the format every
`ASRProvider` expects, so it can be fed to `sendAudio()` without conversion.

- 294,986 bytes = 9.218 s (bytes / 32000 = seconds)
- Thai speech with English technical loanwords ("TypeScript", "Elysia", "Railway",
  "MongoDB Atlas") — the loanwords make it a useful discriminator between models.

Used by the provider-testing CLI (#44).

## Replay pacing matters — see #38

Feeding this faster than 1x does **not** reproduce live behaviour. Qwen returns a
_different transcript_ under a fast dump, and BytePlus hangs entirely. Replay at
realtime (100 ms per 3200-byte chunk). Do not "optimise" tests by dumping.
