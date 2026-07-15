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
| `qwen3-omni-flash-realtime`           | **no result** — 60 s timeout on this protocol                                                                                            |

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

`qwen3-omni-flash-realtime` was also tried against the **Qwen realtime WS
protocol** and timed out; see the Qwen table above. These offline rows are a
different endpoint and a different protocol.

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

Rows the shipped CLI **can** reproduce: the pinned Qwen snapshots (raw and `+groq`), and `byteplus/bigmodel_nostream` with `BYTEPLUS_LANGUAGE=th-TH`.

Rows it **cannot**: the floating `qwen3-asr-flash-realtime` id and `byteplus/bigmodel` (both removed from the catalogue), and everything under Fun-ASR and Qwen Omni (no adapter exists). Those came from throwaway scripts against the same endpoints.
