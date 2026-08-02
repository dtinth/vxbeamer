---
"vxasr": minor
"backend": patch
"website": patch
---

Let a `qwen-omni` vendor connection linger for reuse by the same client instead of always closing when a turn ends, so consecutive short recordings from one client can share the vendor's conversation context. Opt-in via a new `clientId` on `ASRCreateSessionOptions` — every other provider ignores it, unchanged. The website sends one client id per page load (not persisted, so a refresh always starts clean); the backend scopes it to the authenticated subject so two accounts never share a pooled connection. A lingering connection is retired instead of reused once it sits idle past `QWEN_OMNI_STICKY_LINGER_MS` (default 30s) or its accumulated input audio crosses `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (default 180s, bounding token cost and context growth).
