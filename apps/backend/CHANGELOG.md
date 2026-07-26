# backend

## 0.1.0-next.5

### Patch Changes

- 8048d13: Extract the shared streaming-WebSocket plumbing from the three providers

  Qwen, Qwen-Omni and BytePlus each carried ~35 lines of identical session
  plumbing — buffer/ready/finishing state, the chunk-flush loop, the
  pre-open-finish race, the error handler, and (since the connection-cleanup
  work) `close()` — and the three copies had already drifted (dtinth/vxbeamer#72).
  That plumbing now lives once in `createBufferedSocketSession`; each provider
  supplies only what is genuinely per-vendor: the handshake, frame encoding,
  turn-end, and message parsing. Byte accounting stays with the provider, so a
  token-billed vendor (Qwen-Omni) is never forced into the per-audio-second
  assumption the other two make.

  This also settles the `finish()` drift the duplication had produced: BytePlus
  guarded the turn-end with a socket-open check that Qwen and Qwen-Omni lacked, so
  finishing those two after a post-open socket error fired a spurious `onError`.
  The guard now lives in the shared helper and applies to all three.

  Alongside, three smaller copies collapse (no behaviour change):

  - `readAudioFrame` / `isStopMessage` — the binary-frame decode (including the
    `byteOffset`/`byteLength` care) and the `stop`-message parse shared by the
    recording and eval sockets. The decoder reaches nothing in the message log, so
    the eval socket's isolation from the store is preserved.
  - `buildBackendSocketUrl` — the `http(s)`→`ws(s)` URL build shared by the
    recording bar and the eval fan-out.
  - `concatChunks` — the retained-chunk flatten shared by the WAV writer and the
    eval frame re-cutter.

- 0431692: Reclaim upstream vendor connections: kick idle sockets and always tear down on error

  The realtime vendors cap concurrent connections per account ("connections too
  much max_connections 100"), and each `/ws` (and `/asr/eval`) socket holds one of
  those open for its whole life. Two gaps let those connections leak until the cap
  was hit:

  - **No way to hang up an abandoned session.** `ASRSession` only exposed
    `sendAudio()` and `finish()`, and `finish()` is _graceful_ — it waits for the
    vendor's terminal event, which never comes for a socket that has simply gone
    silent. `ASRSession.close()` is new: an immediate, idempotent teardown that
    `terminate()`s the vendor socket and emits no further callbacks, so a session
    that can no longer produce a transcript releases its slot rather than holding
    it until the vendor reaps it.

  - **Error paths left the socket open.** Every provider's `ws.on("error")` now
    closes the socket, and Qwen now hangs up on a vendor `error` frame the way
    BytePlus and Qwen-Omni already did — previously it did not, so a
    "max_connections" error frame itself leaked another connection, compounding the
    very condition it reported.

  Idle-kicking is now enforced at the socket layer: a watchdog, armed when the
  vendor session opens and deferred on every audio frame, closes the client and
  aborts the vendor session after `WS_IDLE_TIMEOUT_MS` of silence (default 60s; a
  non-positive value disables it). It watches _audio_, not liveness, so a client
  that keeps the socket open but stops speaking is still reclaimed. The watchdog is
  disarmed on `stop`, since finalisation is the vendor's clock, not the client's.

- Updated dependencies [8048d13]
- Updated dependencies [0431692]
  - vxasr@0.1.0-next.5

## 0.1.0-next.4

### Patch Changes

- vxasr@0.1.0-next.4

## 0.1.0-next.3

### Patch Changes

- Updated dependencies [2fd891a]
  - vxasr@0.1.0-next.3

## 0.1.0-next.2

### Minor Changes

- 9663f08: Make BytePlus able to transcribe the language it is actually spoken to.

  The adapter connected to `/api/v3/sauc/bigmodel`, the bi-directional streaming mode. That mode does not accept a `language` field — the vendor documents it as "only for streaming input mode `/api/v3/sauc/bigmodel_nostream`" — and with no language it covers Mandarin, English and a few Chinese dialects only. Thai was never reachable from it. It did not fail; it returned confident nonsense (`project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。`), which is the worst way to be wrong in an eval a human judges by reading.

  **The mode is modelled as a model.** BytePlus exposes each mode at its own endpoint path, so `byteplus/bigmodel_nostream` and `byteplus/bigmodel` are two entries in the provider's allowlist and two configuration ids. The two hear different languages from the same audio, which makes them different things to evaluate — and a vote has to be able to name which one it was for. `model_name` stays `bigmodel` on the wire for both: the vendor names the model that, and distinguishes the modes by path.

  **The language is configurable via `BYTEPLUS_LANGUAGE`** (e.g. `th-TH`), read in the provider's `resolveConfig` and sent in the `audio` object, not `request`. It is deliberately provider-specific rather than a shared `ASR_LANGUAGE`: the value space is the vendor's own, Qwen takes no language at all and auto-detects, and per-provider language configuration is still an open question on the eval map — a cross-provider variable would settle it for every vendor as a side effect of this fix. The language is sent only on modes that declare support for it, so `bigmodel` never receives a field the vendor rejects.

  **The `byteplus/bigmodel` configurations are retired.** A candidate that cannot be told the speaker's language is not a candidate, it is a wasted vendor call — and `bigmodel+groq` was worse, because the enhancement rewrote the nonsense into fluent prose that reads like a real answer. The provider still _serves_ `bigmodel`, so a Mandarin/English deployment can declare a configuration for it without touching the adapter; it is simply not offered by default.

  Note the trade: `bigmodel_nostream` returns results only after 15 s of audio or the final packet, so it emits few or no partials. It is accuracy-tuned rather than low-latency, which suits eval (only the final matters) better than the live primary path.

  Also fixes a hang: a clip that called `finish()` before the socket finished opening had its last packet dropped, so the turn never ended.

### Patch Changes

- Updated dependencies [9663f08]
- Updated dependencies [94e7feb]
- Updated dependencies [ac46ea8]
  - vxasr@0.1.0-next.2

## 0.1.0-next.1

### Minor Changes

- 32c5152: Add `GET /asr/configurations`, so a client can discover which model configurations it may transcribe with instead of hardcoding them — the list an eval fans out over.

  There is deliberately no separate eval-set setting. An eval opens one `/ws` per configuration, so an eval-only list could only ever be a subset of what `/ws` already accepts, and a second env var could only disagree with `ASR_CONFIGURATIONS` — advertising configurations the socket rejects, or hiding ones it serves. The selectable set already is the answer, and the endpoint reports exactly it.

  Each entry carries its id, a label, and its identity components (`providerId`, `model`, `postProcessing`), so a client never has to parse an id back apart — the id is derived from those, not the other way round. `primaryConfigurationId` is named once at the top rather than flagged per entry, and the primary appears in the list like any other candidate.

  Credentials never appear in the response: not their values, and not the names of missing env vars either. A token authenticates a subject, not an operator, so the server's environment is not described here; a `configured` boolean answers whether a configuration will work, and the `/ws` close reason still tells an operator which variable to set.

- e920490: Record every eval winner pick to S3-compatible object storage: a **vote** always, an **eval-set** when save-for-eval is ticked.

  The backend presigns; the browser uploads. `POST /messages/:id/winner` now returns `{ ok, upload }`, where `upload` carries presigned PUT URLs for this pick's vote and eval-set. The audio never passes through the backend — which is what keeps "the backend never stores recordings" structural rather than a rule to remember — and no bucket credential ever reaches a browser. Signing is offline HMAC, so the URLs ride along with the winner instead of costing a second round-trip, and the `configurationId` they are minted against is the one the winner endpoint already validated; a separate endpoint would have to re-validate it or mint URLs for ids the server does not serve.

  Storage cannot break a pick. The winner is applied and broadcast before a URL is minted, so a bucket that is down, misconfigured, or absent costs a vote and nothing else. `upload` is `null` when no bucket is configured; a pick the backend refuses uploads nothing at all.

  A **vote** (`{"type":"vote",…}`) fires on every pick and carries the winning configuration id, the full candidate list, per-candidate cost/latency/errors, and the audio's duration — but no audio and no transcripts, which is what makes it safe to store unconditionally. The ballot and the primary's id are what make the stream readable months later: without the candidate list a win is a count rather than a rate, and without the primary a favourite is indistinguishable from an incumbent. An **eval-set** (`{"type":"eval-set",…}`) is the vote plus the recording as a base64 WAV and every candidate's transcript, and is modelled as a superset so the two objects can never disagree about the same pick.

  Objects are keyed kind-first, then UTC date, then time and message id (`votes/2026/07/16/…-<messageId>.json`), so reading the vote stream never wades through megabytes of audio, and a pick's vote and eval-set share a suffix.

  `vxasr` gains `writeWav`, beside the `readPcm` that reads the same container: one spec, one set of constants, pinned to each other by a round-trip test — and the audio saved today is written by the same package that will re-run it against models later. It is exported as `vxasr/audio` so a browser can wrap PCM without pulling in the providers.

  Configured via `EVAL_STORAGE_BUCKET` (the switch), `EVAL_STORAGE_ACCESS_KEY_ID`/`EVAL_STORAGE_SECRET_ACCESS_KEY`, and optionally `EVAL_STORAGE_REGION`/`ENDPOINT`/`FORCE_PATH_STYLE`/`PREFIX`. A bucket named without credentials fails the boot rather than minting URLs that 403 in a browser where nobody is looking.

- 7173755: Add `POST /messages/:id/winner`: an eval winner's transcript replaces the message's primary answer.

  Eval runs create no message of their own, so there is nothing to merge or delete — picking a winner is an update to the existing message, broadcast over SSE exactly as the live transcription path broadcasts one. The webhook re-fires with the winner's transcript: downstream was already told the primary's answer when the recording finished, and this is the correction. The payload type was always `message.updated`, so a second update is precisely what it already says.

  Messages now carry a `configurationId` — the model configuration that authored the current answer, set from the recording's own configuration and overwritten by a winner. Without it a second `message.updated` is an unexplained transcript change.

  The winning configuration id is validated against the configurations this server serves; the transcript is not, and cannot be, since eval results are collected in the browser and the backend holds no recording to re-transcribe. The write is scoped to the caller's own message log, so an unverifiable transcript only ever edits the caller's own words. A message still recording is refused (the live session would clobber the winner); a message whose primary errored is accepted and promoted to done.

### Patch Changes

- cb94f9d: Add the Eval dialog: replay a recording against every configuration and pick a winner

  A finished message whose audio is still in memory now offers **Eval**. The dialog
  opens one WebSocket per configuration, replays the retained PCM through all of
  them in parallel, and streams each configuration's interim text as it arrives.
  The user reads the results and taps the one they like; it replaces the message's
  primary answer.

  - **`/asr/eval`** (backend) transcribes without a message log behind it. It is a
    separate route in its own module that cannot import the store, so "an eval run
    creates no message" (dtinth/vxbeamer#38) holds structurally rather than by a
    flag. Results come back down the socket, since the frontend is the only place
    an eval run exists.
  - **Replay is paced at 1x** — one 3200-byte frame per 100 ms, per socket, from
    that socket's own `ready`. Not an optimisation target: BytePlus hangs outright
    on a fast dump, and billing is per audio-second, so pacing is free. Because the
    sockets run in parallel, a run takes the clip's own duration however many
    configurations are on the ballot.
  - **Each configuration runs once.** No repeat runs, no averaging, no confidence
    indicators — the signal is the vote stream across many messages, not one eval.
  - Rows that will not stream (a buffering batch adapter) or cannot run (a
    configuration the server has no credentials for) are shown rather than hidden,
    and neither is dressed up as a fault.

- Updated dependencies [2681be3]
- Updated dependencies [e920490]
  - vxasr@0.1.0-next.1

## 0.1.0-next.0

### Patch Changes

- Updated dependencies [d9c4698]
  - vxasr@0.1.0-next.0

## 0.0.4

### Patch Changes

- vxasr@0.0.4

## 0.0.3

### Patch Changes

- vxasr@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [1e53385]
  - vxasr@0.0.2

## 0.0.1

### Patch Changes

- 28fe42e: Initialize changesets
- Updated dependencies [28fe42e]
  - vxasr@0.0.1
