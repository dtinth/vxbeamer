---
"vxasr": patch
"backend": patch
"website": patch
---

Extract the shared streaming-WebSocket plumbing from the three providers

Qwen, Qwen-Omni and BytePlus each carried ~35 lines of identical session
plumbing — buffer/ready/finishing state, the chunk-flush loop, the
pre-open-finish race, the error handler, and (since the connection-cleanup
work) `close()` — and the three copies had already drifted (dtinth/vxbeamer#72).
That plumbing now lives once in `createBufferedSocketSession`; each provider
supplies only what is genuinely per-vendor: the handshake, frame encoding,
turn-end, and message parsing. Byte accounting stays with the provider, so a
token-billed vendor (Qwen-Omni) is never forced into the per-audio-second
assumption the other two make.

This also settles the `finish()` drift the duplication had produced: BytePlus
guarded the turn-end with a socket-open check that Qwen and Qwen-Omni lacked, so
finishing those two after a post-open socket error fired a spurious `onError`.
The guard now lives in the shared helper and applies to all three.

Alongside, three smaller copies collapse (no behaviour change):

- `readAudioFrame` / `isStopMessage` — the binary-frame decode (including the
  `byteOffset`/`byteLength` care) and the `stop`-message parse shared by the
  recording and eval sockets. The decoder reaches nothing in the message log, so
  the eval socket's isolation from the store is preserved.
- `buildBackendSocketUrl` — the `http(s)`→`ws(s)` URL build shared by the
  recording bar and the eval fan-out.
- `concatChunks` — the retained-chunk flatten shared by the WAV writer and the
  eval frame re-cutter.
