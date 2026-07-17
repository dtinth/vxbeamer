# website

## 0.1.0-next.4

### Patch Changes

- b89025e: Bake a flat charge tint into the message drag image: the dragged bubble now carries a solid wash of the charge sweep's lightest tint (rather than being plain), so it reads as gently charged. Flat, not the gradient — a still image can't sweep.
- 6fbe108: Give the message drag a custom drag image: a squared-off clone of the bubble without the charge sweep, so dragging a message out to another app shows a clean rectangle instead of the browser's default screenshot (which drags the rounded corners as opaque corners and freezes the sweep mid-fill). Verified on iPadOS Safari and Android Chrome.
  - vxasr@0.1.0-next.4

## 0.1.0-next.3

### Patch Changes

- 5a9d144: Add a drag-charge tint to message bubbles: while a finger holds a bubble waiting for the OS long-press lift, a soft primary-coloured tint sweeps left→right over ~700 ms so the wait is legible. On lift it rushes home and fades; on a swipe, scroll, or early release it reverses left and fades at once. Touch only.
- Updated dependencies [2fd891a]
  - vxasr@0.1.0-next.3

## 0.1.0-next.2

### Patch Changes

- Updated dependencies [9663f08]
- Updated dependencies [94e7feb]
- Updated dependencies [ac46ea8]
  - vxasr@0.1.0-next.2

## 0.1.0-next.1

### Minor Changes

- e920490: Record every eval winner pick to S3-compatible object storage: a **vote** always, an **eval-set** when save-for-eval is ticked.

  The backend presigns; the browser uploads. `POST /messages/:id/winner` now returns `{ ok, upload }`, where `upload` carries presigned PUT URLs for this pick's vote and eval-set. The audio never passes through the backend — which is what keeps "the backend never stores recordings" structural rather than a rule to remember — and no bucket credential ever reaches a browser. Signing is offline HMAC, so the URLs ride along with the winner instead of costing a second round-trip, and the `configurationId` they are minted against is the one the winner endpoint already validated; a separate endpoint would have to re-validate it or mint URLs for ids the server does not serve.

  Storage cannot break a pick. The winner is applied and broadcast before a URL is minted, so a bucket that is down, misconfigured, or absent costs a vote and nothing else. `upload` is `null` when no bucket is configured; a pick the backend refuses uploads nothing at all.

  A **vote** (`{"type":"vote",…}`) fires on every pick and carries the winning configuration id, the full candidate list, per-candidate cost/latency/errors, and the audio's duration — but no audio and no transcripts, which is what makes it safe to store unconditionally. The ballot and the primary's id are what make the stream readable months later: without the candidate list a win is a count rather than a rate, and without the primary a favourite is indistinguishable from an incumbent. An **eval-set** (`{"type":"eval-set",…}`) is the vote plus the recording as a base64 WAV and every candidate's transcript, and is modelled as a superset so the two objects can never disagree about the same pick.

  Objects are keyed kind-first, then UTC date, then time and message id (`votes/2026/07/16/…-<messageId>.json`), so reading the vote stream never wades through megabytes of audio, and a pick's vote and eval-set share a suffix.

  `vxasr` gains `writeWav`, beside the `readPcm` that reads the same container: one spec, one set of constants, pinned to each other by a round-trip test — and the audio saved today is written by the same package that will re-run it against models later. It is exported as `vxasr/audio` so a browser can wrap PCM without pulling in the providers.

  Configured via `EVAL_STORAGE_BUCKET` (the switch), `EVAL_STORAGE_ACCESS_KEY_ID`/`EVAL_STORAGE_SECRET_ACCESS_KEY`, and optionally `EVAL_STORAGE_REGION`/`ENDPOINT`/`FORCE_PATH_STYLE`/`PREFIX`. A bucket named without credentials fails the boot rather than minting URLs that 403 in a browser where nobody is looking.

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

- 7173755: Add `POST /messages/:id/winner`: an eval winner's transcript replaces the message's primary answer.

  Eval runs create no message of their own, so there is nothing to merge or delete — picking a winner is an update to the existing message, broadcast over SSE exactly as the live transcription path broadcasts one. The webhook re-fires with the winner's transcript: downstream was already told the primary's answer when the recording finished, and this is the correction. The payload type was always `message.updated`, so a second update is precisely what it already says.

  Messages now carry a `configurationId` — the model configuration that authored the current answer, set from the recording's own configuration and overwritten by a winner. Without it a second `message.updated` is an unexplained transcript change.

  The winning configuration id is validated against the configurations this server serves; the transcript is not, and cannot be, since eval results are collected in the browser and the backend holds no recording to re-transcribe. The write is scoped to the caller's own message log, so an unverifiable transcript only ever edits the caller's own words. A message still recording is refused (the live session would clobber the winner); a message whose primary errored is accepted and promoted to done.

- Updated dependencies [2681be3]
- Updated dependencies [e920490]
  - vxasr@0.1.0-next.1

## 0.1.0-next.0

## 0.0.4

### Patch Changes

- f2689c9: - Fix swipe gestures not working on newly created messages (stale closure bug)
  - Widen action areas from 96px to 120px for easier swiping
  - Beam action now triggers immediately on finger release instead of waiting for scroll-snap animation
  - Delete action now requires tapping the revealed red area instead of auto-deleting
  - Fix recording glow not following message bubble border radius

## 0.0.3

### Patch Changes

- 39578a8: - You can now drag a message bubble to another app to copy the text
  - Swiping on message bubbles now feels smoother and works more reliably on desktop

## 0.0.2

## 0.0.1

### Patch Changes

- 28fe42e: Initialize changesets
