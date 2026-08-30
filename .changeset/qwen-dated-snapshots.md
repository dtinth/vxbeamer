---
"vxasr": minor
---

Change every Qwen model ID to a dated, fixed version. Remove the old, undated `qwen3-asr-flash-realtime` ID.

An undated model ID can change without warning — the vendor can point it to a new model version at any time. So, the app's output could change even when nothing in this project's code has changed. A vote could then end up naming a model that no longer exists in that form. This is not a small risk. Fun-ASR shows a real case: its newest version silently stopped supporting Thai. An undated ID would have quietly broken a language, with no warning.

You can now select `qwen3-asr-flash-realtime-2025-10-27` and `qwen3-asr-flash-realtime-2026-02-10`. Each is available raw or with `+groq`. The main, default model is now `2025-10-27+groq`. This is the version the old, undated ID pointed to right before this change. So, behavior for existing users does not change — only the model version is now fixed in place.

**Breaking change**: If you set `ASR_MODEL=qwen3-asr-flash-realtime`, this will now fail. That ID no longer exists. You must set a dated version instead.
