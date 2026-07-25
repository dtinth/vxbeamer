---
"website": patch
---

Speed up the eval dialog by pacing each configuration's audio replay at its own provider's confirmed rate instead of one shared realtime rate. Every provider currently in the catalogue (Qwen ASR, Qwen Omni, BytePlus) was fast-dump tested and tolerates the whole clip sent back-to-back, so an eval now finishes in ~1-2s instead of waiting out the clip's full length. An untested provider still defaults to realtime pacing.
