# website

## 0.2.0

### Patch Changes

- d901f2a: Auto-retry a failed recording connection. When the initial `/ws` connect fails or times out, the app now retries up to 3 times, one second apart, before showing the tap-to-retry error bubble. Most failures are a brief blip and now resolve on their own without interrupting the recording.
- Updated dependencies [a0c839e]
  - vxasr@0.2.0

## 0.1.0

### Minor Changes

- e920490: Save every eval winner pick to cloud storage. The app always saves a **vote**. It also saves an **eval-set** when you check "save for eval".

  The backend signs upload links. The browser uploads the file directly. The endpoint `POST /messages/:id/winner` now returns `{ ok, upload }`. The `upload` field holds signed upload links for this pick's vote and, if checked, its eval-set. The audio never passes through the backend server. This keeps the rule "the backend never stores recordings" true by design, not just by convention. No storage password ever reaches the browser. Signing happens offline, so creating the links adds no extra network delay. The links are created for the `configurationId` that the winner endpoint already checked. A separate endpoint would have to check it again, or it could create links for configurations the server does not serve.

  A storage failure cannot block a vote. The app applies and shares the winner pick first. It creates the upload link after. So, if storage is down, not set up, or missing, you only lose the eval-set upload — the vote itself is not affected. The `upload` field is `null` when no storage bucket is configured. If the backend refuses the upload, nothing is sent.

  A **vote** (`{"type":"vote",…}`) is created for every pick. It has the winning configuration's ID, the full list of options that were compared, each option's cost, response time, and any errors, plus the audio's length in time. It does not include the audio itself or any transcripts. This is what makes it safe to store without limits. The list of options and the ID of the original primary answer make the vote log useful to read later. Without the list of options, a win is just a count, not a rate. Without knowing the original primary answer, you cannot tell a new favorite from the old default. An **eval-set** (`{"type":"eval-set",…}`) has everything a vote has, plus the recording as a base64 WAV file, plus every option's transcript. An eval-set is built as a vote plus more data. This design means the two records can never disagree about the same pick.

  Files are named by type first, then by UTC date, then by time and message ID. For example: `votes/2026/07/16/…-<messageId>.json`. This way, reading the vote log never requires loading megabytes of audio data. A pick's vote file and eval-set file share the same file name ending.

  The `vxasr` package now has a `writeWav` function. It sits next to the existing `readPcm` function, which reads the same file format. This keeps one set of rules and one set of numbers for the format, checked by a test that writes a file and reads it back. This means the same code that saves today's audio will also be used to replay it against models later. This function is exported as `vxasr/audio`, so a browser can use it without loading the full provider code.

  Configure this feature with `EVAL_STORAGE_BUCKET` (this turns the feature on), `EVAL_STORAGE_ACCESS_KEY_ID`, `EVAL_STORAGE_SECRET_ACCESS_KEY`, and, if needed, `EVAL_STORAGE_REGION`, `ENDPOINT`, `FORCE_PATH_STYLE`, and `PREFIX`. If you set a bucket name but no credentials, the server fails to start. This is safer than creating upload links that fail in the browser, where no one would see the error.

### Patch Changes

