---
"website": patch
---

Add a hidden test-audio mode. Set `localStorage.vxbeamer_test_audio_url` to turn it on. When on, the record button replays a saved audio clip, at the same pace as a live recording, instead of using the microphone. This helps you test the record flow on a device with no real microphone, such as an automated browser test.

This change also fixes a bug. Before, the `audioProcessingMode` setting — which controls noise suppression, echo cancellation, and auto gain — was silently never applied to real microphone recordings.
