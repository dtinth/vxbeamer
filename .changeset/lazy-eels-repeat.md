---
"backend": minor
"website": patch
---

Add `POST /messages/:id/winner`: an eval winner's transcript replaces the message's primary answer.

Eval runs create no message of their own, so there is nothing to merge or delete — picking a winner is an update to the existing message, broadcast over SSE exactly as the live transcription path broadcasts one. The webhook re-fires with the winner's transcript: downstream was already told the primary's answer when the recording finished, and this is the correction. The payload type was always `message.updated`, so a second update is precisely what it already says.

Messages now carry a `configurationId` — the model configuration that authored the current answer, set from the recording's own configuration and overwritten by a winner. Without it a second `message.updated` is an unexplained transcript change.

The winning configuration id is validated against the configurations this server serves; the transcript is not, and cannot be, since eval results are collected in the browser and the backend holds no recording to re-transcribe. The write is scoped to the caller's own message log, so an unverifiable transcript only ever edits the caller's own words. A message still recording is refused (the live session would clobber the winner); a message whose primary errored is accepted and promoted to done.
