# vxasr

## 0.1.0

### Minor Changes

- 2681be3: Add a `vxasr` command-line tool. It runs one model configuration against an audio file. It needs no server, no browser, and no microphone.

  It accepts a WAV file or raw PCM audio (16 kHz, 16-bit, mono). It checks the file content to detect WAV format. It does not rely on the file extension. It prints the transcript to stdout. It prints the cost of each processing layer to stderr. This lets you see what each layer charged.

  By default, the tool sends audio at real-time speed. Use `--fast` only to test faster sending. Fast sending does not show real-time behavior.

  This change also replaces the package README file. The old file was still the unused template text.

- 9663f08: Fix BytePlus. It can now transcribe the language the speaker actually uses.

  The adapter connected to `/api/v3/sauc/bigmodel`. This is the two-way streaming mode. This mode does not accept a `language` field. The vendor's documentation says the `language` field works only with `/api/v3/sauc/bigmodel_nostream`. Without a language field, this mode only covers Mandarin, English, and a few Chinese dialects. It could not hear Thai. It did not fail with an error. Instead, it returned confident but wrong text, such as: `project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。` This is the worst kind of error. A human judge may believe it is correct.

  **Each mode is now a separate model.** BytePlus serves each mode at its own address. So, `byteplus/bigmodel_nostream` and `byteplus/bigmodel` are now two separate items in the list. They are two separate configuration IDs. The two modes hear different languages from the same audio. So, they must be evaluated as different things. A vote must say which mode it is for. On the wire, both modes still send `model_name: bigmodel`. The vendor uses one model name for both. The two modes differ only by their address path.

  **You can now set the language with `BYTEPLUS_LANGUAGE`** (for example, `th-TH`). The provider reads this setting and sends it in the `audio` object, not the `request` object. This setting is specific to BytePlus. It is not a shared `ASR_LANGUAGE` setting for all providers. Each vendor uses its own language codes. Qwen, for example, takes no language setting at all — it detects the language automatically. A shared setting could also affect other providers in ways we have not yet decided. The language setting is sent only to modes that support it. The `bigmodel` mode never receives a field that the vendor would reject.

  **The `byteplus/bigmodel` configurations are removed from the default list.** A model that cannot be told the speaker's language wastes a vendor call. It is not a fair choice to evaluate. The `bigmodel+groq` combination was even worse. The Groq step rewrote the wrong text into text that reads like a correct answer. The provider still supports `bigmodel`. A deployment that mainly serves Mandarin or English speakers can still add it as a configuration. It is just not offered by default.

  Note a trade-off: `bigmodel_nostream` only returns results after 15 seconds of audio, or after the final audio packet. So, it sends few or no partial results while recording. It favors accuracy over speed. This fits the eval feature well, since only the final result matters there. It fits the live recording feature less well.

  This change also fixes a hang. Before, if you called `finish()` before the socket finished opening, the app dropped the last audio packet. The turn never ended.

- e920490: Save every eval winner pick to cloud storage. The app always saves a **vote**. It also saves an **eval-set** when you check "save for eval".

  The backend signs upload links. The browser uploads the file directly. The endpoint `POST /messages/:id/winner` now returns `{ ok, upload }`. The `upload` field holds signed upload links for this pick's vote and, if checked, its eval-set. The audio never passes through the backend server. This keeps the rule "the backend never stores recordings" true by design, not just by convention. No storage password ever reaches the browser. Signing happens offline, so creating the links adds no extra network delay. The links are created for the `configurationId` that the winner endpoint already checked. A separate endpoint would have to check it again, or it could create links for configurations the server does not serve.

  A storage failure cannot block a vote. The app applies and shares the winner pick first. It creates the upload link after. So, if storage is down, not set up, or missing, you only lose the eval-set upload — the vote itself is not affected. The `upload` field is `null` when no storage bucket is configured. If the backend refuses the upload, nothing is sent.

  A **vote** (`{"type":"vote",…}`) is created for every pick. It has the winning configuration's ID, the full list of options that were compared, each option's cost, response time, and any errors, plus the audio's length in time. It does not include the audio itself or any transcripts. This is what makes it safe to store without limits. The list of options and the ID of the original primary answer make the vote log useful to read later. Without the list of options, a win is just a count, not a rate. Without knowing the original primary answer, you cannot tell a new favorite from the old default. An **eval-set** (`{"type":"eval-set",…}`) has everything a vote has, plus the recording as a base64 WAV file, plus every option's transcript. An eval-set is built as a vote plus more data. This design means the two records can never disagree about the same pick.

  Files are named by type first, then by UTC date, then by time and message ID. For example: `votes/2026/07/16/…-<messageId>.json`. This way, reading the vote log never requires loading megabytes of audio data. A pick's vote file and eval-set file share the same file name ending.

  The `vxasr` package now has a `writeWav` function. It sits next to the existing `readPcm` function, which reads the same file format. This keeps one set of rules and one set of numbers for the format, checked by a test that writes a file and reads it back. This means the same code that saves today's audio will also be used to replay it against models later. This function is exported as `vxasr/audio`, so a browser can use it without loading the full provider code.

  Configure this feature with `EVAL_STORAGE_BUCKET` (this turns the feature on), `EVAL_STORAGE_ACCESS_KEY_ID`, `EVAL_STORAGE_SECRET_ACCESS_KEY`, and, if needed, `EVAL_STORAGE_REGION`, `ENDPOINT`, `FORCE_PATH_STYLE`, and `PREFIX`. If you set a bucket name but no credentials, the server fails to start. This is safer than creating upload links that fail in the browser, where no one would see the error.

