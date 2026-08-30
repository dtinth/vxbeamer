# backend

## 0.1.0

### Minor Changes

- 9663f08: Fix BytePlus. It can now transcribe the language the speaker actually uses.

  The adapter connected to `/api/v3/sauc/bigmodel`. This is the two-way streaming mode. This mode does not accept a `language` field. The vendor's documentation says the `language` field works only with `/api/v3/sauc/bigmodel_nostream`. Without a language field, this mode only covers Mandarin, English, and a few Chinese dialects. It could not hear Thai. It did not fail with an error. Instead, it returned confident but wrong text, such as: `project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。` This is the worst kind of error. A human judge may believe it is correct.

  **Each mode is now a separate model.** BytePlus serves each mode at its own address. So, `byteplus/bigmodel_nostream` and `byteplus/bigmodel` are now two separate items in the list. They are two separate configuration IDs. The two modes hear different languages from the same audio. So, they must be evaluated as different things. A vote must say which mode it is for. On the wire, both modes still send `model_name: bigmodel`. The vendor uses one model name for both. The two modes differ only by their address path.

  **You can now set the language with `BYTEPLUS_LANGUAGE`** (for example, `th-TH`). The provider reads this setting and sends it in the `audio` object, not the `request` object. This setting is specific to BytePlus. It is not a shared `ASR_LANGUAGE` setting for all providers. Each vendor uses its own language codes. Qwen, for example, takes no language setting at all — it detects the language automatically. A shared setting could also affect other providers in ways we have not yet decided. The language setting is sent only to modes that support it. The `bigmodel` mode never receives a field that the vendor would reject.

  **The `byteplus/bigmodel` configurations are removed from the default list.** A model that cannot be told the speaker's language wastes a vendor call. It is not a fair choice to evaluate. The `bigmodel+groq` combination was even worse. The Groq step rewrote the wrong text into text that reads like a correct answer. The provider still supports `bigmodel`. A deployment that mainly serves Mandarin or English speakers can still add it as a configuration. It is just not offered by default.

  Note a trade-off: `bigmodel_nostream` only returns results after 15 seconds of audio, or after the final audio packet. So, it sends few or no partial results while recording. It favors accuracy over speed. This fits the eval feature well, since only the final result matters there. It fits the live recording feature less well.

  This change also fixes a hang. Before, if you called `finish()` before the socket finished opening, the app dropped the last audio packet. The turn never ended.

- 32c5152: Add a new endpoint: `GET /asr/configurations`. A client can call this endpoint to find out which model configurations it may use. Before, a client had to hardcode this list.

  There is no separate setting for the eval list. An eval opens one `/ws` connection per configuration. So, an eval-only list could only ever be a smaller version of what `/ws` already accepts. A second setting could disagree with the `ASR_CONFIGURATIONS` setting. It could advertise configurations that the `/ws` socket then rejects. Or, it could hide configurations that the socket does serve. The list of allowed configurations is already the right answer. This endpoint reports that same list.

  Each entry has an ID, a label, and its identity parts: `providerId`, `model`, and `postProcessing`. A client never needs to take an ID apart to find these parts. The ID is built from these parts, not the other way around. The field `primaryConfigurationId` names the primary configuration once, at the top level. The primary configuration also appears in the list, like every other configuration.

  The response never includes credentials. It does not include credential values. It also does not include the names of missing setting variables. A login token identifies a user, not a server operator. So, this endpoint does not describe the server's setup. A `configured` field on each entry tells the client if that configuration will work. If a socket connection is refused, its close reason still tells the operator which setting to fix.

