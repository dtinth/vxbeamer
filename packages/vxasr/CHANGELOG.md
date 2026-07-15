# vxasr

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