- 5855bcf: Export "fast dump" support as real data: `ProviderSpec.supportsFastDump`, and the matching fields on `ProviderDefinition` and `ConfigurationDefinition`. The backend's `GET /asr/configurations` endpoint now includes this data too. "Fast dump" means the provider accepts a whole audio clip sent all at once, not paced over time.

  Before, this data only existed as a fixed list, `FAST_DUMP_PROVIDERS`, inside the website's eval-replay code. So, any other program using the `vxasr` package had no way to know which providers support fast dump. It would have had to guess, or copy that same list. Now, the website's eval dialog reads this data from the server. It no longer keeps its own copy of the list.

- 02be1ab: Add OpenAI's `gpt-live-transcribe` model as a new ASR provider. This is the `openai` entry in the provider list. For now, it only supports raw output — it has no `+groq` cleanup option. The connection uses the account's own secret key directly. It does not use the short-lived `client_secrets` method. The backend is a trusted caller, so the extra network round trip would only add delay.

  This change also adds `LinearResampler`. This is a reusable tool that resamples streaming audio. It keeps state across audio chunks, so it does not create a glitch where one chunk ends and the next begins. It is used here to convert the app's 16 kHz audio up to the 24 kHz that this API requires.

- 3d6323d: Add OpenRouter as a new ASR provider. This provider works differently from every other provider here. It sends one plain HTTP request (`POST /v1/audio/transcriptions`) for each recording. It does not use a live connection. The app collects the whole audio clip, sends it as one WAV file when you call `finish()`, and then waits for one response. There is no partial text while it works.

  The model `microsoft/mai-transcribe-1.5` is now a preset. Its configuration ID is `openrouter/microsoft/mai-transcribe-1.5`. This model was picked after a live comparison test against 18 other OpenRouter speech-to-text models. All tests used the same audio file already used in `testdata/OBSERVATIONS.md`.

- 94e7feb: Change every Qwen model ID to a dated, fixed version. Remove the old, undated `qwen3-asr-flash-realtime` ID.

  An undated model ID can change without warning — the vendor can point it to a new model version at any time. So, the app's output could change even when nothing in this project's code has changed. A vote could then end up naming a model that no longer exists in that form. This is not a small risk. Fun-ASR shows a real case: its newest version silently stopped supporting Thai. An undated ID would have quietly broken a language, with no warning.

  You can now select `qwen3-asr-flash-realtime-2025-10-27` and `qwen3-asr-flash-realtime-2026-02-10`. Each is available raw or with `+groq`. The main, default model is now `2025-10-27+groq`. This is the version the old, undated ID pointed to right before this change. So, behavior for existing users does not change — only the model version is now fixed in place.

  **Breaking change**: If you set `ASR_MODEL=qwen3-asr-flash-realtime`, this will now fail. That ID no longer exists. You must set a dated version instead.