- e920490: Save every eval winner pick to cloud storage. The app always saves a **vote**. It also saves an **eval-set** when you check "save for eval".

  The backend signs upload links. The browser uploads the file directly. The endpoint `POST /messages/:id/winner` now returns `{ ok, upload }`. The `upload` field holds signed upload links for this pick's vote and, if checked, its eval-set. The audio never passes through the backend server. This keeps the rule "the backend never stores recordings" true by design, not just by convention. No storage password ever reaches the browser. Signing happens offline, so creating the links adds no extra network delay. The links are created for the `configurationId` that the winner endpoint already checked. A separate endpoint would have to check it again, or it could create links for configurations the server does not serve.

  A storage failure cannot block a vote. The app applies and shares the winner pick first. It creates the upload link after. So, if storage is down, not set up, or missing, you only lose the eval-set upload — the vote itself is not affected. The `upload` field is `null` when no storage bucket is configured. If the backend refuses the upload, nothing is sent.

  A **vote** (`{"type":"vote",…}`) is created for every pick. It has the winning configuration's ID, the full list of options that were compared, each option's cost, response time, and any errors, plus the audio's length in time. It does not include the audio itself or any transcripts. This is what makes it safe to store without limits. The list of options and the ID of the original primary answer make the vote log useful to read later. Without the list of options, a win is just a count, not a rate. Without knowing the original primary answer, you cannot tell a new favorite from the old default. An **eval-set** (`{"type":"eval-set",…}`) has everything a vote has, plus the recording as a base64 WAV file, plus every option's transcript. An eval-set is built as a vote plus more data. This design means the two records can never disagree about the same pick.

  Files are named by type first, then by UTC date, then by time and message ID. For example: `votes/2026/07/16/…-<messageId>.json`. This way, reading the vote log never requires loading megabytes of audio data. A pick's vote file and eval-set file share the same file name ending.

  The `vxasr` package now has a `writeWav` function. It sits next to the existing `readPcm` function, which reads the same file format. This keeps one set of rules and one set of numbers for the format, checked by a test that writes a file and reads it back. This means the same code that saves today's audio will also be used to replay it against models later. This function is exported as `vxasr/audio`, so a browser can use it without loading the full provider code.

  Configure this feature with `EVAL_STORAGE_BUCKET` (this turns the feature on), `EVAL_STORAGE_ACCESS_KEY_ID`, `EVAL_STORAGE_SECRET_ACCESS_KEY`, and, if needed, `EVAL_STORAGE_REGION`, `ENDPOINT`, `FORCE_PATH_STYLE`, and `PREFIX`. If you set a bucket name but no credentials, the server fails to start. This is safer than creating upload links that fail in the browser, where no one would see the error.

- 7173755: Add a new endpoint: `POST /messages/:id/winner`. This endpoint lets an eval winner's transcript replace the message's main answer.

  An eval run creates no message of its own. So, picking a winner just updates the existing message. The app shares this update over SSE, the same way it shares a live transcription update. The webhook fires again too, this time with the winner's transcript. The system already told other services the primary answer when the recording finished. This second webhook call is the correction. The payload type was already `message.updated` for the first call, so a second update uses that same, correct type.

  Messages now have a `configurationId` field. This field names the model configuration that wrote the current answer. The recording sets it at first. Picking a winner then overwrites it. Without this field, a second `message.updated` event would be an unexplained change to the transcript.

  The server checks that the winning configuration ID is one it actually serves. The server does not check the transcript text itself, and it cannot: the eval results come from the browser, and the backend keeps no copy of the recording to check against. This write only affects the caller's own message log. So, even though the transcript is not checked, it can only ever change the caller's own messages. The server refuses this request if the message is still recording — a live session could otherwise overwrite the winner. The server accepts this request if the message's primary answer had failed. In that case, the message becomes "done".

### Patch Changes

