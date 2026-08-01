---
"backend": patch
---

Fix a vendor-connection leak: a client that disconnects mid-recording without ever sending `stop` (an unstable connection, a backgrounded app) could pin its upstream vendor connection open indefinitely, since the graceful `finish()` shutdown waits for a terminal event the vendor isn't guaranteed to send. Enough of those exhaust the vendor's per-account connection cap ("connections too much max_connections 100") for every user. `onClose` now arms a bounded fallback — reusing the existing idle-watchdog mechanism — that force-closes the session and marks the message as errored if the vendor hasn't responded within `WS_IDLE_TIMEOUT_MS` of the client disconnecting.
