---
"website": patch
---

Add a hidden test-audio mode: setting `localStorage.vxbeamer_test_audio_url` makes the record button replay a pre-recorded PCM clip, paced like a live capture, instead of opening the microphone — for exercising the record flow in environments with no mic (e.g. a headless browser). Also fixes a pre-existing bug where `audioProcessingMode` (noise suppression / echo cancellation / auto gain) was silently never applied to real microphone recordings.
