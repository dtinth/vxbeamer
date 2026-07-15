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

Contrast BytePlus, which **hangs outright** under a fast dump (see its section).
This model has no VAD in this configuration (`turn_detection: null`), so there is
no wall-clock endpointing to disturb.

Cost is unaffected by pacing: this model bills per token, not per second.

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
