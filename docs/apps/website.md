# Website

The website (`apps/website`) is the React PWA: the frontend you add to your home screen. It is deployed statically; the hosted instance at [vxbeamer.vercel.app](https://vxbeamer.vercel.app) connects to whichever backend you pair it with.

See {ref}`usage` for how to record, copy, delete and beam transcripts.

## Keyboard shortcuts

Keyboard shortcuts (ignored while typing in a text field): `c` copies the latest finished transcript, `r` toggles recording, and holding Space is push-to-talk — it starts recording on press, and on release stops and copies the transcript automatically once it finishes.

## Development

From the repository root:

```bash
vp install
vp run dev:frontend
```
