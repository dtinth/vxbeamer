---
"website": patch
---

Speed up the eval dialog. Each model configuration's audio now replays at a speed confirmed to work for its own vendor, instead of one shared real-time speed. Every provider in the current list (Qwen ASR, Qwen Omni, BytePlus) was tested. Each one accepts the whole audio clip sent all at once. So, an eval now finishes in about 1 to 2 seconds. Before, it took as long as the audio clip itself. A provider that has not been tested this way still uses the slower, real-time speed by default.
