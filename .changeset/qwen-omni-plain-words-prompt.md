---
"vxasr": minor
---

Change the Qwen Omni instruction so the model writes plain text rather than an annotated transcription. Asking it to "transcribe verbatim" produced `<fil>` filler tags, slash-separated alternate readings, and Thai split into space-separated words, in 10 runs out of 10; forbidding those explicitly did not help, while dropping the word "transcribe" took all three to 0 out of 10. The new wording also states the Thai and Latin script rules, which a blunter instruction would have broken. Measured over three clips, ten runs each — see `testdata/OBSERVATIONS.md`.
