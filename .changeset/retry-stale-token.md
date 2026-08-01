---
"website": patch
---

Fix retry doing nothing on a connection that failed a while ago: it was reusing the access token captured at the original connect attempt, which the backend's `/ws` upgrade rejects outright once expired — reading as a silent no-op rather than a real retry. A retry now fetches a fresh token before reconnecting, the same as every other authenticated call.