- b89025e: Add a color tint to the message drag image. When you drag a message, the image now shows a solid light tint. Before, the image had no tint. The tint is flat, not a moving gradient, because a still image cannot show movement.
- 8048d13: Move shared code out of three ASR providers into one place.

  Qwen, Qwen-Omni, and BytePlus each had about 35 lines of the same code. This code managed the buffer state, the chunk-send loop, a timing issue at the start, the error handler, and the `close()` function. Over time, the three copies had started to differ from each other (see issue dtinth/vxbeamer#72).

  This code now lives in one function: `createBufferedSocketSession`. Each provider now supplies only its own vendor-specific parts: the handshake, the audio format, the turn-end signal, and the message parser. Each provider still counts its own bytes for billing. This matters because Qwen-Omni bills by token, not by audio time.

  This change also fixes a bug in `finish()`. BytePlus checked if the socket was open before it tried to end a turn. Qwen and Qwen-Omni did not have this check. So, if the socket had an error after it opened, and then you called `finish()`, Qwen and Qwen-Omni would report a false error. The check now lives in the shared function. It applies to all three providers.

  This change also merges three smaller pieces of duplicate code. There is no change in behavior.

  - `readAudioFrame` and `isStopMessage`: These functions decode binary audio frames and detect stop messages. The recording socket and the eval socket now share this code. The decoder does not touch the message log. This keeps the eval socket separate from the message store, as required.
  - `buildBackendSocketUrl`: This function builds a `ws` or `wss` URL from an `http` or `https` URL. The recording bar and the eval feature now share this code.
  - `concatChunks`: This function joins audio chunks into one buffer. The WAV writer and the eval frame splitter now share this code.

- e34184d: The tap-to-copy bounce animation on a message bubble now always plays. Before, it did not play when the device had "reduce motion" turned on.
- 5a9d144: Add a visual "charging" effect to message bubbles. While you hold a finger on a bubble, waiting for the OS to start a drag, a soft color tint sweeps from left to right. This takes about 700 ms. This shows that the app is registering your hold. When you lift your finger to start the drag, the tint quickly fills in and then fades. If you swipe, scroll, or release early, the tint reverses and fades right away. This effect works on touch screens only.
- 6fbe108: Give the message drag a custom image. Before, dragging a message bubble out to another app used the browser's default screenshot. This default image showed the bubble's round corners as solid squares. It also froze the color-sweep effect partway through. Now, the drag shows a clean rectangle copy of the bubble, without the color-sweep effect. Tested on iPadOS Safari and Android Chrome.
- cb94f9d: Add the Eval dialog. It replays a recording through every model configuration. You then pick the best result.

  If a finished message still has its audio in memory, the app now shows an **Eval** option. The dialog opens one WebSocket connection for each configuration. It replays the saved audio through all of them at the same time. It shows each configuration's text as it arrives. You read the results and tap the one you prefer. That result then replaces the message's main answer.

  - **`/asr/eval`** (on the backend) transcribes audio without writing to the message log. This is a separate route, in its own code module. This module cannot import the message store. This design guarantees that an eval run creates no message (see issue dtinth/vxbeamer#38). This is a structural rule, not just a setting. Results return down the same socket, since only the frontend needs an eval run's results.
  - **Each replay runs at 1x speed.** The app sends one 3200-byte audio frame every 100 ms, per socket, once that socket is ready. This is not something to speed up: BytePlus stops responding if you send audio faster than real time. Also, billing is based on audio duration, not connection time, so slower sending costs nothing extra. Because all sockets run at the same time, one eval run takes about as long as the audio clip itself, no matter how many configurations you compare.
  - **Each configuration runs only once** per eval. There are no repeat runs, no averaging, and no confidence scores. The real signal comes from votes across many messages over time, not from one eval run.
  - Some rows will not show live text (a model that returns one final result). Other rows cannot run at all (the server has no credentials for that configuration). The app shows both of these cases plainly. It does not treat them as errors.

- c04dd8a: Speed up the eval dialog. Each model configuration's audio now replays at a speed confirmed to work for its own vendor, instead of one shared real-time speed. Every provider in the current list (Qwen ASR, Qwen Omni, BytePlus) was tested. Each one accepts the whole audio clip sent all at once. So, an eval now finishes in about 1 to 2 seconds. Before, it took as long as the audio clip itself. A provider that has not been tested this way still uses the slower, real-time speed by default.
- 5855bcf: Export "fast dump" support as real data: `ProviderSpec.supportsFastDump`, and the matching fields on `ProviderDefinition` and `ConfigurationDefinition`. The backend's `GET /asr/configurations` endpoint now includes this data too. "Fast dump" means the provider accepts a whole audio clip sent all at once, not paced over time.

  Before, this data only existed as a fixed list, `FAST_DUMP_PROVIDERS`, inside the website's eval-replay code. So, any other program using the `vxasr` package had no way to know which providers support fast dump. It would have had to guess, or copy that same list. Now, the website's eval dialog reads this data from the server. It no longer keeps its own copy of the list.

- 7173755: Add a new endpoint: `POST /messages/:id/winner`. This endpoint lets an eval winner's transcript replace the message's main answer.

  An eval run creates no message of its own. So, picking a winner just updates the existing message. The app shares this update over SSE, the same way it shares a live transcription update. The webhook fires again too, this time with the winner's transcript. The system already told other services the primary answer when the recording finished. This second webhook call is the correction. The payload type was already `message.updated` for the first call, so a second update uses that same, correct type.

  Messages now have a `configurationId` field. This field names the model configuration that wrote the current answer. The recording sets it at first. Picking a winner then overwrites it. Without this field, a second `message.updated` event would be an unexplained change to the transcript.

  The server checks that the winning configuration ID is one it actually serves. The server does not check the transcript text itself, and it cannot: the eval results come from the browser, and the backend keeps no copy of the recording to check against. This write only affects the caller's own message log. So, even though the transcript is not checked, it can only ever change the caller's own messages. The server refuses this request if the message is still recording — a live session could otherwise overwrite the winner. The server accepts this request if the message's primary answer had failed. In that case, the message becomes "done".

- 1bd504c: Let a `qwen-omni` vendor connection stay open for reuse by the same client. Before, the app always closed the connection after each turn. Now, if the same client starts a new, short recording soon after, it can reuse the same connection. This lets the model keep its earlier conversation context.

  This feature is opt-in. It uses a new `clientId` field on `ASRCreateSessionOptions`. Every other provider ignores this field — for them, nothing changes. The website sends one client ID for each page load. It does not save this ID, so reloading the page always starts fresh. The backend combines this ID with your login, so two different accounts can never share the same open connection.

  The app closes an idle connection, instead of keeping it open, once one of two limits is reached: the connection has been idle longer than `QWEN_OMNI_STICKY_LINGER_MS` (30 seconds by default), or the total audio sent on it has passed `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (180 seconds by default). This second limit keeps token cost and conversation size from growing without a limit.

- 02be1ab: When you tap the retry button on an error bubble, it now shows a "Retrying…" state right away. Before, the button showed no change until the retry attempt finished.
- 02be1ab: Fix the retry button. Before, if a connection had failed a while ago, tapping retry did nothing. This happened because retry reused the login token from the first connection attempt. If that token had since expired, the backend's `/ws` connection step rejected it right away. This looked like the retry button did nothing at all. Now, retry always fetches a fresh login token before it reconnects. This matches how every other login-based request already works.
- e5959bd: Add more settings. The settings sheet now scrolls, to fit them. New settings:

  - "Transcript history": show every transcript, or keep only the latest 10. When you turn on this limit, the app waits for the current scroll to finish before it removes old bubbles. This stops a bubble from disappearing mid-animation.
  - "Recording button" size: choose default, small, or hidden.
  - "Refresh app" button: reloads the page.

- 1920562: Reduce the recording bar's top and bottom padding when you set the recording button to "small". This gives the transcript feed more room on screen.
- 02be1ab: Add a hidden test-audio mode. Set `localStorage.vxbeamer_test_audio_url` to turn it on. When on, the record button replays a saved audio clip, at the same pace as a live recording, instead of using the microphone. This helps you test the record flow on a device with no real microphone, such as an automated browser test.

  This change also fixes a bug. Before, the `audioProcessingMode` setting — which controls noise suppression, echo cancellation, and auto gain — was silently never applied to real microphone recordings.

- Updated dependencies [2681be3]
- Updated dependencies [8048d13]
- Updated dependencies [9663f08]
- Updated dependencies [e920490]
- Updated dependencies [5855bcf]
- Updated dependencies [02be1ab]
- Updated dependencies [3d6323d]
- Updated dependencies [94e7feb]
- Updated dependencies [ac46ea8]
- Updated dependencies [1bd504c]
- Updated dependencies [2fd891a]
- Updated dependencies [d9c4698]
- Updated dependencies [0431692]
  - vxasr@0.1.0

## 0.1.0-next.9

### Patch Changes

- e34184d: Always play the tap-to-copy bounce on a message bubble, even when the OS is set to reduce motion.
- Updated dependencies [3d6323d]
  - vxasr@0.1.0-next.9

## 0.1.0-next.8

### Patch Changes

- 1bd504c: Let a `qwen-omni` vendor connection linger for reuse by the same client instead of always closing when a turn ends, so consecutive short recordings from one client can share the vendor's conversation context. Opt-in via a new `clientId` on `ASRCreateSessionOptions` — every other provider ignores it, unchanged. The website sends one client id per page load (not persisted, so a refresh always starts clean); the backend scopes it to the authenticated subject so two accounts never share a pooled connection. A lingering connection is retired instead of reused once it sits idle past `QWEN_OMNI_STICKY_LINGER_MS` (default 30s) or its accumulated input audio crosses `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (default 180s, bounding token cost and context growth).
- Updated dependencies [1bd504c]
  - vxasr@0.1.0-next.8

## 0.1.0-next.7

### Patch Changes

- 5855bcf: Export per-provider "fast dump" support as real metadata: `ProviderSpec.supportsFastDump` (and its type-erased `ProviderDefinition`/`ConfigurationDefinition` counterparts), carried through the backend's `GET /asr/configurations` response. Previously this lived only as a hardcoded `FAST_DUMP_PROVIDERS` set in the website's eval-replay pacing logic, so an external consumer of `vxasr` had no way to know which providers tolerate a fast dump without re-deriving or copying that list. The website's eval dialog now reads the flag from the server instead of keeping its own copy.
- Updated dependencies [5855bcf]
  - vxasr@0.1.0-next.7

## 0.1.0-next.6

### Patch Changes

- 02be1ab: Show a "Retrying…" state on the error bubble immediately when the retry button is tapped, instead of leaving it looking untouched until the reconnect attempt settles.
- 02be1ab: Fix retry doing nothing on a connection that failed a while ago: it was reusing the access token captured at the original connect attempt, which the backend's `/ws` upgrade rejects outright once expired — reading as a silent no-op rather than a real retry. A retry now fetches a fresh token before reconnecting, the same as every other authenticated call.
- 02be1ab: Add a hidden test-audio mode: setting `localStorage.vxbeamer_test_audio_url` makes the record button replay a pre-recorded PCM clip, paced like a live capture, instead of opening the microphone — for exercising the record flow in environments with no mic (e.g. a headless browser). Also fixes a pre-existing bug where `audioProcessingMode` (noise suppression / echo cancellation / auto gain) was silently never applied to real microphone recordings.
- Updated dependencies [02be1ab]
  - vxasr@0.1.0-next.6

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

- c04dd8a: Speed up the eval dialog by pacing each configuration's audio replay at its own provider's confirmed rate instead of one shared realtime rate. Every provider currently in the catalogue (Qwen ASR, Qwen Omni, BytePlus) was fast-dump tested and tolerates the whole clip sent back-to-back, so an eval now finishes in ~1-2s instead of waiting out the clip's full length. An untested provider still defaults to realtime pacing.
- e5959bd: Add more settings and make the settings sheet scrollable: a "Transcript history" option to show all transcripts or trim the feed to the latest 10 (waiting for the auto-scroll to settle before pruning old bubbles so nothing pops out mid-animation), a "Recording button" size option (default / small / hidden), and a "Refresh app" button that reloads the page.
- 1920562: Tighten the recording bar's vertical padding when the recording button is set to small, so the bar takes less vertical space and leaves more room for the transcript feed.
- Updated dependencies [8048d13]
- Updated dependencies [0431692]
  - vxasr@0.1.0-next.5

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
