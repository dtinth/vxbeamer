---
"vxasr": minor
---

Add a `vxasr` command-line tool. It runs one model configuration against an audio file. It needs no server, no browser, and no microphone.

It accepts a WAV file or raw PCM audio (16 kHz, 16-bit, mono). It checks the file content to detect WAV format. It does not rely on the file extension. It prints the transcript to stdout. It prints the cost of each processing layer to stderr. This lets you see what each layer charged.

By default, the tool sends audio at real-time speed. Use `--fast` only to test faster sending. Fast sending does not show real-time behavior.

This change also replaces the package README file. The old file was still the unused template text.
