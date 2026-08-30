---
"vxasr": patch
"backend": patch
---

Reclaim vendor connections. Close idle connections. Always close a connection after an error.

Each speech vendor allows only a limited number of open connections per account. The error for this is: "connections too much max_connections 100". Every `/ws` and `/asr/eval` connection holds one of these open for its whole life. Two gaps let these connections leak, until the account hit that limit:

- **There was no way to close an abandoned session.** The `ASRSession` type only had `sendAudio()` and `finish()`. The `finish()` function waits for the vendor to send a final message. But if the connection has gone silent, the vendor may never send that message. This change adds `ASRSession.close()`. This function closes the connection right away. It is safe to call more than once. It sends no more updates after you call it. This lets the app free up a vendor connection slot, instead of waiting for the vendor to notice and close it first.

- **An error did not always close the connection.** Now, every provider's `ws.on("error")` handler closes the socket. Also, the Qwen provider now closes its connection after a vendor error message, the same way BytePlus and Qwen-Omni already did. Before, a "max_connections" error itself could leak another connection — making the same problem it was reporting even worse.

The app now also closes an idle connection automatically. A timer starts when the vendor session opens. Each new audio frame resets this timer. If `WS_IDLE_TIMEOUT_MS` passes with no new audio (60 seconds, by default), the app closes both the client connection and the vendor connection. Set this value to 0 or less to turn this feature off. This timer checks for silence, not just an open connection — so a client that stays connected but stops sending audio is still cleaned up. This timer turns off once you send a `stop` message, since after that, the vendor controls the pace, not the client.