- 8048d13: Move shared code out of three ASR providers into one place.

  Qwen, Qwen-Omni, and BytePlus each had about 35 lines of the same code. This code managed the buffer state, the chunk-send loop, a timing issue at the start, the error handler, and the `close()` function. Over time, the three copies had started to differ from each other (see issue dtinth/vxbeamer#72).

  This code now lives in one function: `createBufferedSocketSession`. Each provider now supplies only its own vendor-specific parts: the handshake, the audio format, the turn-end signal, and the message parser. Each provider still counts its own bytes for billing. This matters because Qwen-Omni bills by token, not by audio time.

  This change also fixes a bug in `finish()`. BytePlus checked if the socket was open before it tried to end a turn. Qwen and Qwen-Omni did not have this check. So, if the socket had an error after it opened, and then you called `finish()`, Qwen and Qwen-Omni would report a false error. The check now lives in the shared function. It applies to all three providers.

  This change also merges three smaller pieces of duplicate code. There is no change in behavior.

  - `readAudioFrame` and `isStopMessage`: These functions decode binary audio frames and detect stop messages. The recording socket and the eval socket now share this code. The decoder does not touch the message log. This keeps the eval socket separate from the message store, as required.
  - `buildBackendSocketUrl`: This function builds a `ws` or `wss` URL from an `http` or `https` URL. The recording bar and the eval feature now share this code.
  - `concatChunks`: This function joins audio chunks into one buffer. The WAV writer and the eval frame splitter now share this code.

- 02be1ab: Fix a leak of vendor connections.

  Before, if a client disconnected during a recording, without sending a `stop` message first, the server could keep the vendor connection open forever. This could happen with an unstable network, or an app moved to the background. The server's `finish()` function waits for a message from the vendor. But the vendor is not required to send that message. If enough of these connections leaked, the account hit its vendor connection limit. The error for this is: "connections too much max_connections 100". This affects every user of the account.

  Now, when the client disconnects (`onClose`), the server starts a timer. This reuses the existing idle-watchdog timer code. If the vendor does not respond within `WS_IDLE_TIMEOUT_MS`, the server force-closes the session. It also marks the message as an error.

- cb94f9d: Add the Eval dialog. It replays a recording through every model configuration. You then pick the best result.

  If a finished message still has its audio in memory, the app now shows an **Eval** option. The dialog opens one WebSocket connection for each configuration. It replays the saved audio through all of them at the same time. It shows each configuration's text as it arrives. You read the results and tap the one you prefer. That result then replaces the message's main answer.

  - **`/asr/eval`** (on the backend) transcribes audio without writing to the message log. This is a separate route, in its own code module. This module cannot import the message store. This design guarantees that an eval run creates no message (see issue dtinth/vxbeamer#38). This is a structural rule, not just a setting. Results return down the same socket, since only the frontend needs an eval run's results.
  - **Each replay runs at 1x speed.** The app sends one 3200-byte audio frame every 100 ms, per socket, once that socket is ready. This is not something to speed up: BytePlus stops responding if you send audio faster than real time. Also, billing is based on audio duration, not connection time, so slower sending costs nothing extra. Because all sockets run at the same time, one eval run takes about as long as the audio clip itself, no matter how many configurations you compare.
  - **Each configuration runs only once** per eval. There are no repeat runs, no averaging, and no confidence scores. The real signal comes from votes across many messages over time, not from one eval run.
  - Some rows will not show live text (a model that returns one final result). Other rows cannot run at all (the server has no credentials for that configuration). The app shows both of these cases plainly. It does not treat them as errors.

- 5855bcf: Export "fast dump" support as real data: `ProviderSpec.supportsFastDump`, and the matching fields on `ProviderDefinition` and `ConfigurationDefinition`. The backend's `GET /asr/configurations` endpoint now includes this data too. "Fast dump" means the provider accepts a whole audio clip sent all at once, not paced over time.

  Before, this data only existed as a fixed list, `FAST_DUMP_PROVIDERS`, inside the website's eval-replay code. So, any other program using the `vxasr` package had no way to know which providers support fast dump. It would have had to guess, or copy that same list. Now, the website's eval dialog reads this data from the server. It no longer keeps its own copy of the list.

- 1bd504c: Let a `qwen-omni` vendor connection stay open for reuse by the same client. Before, the app always closed the connection after each turn. Now, if the same client starts a new, short recording soon after, it can reuse the same connection. This lets the model keep its earlier conversation context.

  This feature is opt-in. It uses a new `clientId` field on `ASRCreateSessionOptions`. Every other provider ignores this field — for them, nothing changes. The website sends one client ID for each page load. It does not save this ID, so reloading the page always starts fresh. The backend combines this ID with your login, so two different accounts can never share the same open connection.

  The app closes an idle connection, instead of keeping it open, once one of two limits is reached: the connection has been idle longer than `QWEN_OMNI_STICKY_LINGER_MS` (30 seconds by default), or the total audio sent on it has passed `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (180 seconds by default). This second limit keeps token cost and conversation size from growing without a limit.

- 0431692: Reclaim vendor connections. Close idle connections. Always close a connection after an error.

  Each speech vendor allows only a limited number of open connections per account. The error for this is: "connections too much max_connections 100". Every `/ws` and `/asr/eval` connection holds one of these open for its whole life. Two gaps let these connections leak, until the account hit that limit:

  - **There was no way to close an abandoned session.** The `ASRSession` type only had `sendAudio()` and `finish()`. The `finish()` function waits for the vendor to send a final message. But if the connection has gone silent, the vendor may never send that message. This change adds `ASRSession.close()`. This function closes the connection right away. It is safe to call more than once. It sends no more updates after you call it. This lets the app free up a vendor connection slot, instead of waiting for the vendor to notice and close it first.

  - **An error did not always close the connection.** Now, every provider's `ws.on("error")` handler closes the socket. Also, the Qwen provider now closes its connection after a vendor error message, the same way BytePlus and Qwen-Omni already did. Before, a "max_connections" error itself could leak another connection — making the same problem it was reporting even worse.

  The app now also closes an idle connection automatically. A timer starts when the vendor session opens. Each new audio frame resets this timer. If `WS_IDLE_TIMEOUT_MS` passes with no new audio (60 seconds, by default), the app closes both the client connection and the vendor connection. Set this value to 0 or less to turn this feature off. This timer checks for silence, not just an open connection — so a client that stays connected but stops sending audio is still cleaned up. This timer turns off once you send a `stop` message, since after that, the vendor controls the pace, not the client.

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

- 02be1ab: Fix a vendor-connection leak: a client that disconnects mid-recording without ever sending `stop` (an unstable connection, a backgrounded app) could pin its upstream vendor connection open indefinitely, since the graceful `finish()` shutdown waits for a terminal event the vendor isn't guaranteed to send. Enough of those exhaust the vendor's per-account connection cap ("connections too much max_connections 100") for every user. `onClose` now arms a bounded fallback — reusing the existing idle-watchdog mechanism — that force-closes the session and marks the message as errored if the vendor hasn't responded within `WS_IDLE_TIMEOUT_MS` of the client disconnecting.
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
