# vxasr

## 0.1.0-next.3

### Patch Changes

- 2fd891a: Remove a `latencyMs` field nothing produced, share `quoteId` between the provider registry and the configuration catalogue, and derive the frontend's audio constants from `vxasr/audio` rather than restating them.

## 0.1.0-next.2

### Minor Changes

- 9663f08: Make BytePlus able to transcribe the language it is actually spoken to.

  The adapter connected to `/api/v3/sauc/bigmodel`, the bi-directional streaming mode. That mode does not accept a `language` field — the vendor documents it as "only for streaming input mode `/api/v3/sauc/bigmodel_nostream`" — and with no language it covers Mandarin, English and a few Chinese dialects only. Thai was never reachable from it. It did not fail; it returned confident nonsense (`project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。`), which is the worst way to be wrong in an eval a human judges by reading.

  **The mode is modelled as a model.** BytePlus exposes each mode at its own endpoint path, so `byteplus/bigmodel_nostream` and `byteplus/bigmodel` are two entries in the provider's allowlist and two configuration ids. The two hear different languages from the same audio, which makes them different things to evaluate — and a vote has to be able to name which one it was for. `model_name` stays `bigmodel` on the wire for both: the vendor names the model that, and distinguishes the modes by path.

  **The language is configurable via `BYTEPLUS_LANGUAGE`** (e.g. `th-TH`), read in the provider's `resolveConfig` and sent in the `audio` object, not `request`. It is deliberately provider-specific rather than a shared `ASR_LANGUAGE`: the value space is the vendor's own, Qwen takes no language at all and auto-detects, and per-provider language configuration is still an open question on the eval map — a cross-provider variable would settle it for every vendor as a side effect of this fix. The language is sent only on modes that declare support for it, so `bigmodel` never receives a field the vendor rejects.

  **The `byteplus/bigmodel` configurations are retired.** A candidate that cannot be told the speaker's language is not a candidate, it is a wasted vendor call — and `bigmodel+groq` was worse, because the enhancement rewrote the nonsense into fluent prose that reads like a real answer. The provider still _serves_ `bigmodel`, so a Mandarin/English deployment can declare a configuration for it without touching the adapter; it is simply not offered by default.

  Note the trade: `bigmodel_nostream` returns results only after 15 s of audio or the final packet, so it emits few or no partials. It is accuracy-tuned rather than low-latency, which suits eval (only the final matters) better than the live primary path.

  Also fixes a hang: a clip that called `finish()` before the socket finished opening had its last packet dropped, so the turn never ended.

- 94e7feb: Pin every Qwen model to a dated snapshot and drop the floating `qwen3-asr-flash-realtime` id.

  Undated ids float — the vendor repoints them without notice — so a transcript could change with nothing in this repo changing, and a vote would name a moving target. Fun-ASR shows this is not theoretical: its newest snapshot dropped Thai outright, which a floating id would have delivered as a language quietly ceasing to work.

  Selectable configurations are now `qwen3-asr-flash-realtime-2025-10-27` and `-2026-02-10`, each raw and `+groq`. The primary derives to `2025-10-27+groq` — what the floating id resolved to when it was dropped — so behaviour is unchanged, only pinned.

  **Breaking for anyone setting `ASR_MODEL=qwen3-asr-flash-realtime`**: that id no longer exists; name a dated snapshot.

