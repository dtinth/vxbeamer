---
"backend": patch
---

Fix a leak of vendor connections.

Before, if a client disconnected during a recording, without sending a `stop` message first, the server could keep the vendor connection open forever. This could happen with an unstable network, or an app moved to the background. The server's `finish()` function waits for a message from the vendor. But the vendor is not required to send that message. If enough of these connections leaked, the account hit its vendor connection limit. The error for this is: "connections too much max_connections 100". This affects every user of the account.

Now, when the client disconnects (`onClose`), the server starts a timer. This reuses the existing idle-watchdog timer code. If the vendor does not respond within `WS_IDLE_TIMEOUT_MS`, the server force-closes the session. It also marks the message as an error.
