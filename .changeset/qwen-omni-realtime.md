---
"vxasr": minor
---

Add the Qwen Omni Realtime models as a new provider, called `qwen-omni`. It has three fixed configurations you can select.

These are not speech-to-text models. They are general chat models that can also hear audio. On the Thai test audio file, they give the best result of all providers tested. They write Thai words in Thai script, and product names in Latin script (for example: `โปรเจกต์นี้เขียนด้วยภาษา TypeScript … ใช้เฟรมเวิร์กชื่อ Elysia`). No other tested model, including BytePlus, mixes scripts this way.

These models use their **own message format**. They do not use the same format as the regular Qwen speech-to-text models. A turn ends with two messages: `input_audio_buffer.commit`, then `response.create`. The transcript arrives in `response.text.delta` and `response.text.done` messages. There is no `session.finish` message — if you send one, the connection to these models times out. Billing also works differently: it is based on tokens used, at rates that differ by model. For these reasons, this is a new, separate provider. It is not added as new models under the existing `qwen` provider. One provider matches one message format.

You can select these configurations. All are **raw only** — with no `+groq` cleanup step. These models already produce clean output, so a Groq cleanup step would cost an extra AI call and a vote choice, for no real gain:

- `qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15` (the default model)
- `qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15`
- `qwen-omni/qwen3-omni-flash-realtime-2025-12-01`

All three use fixed, dated model versions from the vendor's own model list. So, the rule against undated model IDs needed no exception here. These models use the same setting as before: `DASHSCOPE_API_KEY`.

Usage is measured and reported in **tokens**. Audio input, text input, and text output are each billed at their own rate, since the vendor charges different rates for audio and text. Reporting the real, measured token count — instead of estimating from audio length — reveals a real cost difference: `qwen3-omni-flash-realtime` costs about 58% more per recording than `qwen3.5-omni-flash-realtime`, even though their listed rates are almost the same. This is because the older model needs more tokens to represent the same audio.
