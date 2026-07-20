---
"vxasr": patch
"backend": patch
---

Reclaim upstream vendor connections: kick idle sockets and always tear down on error

The realtime vendors cap concurrent connections per account ("connections too
much max_connections 100"), and each `/ws` (and `/asr/eval`) socket holds one of
those open for its whole life. Two gaps let those connections leak until the cap
was hit:

- **No way to hang up an abandoned session.** `ASRSession` only exposed
  `sendAudio()` and `finish()`, and `finish()` is _graceful_ — it waits for the
  vendor's terminal event, which never comes for a socket that has simply gone
  silent. `ASRSession.close()` is new: an immediate, idempotent teardown that
  `terminate()`s the vendor socket and emits no further callbacks, so a session
  that can no longer produce a transcript releases its slot rather than holding
  it until the vendor reaps it.

- **Error paths left the socket open.** Every provider's `ws.on("error")` now
  closes the socket, and Qwen now hangs up on a vendor `error` frame the way
  BytePlus and Qwen-Omni already did — previously it did not, so a
  "max_connections" error frame itself leaked another connection, compounding the
  very condition it reported.

Idle-kicking is now enforced at the socket layer: a watchdog, armed when the
vendor session opens and deferred on every audio frame, closes the client and
aborts the vendor session after `WS_IDLE_TIMEOUT_MS` of silence (default 60s; a
non-positive value disables it). It watches _audio_, not liveness, so a client
that keeps the socket open but stops speaking is still reclaimed. The watchdog is
disarmed on `stop`, since finalisation is the vendor's clock, not the client's.
