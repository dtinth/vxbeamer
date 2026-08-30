---
"vxasr": minor
"backend": patch
"website": patch
---

Let a `qwen-omni` vendor connection stay open for reuse by the same client. Before, the app always closed the connection after each turn. Now, if the same client starts a new, short recording soon after, it can reuse the same connection. This lets the model keep its earlier conversation context.

This feature is opt-in. It uses a new `clientId` field on `ASRCreateSessionOptions`. Every other provider ignores this field — for them, nothing changes. The website sends one client ID for each page load. It does not save this ID, so reloading the page always starts fresh. The backend combines this ID with your login, so two different accounts can never share the same open connection.

The app closes an idle connection, instead of keeping it open, once one of two limits is reached: the connection has been idle longer than `QWEN_OMNI_STICKY_LINGER_MS` (30 seconds by default), or the total audio sent on it has passed `QWEN_OMNI_STICKY_MAX_AUDIO_SECONDS` (180 seconds by default). This second limit keeps token cost and conversation size from growing without a limit.
