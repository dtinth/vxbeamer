# vxbeamer

vxbeamer is a self-hosted, personal speech transcriber with a real-time web interface.

I speak into my phone. The voice message is instantly transcribed. Then I can swipe on my phone to beam the transcription to my laptop. [Watch the demo video](https://github.com/user-attachments/assets/ff6188ed-3d5c-4d0d-bbf1-a39916091e2a).

## Overview

For most of my transcription needs, I use [Google Gemini](https://ai.google.dev/gemini-api/docs/audio) (through the [@lsnr](https://dt.in.th/Lsnr) LINE bot) as it provides the highest accuracy. However, it comes with high latency, which makes it somewhat frustrating to use for voice typing scenarios. _(It has very high throughput though, e.g., 15 minutes of audio content can be transcribed in less than 20 seconds.)_

vxbeamer uses a different workflow: It uses [Qwen3.5 Omni](https://qwen.ai/blog?id=qwen3.5-omni) [Realtime](https://www.alibabacloud.com/help/en/model-studio/realtime) (via [Alibaba Cloud Model Studio](https://modelstudio.alibabacloud.com/)) to transcribe speech in real-time. This trades some accuracy for significantly faster feedback.

The frontend is a PWA that can be added to the home screen. Tap the record button to transcribe, swipe right to broadcast a transcription as an event (for custom integrations), and swipe left to delete it.

This project is primarily for personal use and is not designed to be particularly flexible. That said, the setup is documented here: start with {doc}`getting-started`.

## Architecture

```{image} images/architecture.png
:alt: vxbeamer architecture diagram including desktop app
```

- **Frontend** — React PWA (`apps/website`), deployed statically (hosted on Vercel)
- **Backend** — Node.js/Hono server (`apps/backend`), deployed via Docker (self-hosted)
- **Desktop app** — Tauri desktop client (`apps/desktop`) that receives backend events and integrates with the local machine (basically, it’s the frontend web app with extra desktop integrations)
- **ASR** — any of the providers on the {doc}`asr-configurations` page. The default is `qwen` (Qwen3-ASR-Flash Realtime via DashScope, Alibaba Cloud); the overview above describes Qwen Omni Realtime, which `ASR_PROVIDER=qwen-omni` selects
- **Post-processing** — optional; gpt-oss-120b via Groq, for configurations whose output needs formatting cleanup (not needed for Qwen Omni Realtime; the default configuration uses it when `GROQ_API_KEY` is set)

The code lives at [dtinth/vxbeamer](https://github.com/dtinth/vxbeamer). Under `apps/` are the backend, the website, the desktop app and the Android and Wear OS apps; `packages/vxasr` is the ASR client the backend uses.

```{toctree}
:caption: Guide
:maxdepth: 2

getting-started
authentication
configuration
api
```

```{toctree}
:caption: Speech recognition
:maxdepth: 2

asr-configurations
vxasr
asr-vendor-notes
```

```{toctree}
:caption: Apps
:maxdepth: 2

apps/backend
apps/website
apps/desktop
apps/watch
```

```{toctree}
:caption: Decisions
:maxdepth: 1

adr/index
```
