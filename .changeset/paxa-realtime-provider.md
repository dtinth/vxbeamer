---
"vxasr": minor
---

Add `paxa/paxa-stt-lite-realtime-v1-preview`, Paxa Labs' realtime WebSocket, next to the batch model under the same `paxa` provider and key.

The vendor detects the end of speech itself, so the final transcript arrives about 55 ms after the recording ends, against 0.6–0.9 s for the batch call. It also splits a recording into turns at each pause, with one final per turn; the adapter joins them, so a pause does not drop the text before it. It costs 12.5 credits a minute against 8.33 for batch, and the whole connection is charged, silence included.
