# ASR model observations

Raw results from running models against `test-audio.bin`. **Observations only** — what was sent, what came back. No rankings.

Everything here was run against live vendor endpoints on **2026-07-16**.

## Fixture

`test-audio.bin` — raw PCM, 16 kHz / 16-bit / mono, little-endian, no header.
294,986 bytes = 9.218 s. Thai speech containing English technical terms
("TypeScript", "Elysia", "Railway", "MongoDB Atlas").

## Method

- Audio sent at **realtime pacing**: 3200-byte chunks (100 ms), 100 ms apart, unless a row says otherwise.
- **One run per row unless a repeat count is given.** These models are LLMs with audio intake and are **not deterministic** — see [Repeat runs](#repeat-runs), where identical inputs produced different outputs.
- Transcripts are reproduced **exactly**, including case, spacing and trailing punctuation.

---

## Alibaba Cloud DashScope — Qwen

OpenAI-compatible realtime protocol. `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=<id>`, `Authorization: Bearer`, `session.update` with `turn_detection: null` (Manual mode), audio base64 in `input_audio_buffer.append`.

| model                                 | output                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen3-asr-flash-realtime` (floating) | `project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.` |
| `qwen3-asr-flash-realtime-2025-10-27` | `project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.` |
| `qwen3-asr-flash-realtime-2026-02-10` | `โปรเจกต์นี้เขียนด้วยภาษา typescript ใช้ framework ชื่อ elixir โดย deploy ไปที่ railway และใช้ mongodb atlas เป็นผู้ให้บริการฐานข้อมูล`  |
| `qwen3-asr-flash-realtime` + Groq     | `project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.` |
| `qwen3-omni-flash-realtime`           | **no result** — 60 s timeout. It speaks its own protocol, not this one; see the Qwen Omni (realtime) section.                            |

Usage reported: `dashscope:qwen3-asr-flash:seconds` quantity **10**, unit price `$0.000035` → `$0.000350`.
With Groq, additionally: `groq:openai/gpt-oss-120b:input-tokens` **224** @ `$1.5e-7`, `output-tokens` **~160** @ `$6e-7` → `$0.000479` total.

## Alibaba Cloud DashScope — Qwen Omni (offline)

**Not** the realtime WS protocol — these are offline/batch models reached over
HTTP. `POST https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
(OpenAI-compatible), `Authorization: Bearer`, a `messages` array carrying an
`input_audio` content part (base64 WAV data URI) alongside a text prompt, with
`modalities: ["text"]`.

The whole 9.218 s clip is uploaded at once; there is no pacing.

Prompt used for every row below — **these models are prompt-driven, so the
prompt is part of the input**:

> `Transcribe this audio verbatim. Output only the transcript.`

| model                | output                                                                                                                                 | wall  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `qwen3.5-omni-plus`  | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` | 1.7 s |
| `qwen3-omni-flash`   | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย Deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` | 1.7 s |
| `qwen3.5-omni-flash` | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Alecia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` | 1.7 s |

**Billing is in tokens, not seconds** — a different cost model from every ASR
model above:

| model                | prompt (audio + text) | completion | total |
| -------------------- | --------------------- | ---------- | ----- |
| `qwen3.5-omni-plus`  | 89 (65 + 24)          | 32         | 121   |
| `qwen3.5-omni-flash` | 89 (65 + 24)          | 31         | 120   |
| `qwen3-omni-flash`   | 137 (117 + 20)        | 55         | 192   |

The same audio tokenises differently across the two generations (65 vs 117
audio tokens).

The omni **realtime** models transcribe from their own weights too, over their
own protocol — see the Qwen Omni (realtime) section. These offline rows are a
different endpoint (HTTP, not WS) reached with a prompt rather than an
`instructions` string.

## Alibaba Cloud DashScope — Qwen Omni (realtime)

These have **their own protocol** — not the Qwen ASR realtime one. Same URL
shape (`wss://…/api-ws/v1/realtime?model=<id>`; the vendor now recommends the
workspace domain `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`, though the
legacy host answered), `Authorization: Bearer`, but:

- `session.update` with `modalities: ["text"]`, **`input_audio_format: "pcm"`**,
  `turn_detection: null` (manual), and an **`instructions`** string.
- `input_audio_buffer.append` (base64) → `input_audio_buffer.commit` → `response.create`.
- The model's own output arrives on **`response.text.delta` / `response.text.done`**.
- No `session.finish` — that is the ASR protocol's message, not this one's.

Instructions used for every row below — **these models are instruction-driven,
so the instruction is part of the input**:

> `Transcribe the user's audio verbatim. Output only the transcript, nothing else.`

| model                         | output                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen3.5-omni-plus-realtime`  | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`  |
| `qwen3.5-omni-flash-realtime` | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`  |
| `qwen3-omni-flash-realtime`   | `Project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` |

Billing is in **tokens**:

| model                         | input (text + audio) | output | total |
| ----------------------------- | -------------------- | ------ | ----- |
| `qwen3.5-omni-plus-realtime`  | 114 (44 + 70)        | 32     | 146   |
| `qwen3.5-omni-flash-realtime` | 114 (44 + 70)        | 32     | 146   |
| `qwen3-omni-flash-realtime`   | 165 (40 + 125)       | 47     | 212   |

The vendor documents speech recognition for **113 languages and dialects**, a
120-minute session cap, and per-model conversation-history limits
(`qwen3.5-omni-plus-realtime` 100 audio turns / 600 s; `-flash-realtime`
80 / 480 s; `qwen3-omni-flash-realtime` 8 turns).

### The separate transcription sub-service

Independently of the model's own output, a session may name an ASR model in
`session.input_audio_transcription`; its results arrive on
`conversation.item.input_audio_transcription.*`. **This is not the omni model
transcribing** — it is a different model running alongside:

| `session.input_audio_transcription`                | `conversation.item.input_audio_transcription.completed`                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `{ model: "gummy-realtime-v1" }`                   | `project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.` |
| `{}` (no model named)                              | no event at all                                                                                                                          |
| `{ model: "qwen3-asr-flash-realtime-2025-10-27" }` | `project นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล.` |

Note these differ from the omni model's own `response.text` output above: this
stream renders `project` in Latin, the omni model renders `โปรเจกต์` in Thai.

### With no `instructions`

Sending `response.create` without an `instructions` string produced a
**conversational reply**, in Thai, offering to help design the project described
in the clip — a Tech Stack breakdown with numbered sections and follow-up
questions. Not a transcript. The audio's content drove a conversation.

Observed event sequence: `session.created`, `session.updated`,
`conversation.item.input_audio_transcription.delta`, `input_audio_buffer.committed`,
`response.created`, `response.output_item.added`, `conversation.item.created`,
`response.content_part.added`, `response.text.delta`,
`conversation.item.input_audio_transcription.completed`, `response.text.done`,
`response.content_part.done`, `response.output_item.done`, `response.done`.

### Against our ASR provider

Our `qwen` provider speaks the ASR-specific protocol (`session.finish`) and
waits for ASR events, so it does not drive these models:

| model                         | result                  |
| ----------------------------- | ----------------------- |
| `qwen3-omni-flash-realtime`   | no result, 60 s timeout |
| `qwen3.5-omni-plus-realtime`  | no result, 60 s timeout |
| `qwen3.5-omni-flash-realtime` | no result, 60 s timeout |

### `qwen3.8-omni-flash-realtime` (2026-11-12)

Served only from a workspace endpoint:
`wss://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime`,
not the shared `dashscope-intl` one. No dated snapshot is listed in the vendor's
docs. The vendor's page describes a new nested `session.update` shape
(`audio.input.format`, `audio.output`), but our existing flat handshake
(`input_audio_format: "pcm"`, `sample_rate`, `turn_detection: null`) is accepted
unchanged, so the same adapter drives it.

