---
"website": patch
---

Auto-retry a failed recording connection. When the initial `/ws` connect fails or times out, the app now retries up to 3 times, one second apart, before showing the tap-to-retry error bubble. Most failures are a brief blip and now resolve on their own without interrupting the recording.