- ac46ea8: Add the Qwen Omni Realtime models as a new provider, called `qwen-omni`. It has three fixed configurations you can select.

  These are not speech-to-text models. They are general chat models that can also hear audio. On the Thai test audio file, they give the best result of all providers tested. They write Thai words in Thai script, and product names in Latin script (for example: `โปรเจกต์นี้เขียนด้วยภาษา TypeScript … ใช้เฟรมเวิร์กชื่อ Elysia`). No other tested model, including BytePlus, mixes scripts this way.

  These models use their **own message format**. They do not use the same format as the regular Qwen speech-to-text models. A turn ends with two messages: `input_audio_buffer.commit`, then `response.create`. The transcript arrives in `response.text.delta` and `response.text.done` messages. There is no `session.finish` message — if you send one, the connection to these models times out. Billing also works differently: it is based on tokens used, at rates that differ by model. For these reasons, this is a new, separate provider. It is not added as new models under the existing `qwen` provider. One provider matches one message format.

  You can select these configurations. All are **raw only** — with no `+groq` cleanup step. These models already produce clean output, so a Groq cleanup step would cost an extra AI call and a vote choice, for no real gain:

  - `qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15` (the default model)
  - `qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15`
  - `qwen-omni/qwen3-omni-flash-realtime-2025-12-01`

  All three use fixed, dated model versions from the vendor's own model list. So, the rule against undated model IDs needed no exception here. These models use the same setting as before: `DASHSCOPE_API_KEY`.

  Usage is measured and reported in **tokens**. Audio input, text input, and text output are each billed at their own rate, since the vendor charges different rates for audio and text. Reporting the real, measured token count — instead of estimating from audio length — reveals a real cost difference: `qwen3-omni-flash-realtime` costs about 58% more per recording than `qwen3.5-omni-flash-realtime`, even though their listed rates are almost the same. This is because the older model needs more tokens to represent the same audio.

