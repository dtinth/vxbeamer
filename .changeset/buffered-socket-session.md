---
"vxasr": patch
"backend": patch
"website": patch
---

Move shared code out of three ASR providers into one place.

Qwen, Qwen-Omni, and BytePlus each had about 35 lines of the same code. This code managed the buffer state, the chunk-send loop, a timing issue at the start, the error handler, and the `close()` function. Over time, the three copies had started to differ from each other (see issue dtinth/vxbeamer#72).

This code now lives in one function: `createBufferedSocketSession`. Each provider now supplies only its own vendor-specific parts: the handshake, the audio format, the turn-end signal, and the message parser. Each provider still counts its own bytes for billing. This matters because Qwen-Omni bills by token, not by audio time.

This change also fixes a bug in `finish()`. BytePlus checked if the socket was open before it tried to end a turn. Qwen and Qwen-Omni did not have this check. So, if the socket had an error after it opened, and then you called `finish()`, Qwen and Qwen-Omni would report a false error. The check now lives in the shared function. It applies to all three providers.

This change also merges three smaller pieces of duplicate code. There is no change in behavior.

- `readAudioFrame` and `isStopMessage`: These functions decode binary audio frames and detect stop messages. The recording socket and the eval socket now share this code. The decoder does not touch the message log. This keeps the eval socket separate from the message store, as required.
- `buildBackendSocketUrl`: This function builds a `ws` or `wss` URL from an `http` or `https` URL. The recording bar and the eval feature now share this code.
- `concatChunks`: This function joins audio chunks into one buffer. The WAV writer and the eval frame splitter now share this code.
