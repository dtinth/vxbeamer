---
"backend": patch
"website": patch
---

Add the Eval dialog: replay a recording against every configuration and pick a winner

A finished message whose audio is still in memory now offers **Eval**. The dialog
opens one WebSocket per configuration, replays the retained PCM through all of
them in parallel, and streams each configuration's interim text as it arrives.
The user reads the results and taps the one they like; it replaces the message's
primary answer.

- **`/asr/eval`** (backend) transcribes without a message log behind it. It is a
  separate route in its own module that cannot import the store, so "an eval run
  creates no message" (dtinth/vxbeamer#38) holds structurally rather than by a
  flag. Results come back down the socket, since the frontend is the only place
  an eval run exists.
- **Replay is paced at 1x** — one 3200-byte frame per 100 ms, per socket, from
  that socket's own `ready`. Not an optimisation target: BytePlus hangs outright
  on a fast dump, and billing is per audio-second, so pacing is free. Because the
  sockets run in parallel, a run takes the clip's own duration however many
  configurations are on the ballot.
- **Each configuration runs once.** No repeat runs, no averaging, no confidence
  indicators — the signal is the vote stream across many messages, not one eval.
- Rows that will not stream (a buffering batch adapter) or cannot run (a
  configuration the server has no credentials for) are shown rather than hidden,
  and neither is dressed up as a fault.
