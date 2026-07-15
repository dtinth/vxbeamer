---
"vxasr": minor
---

Pin every Qwen model to a dated snapshot and drop the floating `qwen3-asr-flash-realtime` id.

Undated ids float — the vendor repoints them without notice — so a transcript could change with nothing in this repo changing, and a vote would name a moving target. Fun-ASR shows this is not theoretical: its newest snapshot dropped Thai outright, which a floating id would have delivered as a language quietly ceasing to work.

Selectable configurations are now `qwen3-asr-flash-realtime-2025-10-27` and `-2026-02-10`, each raw and `+groq`. The primary derives to `2025-10-27+groq` — what the floating id resolved to when it was dropped — so behaviour is unchanged, only pinned.

**Breaking for anyone setting `ASR_MODEL=qwen3-asr-flash-realtime`**: that id no longer exists; name a dated snapshot.
