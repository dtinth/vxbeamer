---
"backend": patch
"website": patch
---

Add the Eval dialog. It replays a recording through every model configuration. You then pick the best result.

If a finished message still has its audio in memory, the app now shows an **Eval** option. The dialog opens one WebSocket connection for each configuration. It replays the saved audio through all of them at the same time. It shows each configuration's text as it arrives. You read the results and tap the one you prefer. That result then replaces the message's main answer.

- **`/asr/eval`** (on the backend) transcribes audio without writing to the message log. This is a separate route, in its own code module. This module cannot import the message store. This design guarantees that an eval run creates no message (see issue dtinth/vxbeamer#38). This is a structural rule, not just a setting. Results return down the same socket, since only the frontend needs an eval run's results.
- **Each replay runs at 1x speed.** The app sends one 3200-byte audio frame every 100 ms, per socket, once that socket is ready. This is not something to speed up: BytePlus stops responding if you send audio faster than real time. Also, billing is based on audio duration, not connection time, so slower sending costs nothing extra. Because all sockets run at the same time, one eval run takes about as long as the audio clip itself, no matter how many configurations you compare.
- **Each configuration runs only once** per eval. There are no repeat runs, no averaging, and no confidence scores. The real signal comes from votes across many messages over time, not from one eval run.
- Some rows will not show live text (a model that returns one final result). Other rows cannot run at all (the server has no credentials for that configuration). The app shows both of these cases plainly. It does not treat them as errors.