- ac46ea8: Add the Qwen Omni Realtime models as a `qwen-omni` provider, with three pinned configurations.

  These are not ASR models — they are omni-modal chat models that happen to hear, and they produce the best transcript measured on the Thai test fixture: Thai words in Thai and product names in Latin (`โปรเจกต์นี้เขียนด้วยภาษา TypeScript … ใช้เฟรมเวิร์กชื่อ Elysia`), a hybrid neither the ASR models nor BytePlus render.

  They speak their **own protocol**, not the Qwen ASR realtime one: the turn ends with `input_audio_buffer.commit` + `response.create`, the transcript arrives on `response.text.delta`/`.done`, and there is no `session.finish` — sending it is why the `qwen` provider times out against these models. That, plus token-based billing at per-model rates, is why this is a separate provider id rather than more models under `qwen`: one provider id means one wire protocol.

  Selectable configurations, **raw only** — these models already produce what the Groq enhancement is reaching for, so a `+groq` variant would spend an LLM call and a vote slot to change nothing:

  - `qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15` (the provider's default)
  - `qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15`
  - `qwen-omni/qwen3-omni-flash-realtime-2025-12-01`

  All three are pinned to dated snapshots from the vendor's model list, so the no-floating-ids rule needed no exemption. Credentials are the existing `DASHSCOPE_API_KEY`.

  Usage is reported in **tokens**, with audio input, text input and text output priced separately (the vendor charges different rates for audio and text input) at each model's own rates. Reporting measured tokens rather than estimating from duration is what makes it visible that `qwen3-omni-flash-realtime` costs ~58% more per recording than `qwen3.5-omni-flash-realtime` despite near-identical rates — the older generation tokenises the same audio far less efficiently.

## 0.1.0-next.1

### Minor Changes

- 2681be3: Add a `vxasr` CLI for running one model configuration against an audio file — no server, browser, or microphone needed.

  Accepts WAV or headerless raw PCM (16 kHz/16-bit/mono), detecting WAV by content rather than file extension and walking its chunks rather than assuming a 44-byte header. Prints the transcript to stdout and per-layer usage costs to stderr, so a decorated chain shows what each layer charged. Configurations resolve through the catalogue, so every newly declared one becomes testable for free.

  Audio is paced at realtime by default; `--fast` is a probe, since feeding faster than realtime does not reproduce live behaviour.

  Also replaces the package README, which was still the unmodified Vite+ starter template.

- e920490: Record every eval winner pick to S3-compatible object storage: a **vote** always, an **eval-set** when save-for-eval is ticked.

  The backend presigns; the browser uploads. `POST /messages/:id/winner` now returns `{ ok, upload }`, where `upload` carries presigned PUT URLs for this pick's vote and eval-set. The audio never passes through the backend — which is what keeps "the backend never stores recordings" structural rather than a rule to remember — and no bucket credential ever reaches a browser. Signing is offline HMAC, so the URLs ride along with the winner instead of costing a second round-trip, and the `configurationId` they are minted against is the one the winner endpoint already validated; a separate endpoint would have to re-validate it or mint URLs for ids the server does not serve.

  Storage cannot break a pick. The winner is applied and broadcast before a URL is minted, so a bucket that is down, misconfigured, or absent costs a vote and nothing else. `upload` is `null` when no bucket is configured; a pick the backend refuses uploads nothing at all.

  A **vote** (`{"type":"vote",…}`) fires on every pick and carries the winning configuration id, the full candidate list, per-candidate cost/latency/errors, and the audio's duration — but no audio and no transcripts, which is what makes it safe to store unconditionally. The ballot and the primary's id are what make the stream readable months later: without the candidate list a win is a count rather than a rate, and without the primary a favourite is indistinguishable from an incumbent. An **eval-set** (`{"type":"eval-set",…}`) is the vote plus the recording as a base64 WAV and every candidate's transcript, and is modelled as a superset so the two objects can never disagree about the same pick.

  Objects are keyed kind-first, then UTC date, then time and message id (`votes/2026/07/16/…-<messageId>.json`), so reading the vote stream never wades through megabytes of audio, and a pick's vote and eval-set share a suffix.

  `vxasr` gains `writeWav`, beside the `readPcm` that reads the same container: one spec, one set of constants, pinned to each other by a round-trip test — and the audio saved today is written by the same package that will re-run it against models later. It is exported as `vxasr/audio` so a browser can wrap PCM without pulling in the providers.

  Configured via `EVAL_STORAGE_BUCKET` (the switch), `EVAL_STORAGE_ACCESS_KEY_ID`/`EVAL_STORAGE_SECRET_ACCESS_KEY`, and optionally `EVAL_STORAGE_REGION`/`ENDPOINT`/`FORCE_PATH_STYLE`/`PREFIX`. A bucket named without credentials fails the boot rather than minting URLs that 403 in a browser where nobody is looking.

## 0.1.0-next.0

### Minor Changes

- d9c4698: Add a provider registry and a catalogue of **model configurations**.

  A provider maps an id to a factory building an `ASRProvider` from environment config plus a model name. Each provider declares its own config shape, so providers needing more than an API key (a region, IAM credentials, a pre-flight step) can join without reshaping the registry.

  A configuration pairs a provider and model with a post-processing chain, and is the unit users select and evaluate. Post-processing belongs to a configuration's identity rather than being a request-time flag, so `qwen/qwen3-asr-flash-realtime` and `qwen/qwen3-asr-flash-realtime+groq` are two distinct configurations that compete on equal terms. Ids are derived from the composition, so they cannot drift from their content.

  Exposes `createProviderRegistry`, `defineProvider`, `createDefaultProviderRegistry`, `createConfigurationCatalogue`, `defineDecorator`, `buildConfigurationId`, and `createDefaultConfigurationCatalogue`. This makes `createBytePlusProvider` reachable for the first time. `BytePlusProviderConfig` gains an optional `model` field, defaulting to the previously hardcoded `bigmodel`.

## 0.0.4

## 0.0.3

## 0.0.2

### Patch Changes

- 1e53385: Fix desktop release publishing so bundles from Linux, macOS, and Windows are all uploaded to the GitHub release.

## 0.0.1

### Patch Changes

- 28fe42e: Initialize changesets