On the 9.2 s fixture, four realtime runs: two returned the same transcript as
`qwen3.5-omni-flash-realtime-2026-03-15` (`เฟรมเวิร์ก` in Thai, `deploy` in
Latin); one rendered `deploy` as `ดีพลอย`; one kept `framework` in Latin. Same
token counts (70 audio, 97 text, 29-33 output), about 10 s wall clock, but
fewer and coarser partials (9-11 against 31). Four runs is a sample, not a
measurement.

Price, from the vendor's model-pricing page (Singapore, USD per 1M tokens, read
2026-11-12): input text $0.23, input audio $0.93, output text $0.70, output
audio $1.87. We ask for text-only output, so the text rate applies: about
$0.00011 for this clip. The page lists `qwen3.5-omni-flash-realtime` at $0.55 /
$4.50 / $3.30 / $17.70 on the same four columns. `QWEN_OMNI_PRICING` used to
charge the output _audio_ column ($17.70, and $62 for plus) for text output; it
now charges the text column ($3.30 and $12.40), so the 3.5 clip cost
is now about $0.00047 rather than $0.00094 (4.4x the 3.8 price, not 8.5x).

### `qwen-audio-3.1-asr-flash-message` and `-streaming` (2026-11-12)

A third Qwen wire protocol: DashScope's duplex `run-task` (a `run-task` text frame,
raw PCM as binary frames, `finish-task`), against
`wss://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`. Audio may
only be sent after `task-started`. Results come as `result-generated` with a
`sentence` (`sentence_id`, `sentence_end`, `text`) and cumulative `usage` tokens.

**When partials arrive** (9.2 s clip, real-time pacing, last audio chunk at 9.45 s):
the Omni models send no partial before the last chunk, because the adapter sends
`response.create` only at the end. Both Audio-3.1 models stream while the audio is
still being sent: `-streaming` 13 partials from 1.3 s, `-message` 22 partials from
0.5 s (with `intermediate_result_enabled`; its default is final-only). Every model
finishes 0.2-0.7 s after the last chunk.

**Partials are not the transcript.** `-message` guesses the language from the first
fraction of a second, so its partials are English and Chinese junk until late in the
clip (`language_hints: ["th"]` did not change the partials). `-streaming` partials
are garbled early and readable from about 5 s. The partials only tell the user they
are being heard.

