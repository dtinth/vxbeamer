---
"vxasr": minor
---

Add the Qwen Omni Realtime models as a `qwen-omni` provider, with three pinned configurations.

These are not ASR models — they are omni-modal chat models that happen to hear, and they produce the best transcript measured on the Thai test fixture: Thai words in Thai and product names in Latin (`โปรเจกต์นี้เขียนด้วยภาษา TypeScript … ใช้เฟรมเวิร์กชื่อ Elysia`), a hybrid neither the ASR models nor BytePlus render.

They speak their **own protocol**, not the Qwen ASR realtime one: the turn ends with `input_audio_buffer.commit` + `response.create`, the transcript arrives on `response.text.delta`/`.done`, and there is no `session.finish` — sending it is why the `qwen` provider times out against these models. That, plus token-based billing at per-model rates, is why this is a separate provider id rather than more models under `qwen`: one provider id means one wire protocol.

Selectable configurations, **raw only** — these models already produce what the Groq enhancement is reaching for, so a `+groq` variant would spend an LLM call and a vote slot to change nothing:

- `qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15` (the provider's default)
- `qwen-omni/qwen3.5-omni-plus-realtime-2026-03-15`
- `qwen-omni/qwen3-omni-flash-realtime-2025-12-01`

All three are pinned to dated snapshots from the vendor's model list, so the no-floating-ids rule needed no exemption. Credentials are the existing `DASHSCOPE_API_KEY`.

Usage is reported in **tokens**, with audio input, text input and text output priced separately (the vendor charges different rates for audio and text input) at each model's own rates. Reporting measured tokens rather than estimating from duration is what makes it visible that `qwen3-omni-flash-realtime` costs ~58% more per recording than `qwen3.5-omni-flash-realtime` despite near-identical rates — the older generation tokenises the same audio far less efficiently.
