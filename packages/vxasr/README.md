# vxasr

ASR client for [vxbeamer](https://github.com/dtinth/vxbeamer), a self-hosted personal speech transcriber.

Wraps several speech-recognition vendors behind one streaming interface, so they can be swapped and compared without the calling code knowing which is which.

## Concepts

**`ASRProvider`** — a vendor+model behind a streaming session: `createSession(callbacks)` returns something you feed `sendAudio(chunk)` and then `finish()`. Callbacks report `onPartial` / `onFinal` / `onUsage` / `onEnd` / `onError`.

**Model configuration** — a provider, a model, and its post-processing chain. This, not the provider, is the unit you select and compare: `qwen/qwen3-asr-flash-realtime` and `qwen/qwen3-asr-flash-realtime+groq` are two different things to evaluate, and they compete on equal terms.

**Audio format** — 16 kHz, 16-bit signed little-endian, mono. 32000 bytes per second. This is what the browser's AudioWorklet captures, so nothing needs resampling anywhere in the pipeline.

## The `vxasr` CLI

Runs one configuration against an audio file — no server, no browser, no microphone. This is the fastest way to check that a newly wired adapter actually works.

```bash
# What can I run, and do I have the credentials?
vxasr --list

# Transcribe a file (credentials come from the environment)
node --env-file=.env vxasr qwen/qwen3-asr-flash-realtime testdata/test-audio.bin
```

```
qwen/qwen3-asr-flash-realtime — 9.22s of audio (raw), realtime
project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway…

84 partials in 9.46s
  dashscope:qwen3-asr-flash:seconds: 10 × $0.000035 = $0.000350
  total: $0.000350
```

Accepts a WAV or headerless raw PCM. WAV is detected by content rather than file extension, and its header is stripped — but the audio inside must already be 16 kHz/16-bit/mono, since resampling it here would mean testing something other than what the app sends:

```bash
ffmpeg -i input.mp3 -ar 16000 -ac 1 -c:a pcm_s16le output.wav
```

The transcript goes to stdout and diagnostics to stderr, so it pipes cleanly. Exits non-zero when the configuration is unknown, lacks credentials, or errors.

### Replay audio at realtime

The CLI paces audio at 100 ms per chunk by default, as a live recording would. **`--fast` is a probe, not an optimisation.** Feeding audio faster than realtime does not reproduce live behaviour: BytePlus hangs outright and never returns a result, and vendors document a 100–200 ms send interval. Billing is per audio-second rather than per connection-second, so realtime pacing costs nothing extra.

### A note on comparing models

These models are LLMs with audio intake, so they are **not deterministic** — the same audio can transcribe differently across runs. A single run is one sample, not a measurement. Judge a model over many recordings rather than one.

## Development

```bash
vp install    # install dependencies
vp test       # run the unit tests
vp check      # format, lint, type check
vp pack       # build the library and CLI
```

Unit tests use the `mock` provider and never make network calls, so they need no credentials and cost nothing.