**Final text**, 7 runs of `-message` paced at real time: 5 gave the good transcript (Thai script,
spaced, `TypeScript`/`Elysia`/`deploy`/`Railway`/`MongoDB Atlas` in Latin, matching
`qwen3.8-omni-flash-realtime`'s good runs); 2 wrote phonetic Thai for every English
word (`ไทป์สคริปต์`, `เอลิเซีย`, `มองโกดีบีแอดลาสต์`) with 77 output tokens instead of 54. 5 runs of `-streaming`: always no spaces between words, always Latin
`project`/`typescript`/`framework`/`elysia`/`deploy`/`railway` in lowercase, and
`MongoDB Atlas` wrong in a different way each time (`mongodbb atlas`, `mongodbbas`,
`mongodbbasas`). Neither run-to-run variation is a measurement; n is small.

**Faster than real time** (the CLI's `--fast`, every chunk sent back to back; 3 runs
each, 9.2 s clip): all three new models accept it. `qwen3.8-omni-flash-realtime`
1.07-1.15 s, `-message` 0.83-0.86 s, `-streaming` 1.98-2.58 s. The text and token
counts are the same as when paced at real time (3.8 and `-message` the good
transcript all 3 times, though the phonetic-Thai variant of `-message` is seen only
when paced, so 3 fast runs do not rule it out; `-streaming` the same unspaced text with `mongodbbas` all 3
times), so nothing was dropped. One short clip, so a clip of several minutes sent as
fast could still behave differently; not tested.

**Tokens and price.** `-message` 116 in / 54 out, `-streaming` 109 in / 45 out, the
vendor's measured counts. Price, from the vendor's pricing page (Singapore, per 1M
tokens): $0.93 input / $0.70 output for both, about $0.00015 and $0.00013 per clip.

### Tuning the message model's parameters (2026-11-12)

`qwen-audio-3.1-asr-flash-message` takes these `parameters` on `run-task` (vendor's
client-events page): `disfluency_removal_enabled` (its "native text polishing":
drops fillers), `language_hints` (up to 4 codes; applies to finals), `vocabulary` /
`vocabulary_id` (hotwords, weight 1-5, or 50 for a "super" hotword, at most 50 of
those), `input.context` (up to 5 user/assistant turns, 400 characters a turn),
`max_sentence_silence` (200-6000 ms, default 800), `vad_model`,
`speech_noise_threshold`, `heartbeat`, `keep_dialect` (Chinese dialects) and
`intermediate_result_enabled`. Not tried, for want of audio: `vad_model`,
`speech_noise_threshold`, `keep_dialect`.

What was run: the 9.2 s Thai fixture (about 400 sessions in all, 6-56 runs per
setting, several sessions in parallel at real-time pacing), and two synthetic English
clips made with ffmpeg's `flite` voice, one of spoken numbers and one full of
"um/uh/you know". Counts below are runs of the same audio, not independent speakers.

**English words in Thai, spelled in Thai script** ("phonetic": `ไทป์สคริปต์`,
`เอลิเซีย`) as a share of runs on the Thai clip: no parameters 15 of 40;
`language_hints: ["th"]` 1 of 24; `disfluency_removal_enabled` 0 of 24; hotwords at
weight 50 0 of 24 (at weight 5, 5 of 8); a Thai+Latin example turn in `context` 0 of
24 (a bare word list, 4 of 8); `th` + polishing 0 of 12, with weight-50 hotwords also
0 of 12. Setting `max_sentence_silence` at all (200, 800 or 3000) made it worse, 44
of 56; cause unknown, so just do not set it.

**Spoken numbers** (English clip): with no parameters the model wrote digits in 5 of
6 runs (`23 apples`, `0812345678`, `2026`). Every `language_hints` form tried
(`en`, `th`, `th,en`, `en,th`) wrote words in 24 of 24 (`twenty three`). Polishing
alone gave digits in 18 of 18, and a hint plus polishing gave digits in 30 of 30. So
a hint on its own breaks numbers, and polishing repairs it. **Thai spoken numbers
were not tested**: there was no Thai audio with numbers.

**Fillers** (English clip): off, every `um`, `uh`, `you know` and `like` is kept;
on, all are removed (6 of 6), and `Well` and `So` stay.

**The streaming model accepts it too**, and benefits (4 runs each): on the Thai clip
the text gains word spaces, a capital `Project` and a correct `MongoDB Atlas`, where
without it the text is unspaced and `mongodbbas`, though `ชื่อ` loses its last
letter in 4 of 4; on the filler clip the fillers are removed 4 of 4.

Conclusion: polishing is the one setting that helped on every axis, so
`qwen-audio` turns it on by default (`disfluencyRemoval: false` to turn it off).

### Scribe Realtime v2 (2026-11-14)

ElevenLabs' `scribe_v2_realtime`, `wss://api.elevenlabs.io/v1/speech-to-text/realtime`,
header `xi-api-key`. $0.22 per hour (the same as `scribe_v3_live`), per the vendor's
pricing page. The server speaks first (`session_started`); audio is JSON
(`input_audio_chunk`, base64, `commit`, `sample_rate`); the turn ends with an empty
chunk and `commit: true`.

On the 9.2 s Thai fixture (about 30 sessions):

- **Text** is the same in every run: Thai in Thai script, `Project`, `TypeScript`,
  `framework`, `Elysia`, `deploy`, `Railway`, `MongoDB Atlas` in Latin (5 of 5 at live
  pace, 5 of 5 fast, 5 of 5 with `language_code=th`). `Elysia` right in all of them.
- **Partials**: none in the first 2 s (the vendor says processing starts after the
  first 2 s of audio), the first at about 2.2 s after audio starts, then one a second.
  Each _replaces_ the one before. They are shaky: the first two are guesses (`Project
นี้คืออะไรครับ?`) and one went to `Project ниии-- project` before recovering.
- **Commit to final**: 0.25-0.31 s at live pace in 5 of 5 sessions.
- **Faster than real time works, and gives the same text.** The 9.2 s clip sent all at
  once finished in 1.5-1.8 s (5 sessions); a 28.7 s clip in 2.5 s; a 37.3 s clip of
  different speech in 2.7 s. The one difference seen is the Thai spelling of
  `framework` in the 28 s clip (`เฟรมเวิร์ก` fast, `framework` live).
- **A commit with under 0.3 s of uncommitted audio is refused**: `commit_throttled`,
  then the socket closes. A 0.1 s clip hits it; the provider pads with silence.
- **Commits sent in quick succession are throttled too**: a commit every 9.2 s of
  audio, with the audio sent all at once, got `commit_throttled`.
- **The vendor commits by itself** after about 36 s of audio. Sent faster than real
  time, that segment can arrive _after_ our own commit was sent, and nothing on the
  wire says which committed segment answers our commit, so for a recording over 30 s
  the provider waits for segments to stop arriving (1 s). Checked live on the 37 s clip.
- **A clip made of the same sentence four times** lost most of its text, at live pace
  and fast (`Project นี้เขียนด้วย | มือ โอเค`); a 37 s clip of different speech came
  through whole. So it looks like handling of repeated audio, not the 36 s limit, but
  the cause is not known.
- **`no_verbatim=true`** removed `um`/`uh` (2 of 2, synthetic English), and wrote the
  phone number as `0812345678` and the year as `2026` in 1 of 2 runs (the other spelled
  them out). Default is verbatim: fillers kept, numbers as words, `BHT` for baht.
- **`scribe_v3_live`** (3 runs): `โปรเจกต์` in Thai script, but `Framework` and `Deploy`
  capitalized mid-sentence, and 26 partials instead of 9. Not declared.
- Errors are `{"message_type":"auth_error","error":"…"}` then a close (bad key).

Not covered: noisy audio, real Thai speech with numbers, a session longer than a
minute at live pace.

### Pacing: fast dump vs realtime

`qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15`, same fixture, 20 runs per
condition through the `vxasr` CLI (`--fast` sends frames with no delay;
realtime sends 3200 bytes each 100 ms).

**Every run in both conditions returned a transcript. No hangs, no errors.**

| condition | wall clock | runs |
| --------- | ---------- | ---- |
| `--fast`  | 0–1 s      | 20   |
| realtime  | 9–10 s     | 20   |

The transcripts differ only in how the framework name is rendered:

| rendering  | `--fast` | realtime |
| ---------- | -------- | -------- |
| `Elysia`   | 13       | 17       |
| `Alecia`   | 4        | 3        |
| `Alembia`  | 2        | 0        |
| `Aleph.js` | 1        | 0        |

65% vs 85% `Elysia`. **Fisher's exact (two-tailed): p = 0.273 — this sample does
not establish a pacing effect.** The direction was consistent across two
independent samples (2/5 vs 4/5, then 11/15 vs 13/15), and `--fast` produced two
renderings realtime never did, but neither observation is significant at this n.
Distinguishing 65% from 85% needs roughly 70 runs per condition.

Contrast BytePlus's bi-directional `bigmodel` mode, which **hangs outright**
under a fast dump (see its section) — but see below: that is not the mode this
app ships.

Cost is unaffected by pacing: this model bills per token, not per second.

### BytePlus `bigmodel_nostream` (the shipped mode), fast dump vs realtime

The "BytePlus hangs on a fast dump" finding above is about the bi-directional
`bigmodel` mode, which the catalogue deliberately does not declare (no
`language` support — see its section). The mode actually shipped,
`bigmodel_nostream`, had never been fast-dump tested. Run 2026-07-26, same
fixture, through the `vxasr` CLI:

| condition                           | wall clock | outcome                                                                                         |
| ----------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `--fast`, `language` omitted, n=3   | 1.4–2.2 s  | all 3 completed; no hang. Transcripts match the realtime row's shape (English/Chinese nonsense) |
| `--fast`, `BYTEPLUS_LANGUAGE=th-TH` | 1.7 s      | correct Thai, byte-for-byte the same rendering as the realtime `th-TH` row above                |
| realtime (100 ms/chunk)             | ~9.2 s+    | (existing row above)                                                                            |

**`bigmodel_nostream` does not hang on a fast dump.** Billing unaffected (still
`byteplus:seedasr:seconds` quantity 10). This mode is also documented to
withhold partials until 15 s of audio or the final packet regardless of
pacing, so a fast dump costs it nothing it wasn't already giving up.

Also reconfirmed on this run: `qwen/qwen3-asr-flash-realtime-2025-10-27`
(raw and `+groq`) and `qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15` all
complete a `--fast` dump in under 1.5 s with no hangs, consistent with the
existing rows above.

**Net: every configuration currently in `builtinConfigurations` (Qwen ASR,
Qwen Omni, BytePlus `bigmodel_nostream`, each raw or `+groq`) tolerates a fast
dump.** The only "hangs on fast dump" case ever observed is the BytePlus mode
the app does not use. The eval fan-out's fixed 100 ms/frame pacing
(`apps/website/src/evalRun.ts`) is accordingly a real speed-up opportunity —
its comment's justification ("BytePlus hangs outright on a fast dump") turns
out to describe an undeployed mode, not the shipped one.

### `gummy-realtime-v1`

Surfaced only as a value for `input_audio_transcription.model`; it is not in the
vendor's speech-to-text model list. Addressed **directly** over the native
run-task protocol with the same key:

| model               | result                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `gummy-realtime-v1` | **error** — `AccessDenied: Access denied.` (with and without `language_hints`) |

## Alibaba Cloud DashScope — Fun-ASR

Native run-task protocol. `wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference`, `Authorization: Bearer`, JSON `run-task` → wait `task-started` → **raw binary** audio frames → `finish-task`.

| model                         | `language_hints` | output                                                                                                                                     |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `fun-asr-realtime`            | _(omitted)_      | `Project Nickel repository type script, type framework shoe elisia deploy material way, lettuce mongo db atlas, penpui balikantan common.` |
| `fun-asr-realtime`            | `["th"]`         | byte-identical to omitted                                                                                                                  |
| `fun-asr-realtime`            | `["xx"]` (bogus) | byte-identical to omitted                                                                                                                  |
| `fun-asr-realtime`            | `["zh"]`         | `Project Nickelodeon Pasar Typescript Child Framework Shoes Elisia Deploy Material Way LagosMongoDB AtlasPenpah Berikan tan common。`      |
| `fun-asr-realtime-2025-11-07` | _(omitted)_      | byte-identical to `fun-asr-realtime`                                                                                                       |
| `fun-asr-realtime-2025-11-07` | `["th"]`         | byte-identical to omitted                                                                                                                  |
| `fun-asr-realtime-2026-02-28` | —                | **error** — `task-failed`, `error_code: ModelNotFound`                                                                                     |

`zh` changes the output; `th` and a bogus code do not. Vendor-reported billed duration for the 9.218 s clip: **9 s** (`ceil(bytes / 32000)` gives 10).

## BytePlus — Seed-ASR

Binary-framed protocol. `wss://voice.ap-southeast-1.bytepluses.com/api/v3/sauc/<mode>`, `X-Api-Key`, `X-Api-Resource-Id`.

| mode                | resource id                        | `audio.language`             | output                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigmodel`          | `volc.seedasr.sauc.duration` (2.0) | _(unsupported on this mode)_ | `project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。`                                                                                                                                                                                                      |
| `bigmodel`          | `volc.bigasr.sauc.duration` (1.0)  | _(unsupported on this mode)_ | byte-identical to the 2.0 row                                                                                                                                                                                                                                                                                     |
| `bigmodel` + Groq   | 2.0                                | —                            | `Project Niagara TypeScript. Chai framework. Chai deploys material way from Chai MongoDB Atlassian common.`                                                                                                                                                                                                       |
| `bigmodel_async`    | 2.0                                | —                            | **parse error** — `Unexpected token 's', "sult":{"ad"…`; frames appear to omit the sequence field our parser expects at byte 12                                                                                                                                                                                   |
| `bigmodel_nostream` | 2.0                                | _(omitted)_                  | run 1: `Project Nick and Repasa TypeScript, Chai framework to Elisia to deploy material way, Let's say Mongodb at last, and two high baricantum common.`<br>run 2: `Project Nick and Repasa TypeScript Chai framework to Elisia to deploy material way Let's I'm going to be at last and put high巴厘干坦 common` |
| `bigmodel_nostream` | 2.0                                | `th-TH`                      | `โปรเจกต์นี้เขียนด้วยภาษาไทป์สคริปต์ ใช้เฟรมเวิร์กชื่ออเลเซีย โดยดีพลอยไปที่เรลเวย์ และใช้มองโกดีบีแอทลาสเป็นผู้ให้บริการฐานข้อมูล.` _(2 runs, byte-identical)_                                                                                                                                                   |
| `bigmodel_nostream` | 2.0                                | `en-US`                      | `โปรเจกต์นี้เขียนด้วยภาษาไทป์สคริปต์ใช้เฟรมเวิร์คชื่ออเลเซียโดยดีพลอยไปที่เรลเวย์และใช้มองโกดีบีแอทลาสเป็นผู้ให้บริการฐานข้อมูล.`                                                                                                                                                                                 |

Usage reported: `byteplus:seedasr:seconds` quantity **10**, unit price `$0.0000417` → `$0.000417`.

`language` is documented as supported only on `bigmodel_nostream`, not `bigmodel`. With it omitted, the vendor documents coverage as _"Mandarin Chinese, English, Cantonese, Shanghainese, Minnan, Sichuan, Shaanxi dialect"_.

---

## OpenRouter

Run **2026-08-23**, not 2026-07-16 like the rest of this file. A single HTTP endpoint fanning out to many backing vendors: `POST https://openrouter.ai/api/v1/audio/transcriptions`, `Authorization: Bearer`, `multipart/form-data` with `model` and `file` fields. One request per model — the whole clip goes up as one WAV file, no pacing, no partials. Compared 19 models (dtinth/vxbeamer#86).

| model                                                             | output                                                                                                                                                                                                                                                                                                                         | cost      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`             | `โ ป ร เ จ ็ ก ต ์ น ี ้ เ ข ี ย น ด ้ ว ย ภ า ษ า ไ ท ป ์ ส ค ร ิ ป ใ ช ้ เ ฟ ร ม เ ว ิ ร ์ ค ช ื ่ อ เ อ เ ล เ ซ ี ย โ ด ย ด ี พ ล อ ย ไ ป ท ี ่ เ ร ล เ ว ย ์ แ ล ะ ใ ช ้ ม อ ง โ ก ด ี บ ี แ อ ต ล า ส เ ป ็ น ผ ู ้ ใ ห ้ บ ร ิ ก า ร ฐ า น ข ้ อ ม ู ล` — every character space-separated, unusable as-is                | $0.000031 |
| `mistralai/voxtral-small-24b-2507-stt`                            | `Project này được viết bằng ngôn ngữ TypeScript, sử dụng framework tên là Elysia để deploy về Railway và sử dụng MongoDB Atlas là người cung cấp cơ sở dữ liệu.` — Vietnamese, not Thai                                                                                                                                        | $0.000461 |
| `mistralai/voxtral-mini-3b-2507`                                  | `Project này viết bằng ngôn ngữ TypeScript, sử dụng framework tên là Elecia được triển khai trên Railway và sử dụng MongoDB Atlas làm cơ sở dữ liệu.` — Vietnamese, not Thai                                                                                                                                                   | $0.000154 |
| `qwen/qwen3-asr-1.7b`                                             | `โปรเจกtnี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อเอลิเซียโดยดิโพยไปที่เรลเวสและใช้มองโกดีบีแอตลาสเป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                                | $0.000069 |
| `qwen/qwen3-asr-0.6b`                                             | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Ellassay โดย Deploy ไปที่ Railway และใช้ Mongo DB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                     | $0.000031 |
| `openai/gpt-transcribe`                                           | `โปรเจกต์นี้เขียนด้วยภาษาไทป์สคริปต์ ใช้เฟรมเวิร์กชื่อ Elysia โดยดีพลอยไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                           | $0.000750 |
| `fish-audio/transcribe-1`                                         | `โปรเจกtnี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อเอลิเซียโดยดิโพยไปที่เรลเวสและใช้มองโกดีบีแอตลาสเป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                                | $0.001000 |
| `x-ai/grok-stt-1.0`                                               | first try: **error** (404) — `No endpoints available matching your guardrail restrictions and data policy`, fixed by a privacy-setting change on the account; retry: `โปรเจกต์นี้เขียนด้วยภาษาไทปสคริปต์ ใช้เฟรมเวิร์กชื่อเอลิเซียโดยดิปลอยไปที่เรลเวลและใช้มงโก้ดีบีแอทลาสเป็นผู้ให้บริการฐานข้อมูล`                          | $0.000256 |
| `deepgram/nova-3`                                                 | `Project Nikon Repaza TypeScript, Chai Framework, Shai Alesia, the deploy material way like Shai MongoDB Atlas and Puhai Baligantan Komun.` — English only, no Thai script                                                                                                                                                     | $0.000661 |
| `microsoft/mai-transcribe-1.5`                                    | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                         | $0.001000 |
| `nvidia/parakeet-tdt-0.6b-v3`                                     | `Project Nichian Repasa Type script Chi Framework Shield Alicia deploy Battery Railway La Chi Mongo DB Atlas Bent Punha Belgantan Comun.` — English only, no Thai script                                                                                                                                                       | $0.000230 |
| `mistralai/voxtral-mini-transcribe`                               | `проектни хриен дуэ пасат TypeScript, шай фреймвэрк шью Elysia дуэ деплой бай ти railway, лэ шай MongoDB Atlas бен пухэй барікан тхан хамун.` — Cyrillic transliteration, not Thai                                                                                                                                             | $0.000495 |
| `qwen/qwen3-asr-flash-2026-02-10`                                 | `โปรเจกต์นี้เขียนด้วยภาษา typescript ใช้ framework ชื่อ elixir โดย deploy ไปที่ railway และใช้ mongodb atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                        | $0.000315 |
| `google/chirp-3`                                                  | `Project นี้ เขียน ด้วย ภาษา TypeScript ใช้ Framework ชื่อ Elysia โดย Deploy ไป ที่ Railway และ ใช้ MongoDB Atlas เป็น ผู้ ให้ บริการ ฐาน ข้อ มูล` — word-space-separated Thai                                                                                                                                                 | $0.002667 |
| `openai/gpt-4o-mini-transcribe`                                   | `โปรเจคนี้เขียนด้วยภาษาไทป์สคริปต์ ใช้เฟรมเวิร์คชื่ออีเลเซีย โดยดีพลอยไปที่เรลเวย์ และใช้มองโกดีบีแอตลาสเป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                             | $0.000410 |
| `openai/whisper-large-v3-turbo`                                   | `โปรเจ็กต์นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Alixier โดย Deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                      | $0.000031 |
| `openai/whisper-large-v3`                                         | `โปรเจคนี้เขียนด้วยภาษา TypeScript ใช้ Framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                          | $0.000069 |
| `openai/whisper-1`                                                | `โปรเจคนี้เขียนด้วยภาษา TypeScript ใช้ Framework ชื่อ Elysia โดย Deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                          | $0.001000 |
| `openai/gpt-4o-transcribe`                                        | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้ Framework ชื่อ Elysia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล`                                                                                                                                                                                        | $0.000600 |
| `microsoft/mai-transcribe-2` (run **2026-09-06**, on release day) | `โพรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย deploy ไปที่ Railways และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` — two small misses: `โพรเจกต์` instead of `โปรเจกต์`, and `Railways` instead of `Railway`                                                                                              | $0.000278 |
| `meta/muse-voice-transcribe-1.0` (run **2026-09-17**)             | `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้ framework ชื่อ Elysia โดย deploy ไปที่ railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` — every word right; `framework` kept in Latin rather than transliterated (a style choice, arguably clearer, not an error), `railway` only differs from the reference by capitalization | $0.000464 |

`microsoft/mai-transcribe-1.5` is the one added as a `vxasr` configuration (`openrouter/microsoft/mai-transcribe-1.5`) — see `../packages/vxasr/src/providers/openrouter.ts`. Cost is what the vendor's `usage.cost` field reports directly, in USD, not a rate needing multiplication like every other section in this file.

`microsoft/mai-transcribe-2` costs about a third of `1.5`, but made two small errors that `1.5` did not (dtinth/vxbeamer#86). Not yet added as a configuration — the drop in accuracy needs a decision first.

`meta/muse-voice-transcribe-1.0` is the cleanest transcript of every OpenRouter model tried so far on this fixture, and costs under half of `mai-transcribe-1.5`. Added as the OpenRouter provider's default (dtinth/vxbeamer#86).

---

## Meta (direct realtime API)

Run **2026-09-18**. Same model as the OpenRouter entry above (`muse-voice-transcribe-1.0`), spoken to directly over `wss://api.meta.ai/v1/asr/realtime` instead of through OpenRouter's batch wrapper — see `../packages/vxasr/src/providers/meta-muse.ts`. `PUSH_TO_TALK` mode, `PCM_16KHZ`, no `languageBias`.

| output                                                                                                                                                                                                                                                                                                            | usage                                                                                                         | wall  | first partial |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----- | ------------- |
| `โปรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Alessia โดย deploy ไปที่ Railway และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` — two misses the OpenRouter batch route on the same model did not make: `เฟรมเวิร์ก` (transliterated) instead of `framework` in Latin, and `Elysia` came out as `Alessia` | $0.0005 (10 s billed, rounded up from the clip's 9.218 s — coarser than OpenRouter's fractional-cost billing) | 5.1 s | 2.4 s         |

Genuine streaming partials, unlike every OpenRouter model above (batch-only, no partials at all) — 24 partial updates arrived before the final. But the transcript itself is a regression from the batch route on this one clip: same underlying model, worse output. Not clear yet whether that is `PUSH_TO_TALK` mode specifically, missing `languageBias`, or just this endpoint's own defaults differing from whatever OpenRouter's wrapper sends — one run is not a verdict. Added as a configuration anyway (`meta/muse-voice-transcribe-1.0`, raw only) since the realtime partials are the whole reason this provider exists; the OpenRouter route stays available as a separate configuration for whichever a future eval favors.

---

## Paxa Labs

Run **2026-09-22** (dtinth/vxbeamer#86). `POST https://api.paxalabs.com/v1/stt`,
`Authorization: Bearer`, JSON body with the audio base64-encoded — a batch
call, no pacing, no partials. Model `paxa-stt-lite-v1-preview`. Four clips,
both `convention` values, 3 runs each.

| clip                    | output                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| English, 2.0 s          | `But it only happens sometimes.`                                                                                                        |
| Thai, 2.1 s             | `เห็นด้วยตามที่แนะนำครับผม`                                                                                                             |
| eval-set, 13.0 s        | `เออมันจะมี issue นึงที่เกี่ยวกับ sandbox provider อืมคิดว่ามีอะไรที่ต้องเคาะไหมในนั้น`                                                 |
| `test-audio.bin`, 9.2 s | `โพรเจกต์นี้เขียนด้วยภาษา TypeScript ใช้เฟรมเวิร์กชื่อ Elysia โดย deploy ไปที่ Railways และใช้ MongoDB Atlas เป็นผู้ให้บริการฐานข้อมูล` |

**Byte-identical across all three runs of every clip** — 1 distinct output
out of 3, everywhere. For comparison, `qwen3.5-omni-flash-realtime` gave 5–10
distinct out of 10 on the same clips.

It is also the only model compared in this file that needed no instruction to
avoid the defects the others have: no filler tags, no spaces between Thai
words, no English translated into Thai, and `Elysia` correct every run. Two
small misses on `test-audio.bin`, both shared with `mai-transcribe-2`:
`โพรเจกต์` for `โปรเจกต์`, and `Railways` for `Railway`.

`convention=spoken` and `convention=written` produced **identical** output on
all four clips. Per the vendor they differ on numbers (`1,250บาท` vs
`พันสองร้อยห้าสิบบาท`) and the repetition mark `ๆ`, and none of these clips
contains a number, a unit, or a repeated word — so this is a gap in the
fixtures, not a finding about the modes.

Cost: 8.33 credits per minute, 10,000 credits for ฿329 → **฿16.45/hour**
(~$0.47 at ฿35/USD).

### Realtime WebSocket

Run **2026-09-24** (dtinth/vxbeamer#86). `wss://api.paxalabs.com/v1/stt/live`,
`Authorization: Bearer` on the upgrade request, model
`paxa-stt-lite-realtime-v1-preview`. A `start` JSON frame, raw binary PCM, then
`{"type":"end"}`. See `../packages/vxasr/src/providers/paxa-realtime.ts`.

| test                                  | result                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `end` → final, realtime pacing, n=6   | **52–58 ms**. The vendor detects the end of speech, so the final often arrives before the audio ends. |
| recording cut at 5 s, mid-speech      | final 327 ms after `end`, with the text up to the cut                                                 |
| fast dump                             | accepted: 0.7 s for the 9.2 s clip, 1.0 s for a 21.4 s clip                                           |
| audio before `started`, 100 ms frames | both accepted (the docs show 20 ms frames)                                                            |
| wrong key                             | HTTP 401 on the upgrade                                                                               |
| 3 s of silence                        | `done` with `turns: 0`                                                                                |
| partials                              | about one each 3 s                                                                                    |

**A pause starts a new turn**, and each turn gets its own final `transcript`
frame: a 3 s pause between two copies of the clip gave `turn: 1` and
`turn: 2`. The adapter joins the turns into one final.

Transcript as the batch endpoint, except for `Railway`/`Railways`: with
realtime pacing, 6 of 8 finals had `Railway`; batch and fast dump had
`Railways` every time. Too few runs to call it an effect of pacing.

Charged at **12.5 credits/min** against 8.33 for batch, for the whole
connection, silence included: the 21.4 s two-turn run was charged 21.4 s.
**฿24.68/hour** (~$0.71 at ฿35/USD).

---

## Batch providers, timing compared

Run **2026-09-22** (dtinth/vxbeamer#86). All four are batch HTTP endpoints, so
this is like for like. Interleaved — each iteration calls all four back to
back, so network drift lands on every provider equally rather than on whoever
happened to run during it. 8 runs each, wall time of the whole call.

| provider                         | 2 s clip (median) | 13 s clip (median) | cost/hour  |
| -------------------------------- | ----------------- | ------------------ | ---------- |
| `paxa-stt-lite-v1-preview`       | **568 ms**        | **900 ms**         | $0.470     |
| `microsoft/mai-transcribe-2`     | 850 ms            | 952 ms             | **$0.109** |
| `microsoft/mai-transcribe-1.5`   | 1407 ms           | 1682 ms            | $0.391     |
| `meta/muse-voice-transcribe-1.0` | 1834 ms           | 3856 ms            | $0.181     |

Timing is from this machine, whose route and bandwidth are its own; the
ordering is the finding, not the absolute figures. Costs are normalised from
the per-request figures recorded above against the 9.218 s fixture.

**`muse-voice-transcribe-1.0` was the OpenRouter default until this run.** It
had been chosen on transcript quality on one fixture and never timed: it is
four times slower than the other two, and produced the worst transcript of the
three here (`อีสชู` for `issue`, and Thai transliteration where the others
keep `sandbox provider` in Latin). `mai-transcribe-2` replaced it as the
default — fastest, cheapest, and its 13 s transcript was identical to Paxa's.

Latency by clip length, Paxa alone, 10 runs each: 0.5 s → 384 ms, 2 s → 433 ms,
5 s → 568 ms, 13 s → 622 ms. Fitting those gives **~408 ms fixed plus ~18 ms
per second of audio** — overhead-dominated, so 26× the audio costs 1.6× the
time. (Measured in isolation; the interleaved figures above are higher, which
is why they are the ones quoted for comparison.)

---

## Google Gemini 3.5 Transcribe

Run **2026-09-26** (dtinth/vxbeamer#86). Tried three ways. Clips: `test-audio.bin`, the 2.0 s English and 2.1 s Thai clips, and the 13.0 s eval-set clip from the Paxa section.

| route                                         | time to final                                | partials         | cost/hour |
| --------------------------------------------- | -------------------------------------------- | ---------------- | --------- |
| OpenRouter `google/gemini-3.5-transcribe`     | 4–6 s per request, any clip length (22 runs) | none             | $0.18     |
| Gemini API batch (`v1beta/interactions`)      | 5.2–5.8 s                                    | none             | $0.30     |
| Gemini API Live, `gemini-3.5-transcribe-live` | 0.3–0.7 s after the audio ends               | about each 0.5 s | $0.54     |

OpenRouter's reported cost is the input tokens only (25 audio tokens per second at $2/1M); the Gemini API prices are from Google's pricing page. See `../packages/vxasr/src/providers/gemini-live.ts` for the Live protocol.

`test-audio.bin` was perfect on every run of all three routes, and so were the English and Thai clips. The batch model gave byte-identical output across 5 runs of each clip. On the eval-set clip the batch model wrote `อีกชู` for `issue`; `custom_vocabulary: ["issue"]` fixed it.

**Live, with the vendor's voice detection (the default).** Each pause ends a turn with its own final. After `audioStreamEnd`, a turn in progress gets its final, but if nobody is speaking the service sends nothing more. A whole clip sent at once never produced a final.

**Live, push-to-talk** (`automaticActivityDetection: {disabled: true}`, `activityStart`/`activityEnd`). One final per recording, and `ACTIVITY_END` always follows `activityEnd`, even for silence. A whole clip sent at once works: 3.3 s for the 9.2 s clip.

**Push-to-talk dropped sentences** on clips joined from separate recordings: [A] the `test-audio.bin` sentence, [B] the Thai clip, [C] the English clip. The same result on every run (3 of 3):

| clip                          | push-to-talk | push-to-talk + `SMART` | voice detection + `SMART` |
| ----------------------------- | ------------ | ---------------------- | ------------------------- |
| A, 3 s pause, B, 2 s pause, C | complete     | C dropped, B misheard  | complete                  |
| A, 0.3 s pause, B             | B misheard   | B dropped              | complete                  |
| eval-set clip                 | complete     | complete               | complete                  |

"Misheard" is `เขียนด้วย` for `เห็นด้วย`. Push-to-talk + `SMART` + `customVocabulary: ["issue"]` also dropped the second half of the eval-set clip (4 of 4). Push-to-talk + `SMART` is what the `gemini` configuration uses, chosen with this known (dtinth/vxbeamer#86).

---

## Microsoft MAI-Transcribe-2 Streaming (Vercel AI Gateway)

Run **2026-10-02** (dtinth/vxbeamer#86). `microsoft/mai-transcribe-2-streaming`, offered only through the Vercel AI Gateway, reached with the AI SDK's `experimental_streamTranscribe` (`ai` 7.0.127, `@ai-sdk/gateway` 4.0.103), PCM 16 kHz. See `../packages/vxasr/src/providers/ai-gateway.ts`.

| clip                                           | final after the audio ends | transcript                                                                                  |
| ---------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `test-audio.bin`, realtime, n=5                | 342–491 ms                 | as batch `mai-transcribe-2`: correct except `Railways`; `framework` in Latin or Thai varies |
| `test-audio.bin`, fast dump                    | 3.2 s                      | the same                                                                                    |
| A, 3 s pause, B, 2 s pause, C (Gemini section) | 348 ms                     | **all three sentences**                                                                     |
| A, 0.3 s pause, B                              | 433 ms                     | both sentences, `เห็นด้วย` correct                                                          |
| the same sentence twice, 3 s pause             | 349 ms                     | both copies                                                                                 |
| eval-set clip, 13.0 s                          | 352 ms                     | `เอ่อมันจะมี issue นึงที่...` (fillers kept, `issue` correct)                               |
| English 2.0 s / Thai 2.1 s                     | 345 / 329 ms               | both correct                                                                                |
| 3 s of silence                                 | 344 ms                     | empty final                                                                                 |

Partials come about every 0.3 s (31 on the 9.2 s clip). The stream gives `transcript-delta` (finalized text) and `transcript-partial` (the provisional text _after_ the latest delta), then one `transcript-final` with the whole transcript once the input ends.

For silence, the SDK's `text` promise rejects with "No transcript generated" even though `fullStream` ended cleanly with an empty final.

After the stream finishes, the SDK closes the WebSocket with code 1000, but its TLS socket stays open for about 10 s more before it closes. A short CLI run therefore exits about 10 s after printing its transcript.

$0.54 per hour of audio (the gateway's listed price).

---

## Typhoon (SCB 10X)

Run **2026-09-12**. Same OpenAI-compatible transcription shape as OpenRouter: `POST https://api.opentyphoon.ai/v1/audio/transcriptions`, `Authorization: Bearer`, `multipart/form-data` with `model` and `file`. One request, no pacing, no partials (dtinth/vxbeamer#86).

| model                  | output                                                                                                                                                                                                                                                                                            | usage                                                                      | wall  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----- |
| `typhoon-asr-realtime` | `โปรเจกต์นี้เขียนด้วยภาษา Thaiscribe ใช้เฟรมวิกชื่อเอเลเซียโดย Deply ไปที่ Realway และใช้ mango Debe Adlus เป็นผู้ให้บริการฐานข้อมูล` — every English loanword garbled: `TypeScript`→`Thaiscribe`, `Elysia`→`เอเลเซีย`, `deploy`→`Deply`, `Railway`→`Realway`, `MongoDB Atlas`→`mango Debe Adlus` | 460 input (audio) + 74 output = 534 tokens, no cost figure in the response | 1.6 s |

The response carries no dollar cost, only a token count (`usage.type: "tokens"`) — the docs don't publish per-token pricing either. Not added as a configuration: on this fixture every English technical term came out wrong, worse than every other Thai-capable model already compared above.

---

## Repeat runs

Identical input, repeated. **These are the same request each time.**

### `qwen3-asr-flash-realtime`, pacing compared, n=3 each

| pacing                  | wall   | outputs (first word)        |
| ----------------------- | ------ | --------------------------- |
| fast dump (no delay)    | 0.65 s | `โปรเจกต์` ×3               |
| realtime (100 ms/chunk) | 9.49 s | `project` ×2, `โปรเจกต์` ×1 |

Partial counts: 56 (fast dump) vs 84 (realtime). Usage quantity **10** in both — billing did not change with wall time.

Fisher's exact on 3/3 vs 1/3 ≈ **0.4**; this sample does not establish a pacing effect.

### `qwen3-asr-flash-realtime` + Groq, realtime, n=3

| run | output (first word) |
| --- | ------------------- |
| 1   | `project`           |
| 2   | `project`           |
| 3   | `โปรเจกต์`          |

Same audio, same configuration, same pacing.

### `qwen3.5-omni-flash-realtime-2026-03-15`, prompt compared, n=10 each

Run **2026-09-20** (dtinth/vxbeamer#86). Three clips, four instructions, ten
runs each. Two defects counted separately: `<fil>` filler tags with
slash-separated alternate readings (`Issue/อิชชู`), and spaces inserted
between Thai words, which Thai does not use.

Clip A is a 13.0 s eval-set recording that reproduces the tags; clip B is a
2.1 s Thai clip that reproduces the spacing; clip C is `test-audio.bin`, kept
as a control because its English technical terms _need_ their surrounding
spaces.

| instruction                                                  | A: tags  | A: alternates | B: spaces        | C: Latin terms |
| ------------------------------------------------------------ | -------- | ------------- | ---------------- | -------------- |
| `Transcribe the user's audio verbatim…` (previous)           | 10/10    | 10/10         | 3 per run, 10/10 | preserved      |
| previous + Thai/Latin script rule                            | 10/10    | 10/10         | 0/10             | preserved      |
| previous + script rule + "never output tags such as `<fil>`" | 10/10    | 10/10         | —                | preserved      |
| `Write out exactly the words the speaker says…` (current)    | **0/10** | **0/10**      | **0/10**         | preserved      |

**Forbidding the behaviour did not work.** Adding "never output tags in angle
brackets such as `<fil>`" to the old wording left it at 10/10. Removing the
word _transcribe_ did, taking both defects to 0/10 — the working theory being
that "transcribe … verbatim" selects a transcription-annotation register where
those tags belong, and naming the token without leaving that register may
prime it.

Incidental, on clip C: the previous wording returned `Alecia` / `Alesia` /
`Elysia` across runs, the current wording `Elysia` in all ten. One fixture and
not what the instruction was aimed at, so noted rather than claimed.

**A first version of the new wording translated English into Thai.** It stated
the Thai script rule unconditionally, which reads as a claim about the output
rather than a rule about Thai. Re-run on a 2.0 s English clip, n=10:

| instruction                                     | output in Thai script | transcript                                            |
| ----------------------------------------------- | --------------------- | ----------------------------------------------------- |
| `Transcribe … verbatim` (older)                 | 0/10                  | `But it only happens sometimes.`                      |
| unconditional Thai rule                         | **10/10**             | `แต่มันเกิดขึ้นแค่บางครั้ง` and four other renderings |
| current, language named + Thai rule conditional | 0/10                  | `But it only happens sometimes.`                      |

The current wording holds every result above on the Thai clips while fixing
this, so the language clause costs nothing. A prompt that describes the
expected output in one language will produce that language.

Counting caveat: "spaces between Thai words" counts any space with Thai on
both sides, but Thai does use spaces at clause boundaries. On clip A the two
remaining spaces sit around the fillers `เออ` and `อืม`, which is correct
typography rather than the defect.

---

## Errors and timeouts observed

| what                                                                | result                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| BytePlus `bigmodel`, audio dumped as fast as the socket accepted    | **60 s timeout, no final** — vendor docs specify a 100–200 ms send interval |
| `qwen3-omni-flash-realtime` on the Qwen realtime protocol           | 60 s timeout, no result                                                     |
| `fun-asr-realtime-2026-02-28`                                       | `task-failed` / `ModelNotFound` — the vendor's model list documents this id |
| DashScope intl key against Beijing (`wss://dashscope.aliyuncs.com`) | **401 at the WS handshake** — keys are region-scoped                        |

## Vendor-documented language support, for comparison

From the Model Studio model list. Recorded because some rows above differ from it.

| model                                             | documented languages                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `qwen3-asr-flash-realtime` (all snapshots)        | incl. **Thai**                                                       |
| `fun-asr-realtime`, `fun-asr-realtime-2025-11-07` | incl. **Thai**                                                       |
| `fun-asr-realtime-2026-02-28`                     | Chinese, English, Japanese                                           |
| `fun-asr-realtime-2025-09-15`                     | Chinese, English                                                     |
| `paraformer-realtime-v2`                          | zh, en, ja, yue, ko, de, fr, ru                                      |
| BytePlus, `language` omitted                      | Mandarin, English, Cantonese, Shanghainese, Minnan, Sichuan, Shaanxi |

## Reproducing

```bash
vp run vxasr#build
node --env-file=.env packages/vxasr/dist/cli.mjs <configuration-id> testdata/test-audio.bin
```

`vxasr --list` shows the configuration ids.

Rows the shipped CLI **can** reproduce: the pinned Qwen snapshots (raw and `+groq`), `byteplus/bigmodel_nostream` with `BYTEPLUS_LANGUAGE=th-TH`, and the Qwen Omni **realtime** rows under `qwen-omni/…` — the undated ids in the table below are now pinned to `qwen3.5-omni-flash-realtime-2026-03-15`, `qwen3.5-omni-plus-realtime-2026-03-15`, and `qwen3-omni-flash-realtime-2025-12-01`.

Rows it **cannot**: the floating `qwen3-asr-flash-realtime` id and `byteplus/bigmodel` (both removed from the catalogue), the Qwen Omni **offline** rows and the transcription-sub-service rows (no adapter — the sub-service is deliberately silenced), and everything under Fun-ASR. Those came from throwaway scripts against the same endpoints.