- 1bd504c: Let a `qwen-omni` vendor connection stay open for reuse by the same client. Before, the app always closed the connection after each turn. Now, if the same client starts a new, short recording soon after, it can reuse the same connection. This lets the model keep its earlier conversation context.

  This feature is opt-in. It uses a new `clientId` field on `ASRCreateSessionOptions`. Every other provider ignores this field — for them, nothing changes. The website sends one client ID for each page load. It does not save this ID, so reloading the page always starts fresh. The backend combines this ID with your login, so two different accounts can never share the same open connection.

  The app closes an idle connection, instead of keeping it open, once one of two limits is reached: the connection has been idle longer than `QWEN_OMNI_STICKY_LINGER_MS` (30 seconds by default), or the total audio sent on it has passed `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (180 seconds by default). This second limit keeps token cost and conversation size from growing without a limit.

- d9c4698: Add a provider registry and a list of **model configurations**.

  A provider connects an ID to a function. This function builds an `ASRProvider` from settings and a model name. Each provider defines its own settings shape. This means a provider that needs more than an API key — for example, a region code, full cloud credentials, or a setup step — can still be added, without changing the registry itself.

  A configuration pairs one provider and one model with a chain of processing steps. This configuration is the item that users select and compare. The processing steps are part of a configuration's identity. They are not a separate, optional setting on each request. So, `qwen/qwen3-asr-flash-realtime` and `qwen/qwen3-asr-flash-realtime+groq` are two separate configurations. Users can compare them as equal, separate choices. Each configuration's ID is built from its parts. So, an ID can never drift out of sync with what it names.

  This change exports these new functions: `createProviderRegistry`, `defineProvider`, `createDefaultProviderRegistry`, `createConfigurationCatalogue`, `defineDecorator`, `buildConfigurationId`, and `createDefaultConfigurationCatalogue`. This is also the first change that makes `createBytePlusProvider` usable from outside this package. `BytePlusProviderConfig` now has an optional `model` field. If you do not set it, it defaults to `bigmodel`, the same value that was hardcoded before.

### Patch Changes

- 8048d13: Move shared code out of three ASR providers into one place.

  Qwen, Qwen-Omni, and BytePlus each had about 35 lines of the same code. This code managed the buffer state, the chunk-send loop, a timing issue at the start, the error handler, and the `close()` function. Over time, the three copies had started to differ from each other (see issue dtinth/vxbeamer#72).

  This code now lives in one function: `createBufferedSocketSession`. Each provider now supplies only its own vendor-specific parts: the handshake, the audio format, the turn-end signal, and the message parser. Each provider still counts its own bytes for billing. This matters because Qwen-Omni bills by token, not by audio time.

  This change also fixes a bug in `finish()`. BytePlus checked if the socket was open before it tried to end a turn. Qwen and Qwen-Omni did not have this check. So, if the socket had an error after it opened, and then you called `finish()`, Qwen and Qwen-Omni would report a false error. The check now lives in the shared function. It applies to all three providers.

  This change also merges three smaller pieces of duplicate code. There is no change in behavior.

  - `readAudioFrame` and `isStopMessage`: These functions decode binary audio frames and detect stop messages. The recording socket and the eval socket now share this code. The decoder does not touch the message log. This keeps the eval socket separate from the message store, as required.
  - `buildBackendSocketUrl`: This function builds a `ws` or `wss` URL from an `http` or `https` URL. The recording bar and the eval feature now share this code.
  - `concatChunks`: This function joins audio chunks into one buffer. The WAV writer and the eval frame splitter now share this code.

- 2fd891a: Remove an unused `latencyMs` field — nothing ever set it. Share one `quoteId` function between the provider registry and the configuration list, instead of two separate copies. Have the frontend read its audio constants from `vxasr/audio`, instead of writing the same values a second time.
- 0431692: Reclaim vendor connections. Close idle connections. Always close a connection after an error.

  Each speech vendor allows only a limited number of open connections per account. The error for this is: "connections too much max_connections 100". Every `/ws` and `/asr/eval` connection holds one of these open for its whole life. Two gaps let these connections leak, until the account hit that limit:

  - **There was no way to close an abandoned session.** The `ASRSession` type only had `sendAudio()` and `finish()`. The `finish()` function waits for the vendor to send a final message. But if the connection has gone silent, the vendor may never send that message. This change adds `ASRSession.close()`. This function closes the connection right away. It is safe to call more than once. It sends no more updates after you call it. This lets the app free up a vendor connection slot, instead of waiting for the vendor to notice and close it first.

  - **An error did not always close the connection.** Now, every provider's `ws.on("error")` handler closes the socket. Also, the Qwen provider now closes its connection after a vendor error message, the same way BytePlus and Qwen-Omni already did. Before, a "max_connections" error itself could leak another connection — making the same problem it was reporting even worse.

  The app now also closes an idle connection automatically. A timer starts when the vendor session opens. Each new audio frame resets this timer. If `WS_IDLE_TIMEOUT_MS` passes with no new audio (60 seconds, by default), the app closes both the client connection and the vendor connection. Set this value to 0 or less to turn this feature off. This timer checks for silence, not just an open connection — so a client that stays connected but stops sending audio is still cleaned up. This timer turns off once you send a `stop` message, since after that, the vendor controls the pace, not the client.

## 0.1.0-next.9

### Minor Changes

- 3d6323d: Add an OpenRouter provider — a plain batch HTTP transcription call (`POST /v1/audio/transcriptions`), not a realtime protocol like every other provider here: the whole clip is buffered client-side and sent as one WAV file once `finish()` is called, with no partial output. `microsoft/mai-transcribe-1.5` is declared as a configuration preset (`openrouter/microsoft/mai-transcribe-1.5`), chosen after comparing it live against 18 sibling OpenRouter STT models on the fixture `testdata/OBSERVATIONS.md` uses.

## 0.1.0-next.8

### Minor Changes

- 1bd504c: Let a `qwen-omni` vendor connection linger for reuse by the same client instead of always closing when a turn ends, so consecutive short recordings from one client can share the vendor's conversation context. Opt-in via a new `clientId` on `ASRCreateSessionOptions` — every other provider ignores it, unchanged. The website sends one client id per page load (not persisted, so a refresh always starts clean); the backend scopes it to the authenticated subject so two accounts never share a pooled connection. A lingering connection is retired instead of reused once it sits idle past `QWEN_OMNI_STICKY_LINGER_MS` (default 30s) or its accumulated input audio crosses `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (default 180s, bounding token cost and context growth).

## 0.1.0-next.7

### Minor Changes

- 5855bcf: Export per-provider "fast dump" support as real metadata: `ProviderSpec.supportsFastDump` (and its type-erased `ProviderDefinition`/`ConfigurationDefinition` counterparts), carried through the backend's `GET /asr/configurations` response. Previously this lived only as a hardcoded `FAST_DUMP_PROVIDERS` set in the website's eval-replay pacing logic, so an external consumer of `vxasr` had no way to know which providers tolerate a fast dump without re-deriving or copying that list. The website's eval dialog now reads the flag from the server instead of keeping its own copy.

## 0.1.0-next.6

### Minor Changes

- 02be1ab: Add OpenAI's `gpt-live-transcribe` (Realtime API) as an ASR provider — `openai` in the provider registry, raw-only for now (no `+groq` post-processing variant). Connects directly with the account's secret key rather than the ephemeral `client_secrets` token flow, since the backend is a trusted caller and the extra round trip would only add latency. Introduces `LinearResampler`, a reusable streaming resampler that carries state across chunks so it doesn't introduce a boundary artifact, used here to upsample the 16kHz capture to the API's 24kHz minimum.

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

## 0.1.0-next.4

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
