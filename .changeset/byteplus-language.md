---
"vxasr": minor
"backend": minor
---

Make BytePlus able to transcribe the language it is actually spoken to.

The adapter connected to `/api/v3/sauc/bigmodel`, the bi-directional streaming mode. That mode does not accept a `language` field — the vendor documents it as "only for streaming input mode `/api/v3/sauc/bigmodel_nostream`" — and with no language it covers Mandarin, English and a few Chinese dialects only. Thai was never reachable from it. It did not fail; it returned confident nonsense (`project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。`), which is the worst way to be wrong in an eval a human judges by reading.

**The mode is modelled as a model.** BytePlus exposes each mode at its own endpoint path, so `byteplus/bigmodel_nostream` and `byteplus/bigmodel` are two entries in the provider's allowlist and two configuration ids. The two hear different languages from the same audio, which makes them different things to evaluate — and a vote has to be able to name which one it was for. `model_name` stays `bigmodel` on the wire for both: the vendor names the model that, and distinguishes the modes by path.

**The language is configurable via `BYTEPLUS_LANGUAGE`** (e.g. `th-TH`), read in the provider's `resolveConfig` and sent in the `audio` object, not `request`. It is deliberately provider-specific rather than a shared `ASR_LANGUAGE`: the value space is the vendor's own, Qwen takes no language at all and auto-detects, and per-provider language configuration is still an open question on the eval map — a cross-provider variable would settle it for every vendor as a side effect of this fix. The language is sent only on modes that declare support for it, so `bigmodel` never receives a field the vendor rejects.

**The `byteplus/bigmodel` configurations are retired.** A candidate that cannot be told the speaker's language is not a candidate, it is a wasted vendor call — and `bigmodel+groq` was worse, because the enhancement rewrote the nonsense into fluent prose that reads like a real answer. The provider still _serves_ `bigmodel`, so a Mandarin/English deployment can declare a configuration for it without touching the adapter; it is simply not offered by default.

Note the trade: `bigmodel_nostream` returns results only after 15 s of audio or the final packet, so it emits few or no partials. It is accuracy-tuned rather than low-latency, which suits eval (only the final matters) better than the live primary path.

Also fixes a hang: a clip that called `finish()` before the socket finished opening had its last packet dropped, so the turn never ended.
