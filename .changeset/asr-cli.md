---
"vxasr": minor
---

Add a `vxasr` CLI for running one model configuration against an audio file — no server, browser, or microphone needed.

Accepts WAV or headerless raw PCM (16 kHz/16-bit/mono), detecting WAV by content rather than file extension and walking its chunks rather than assuming a 44-byte header. Prints the transcript to stdout and per-layer usage costs to stderr, so a decorated chain shows what each layer charged. Configurations resolve through the catalogue, so every newly declared one becomes testable for free.

Audio is paced at realtime by default; `--fast` is a probe, since feeding faster than realtime does not reproduce live behaviour.

Also replaces the package README, which was still the unmodified Vite+ starter template.
