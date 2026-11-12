---
"vxasr": minor
---

Add the `qwen-audio` provider with `qwen-audio-3.1-asr-flash-message` and `qwen-audio-3.1-asr-flash-streaming`. It speaks DashScope's duplex `run-task` protocol (a third Qwen wire format) and, unlike the Omni models, transcribes while the audio is still arriving. Both are served only from a workspace-specific endpoint, so they need `DASHSCOPE_WORKSPACE_ID`, and the vendor lists no dated snapshot for either. Priced at $0.93 input / $0.70 output per 1M tokens (Singapore), from the vendor's pricing page.
