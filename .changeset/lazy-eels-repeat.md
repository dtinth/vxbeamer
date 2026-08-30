---
"backend": minor
"website": patch
---

Add a new endpoint: `POST /messages/:id/winner`. This endpoint lets an eval winner's transcript replace the message's main answer.

An eval run creates no message of its own. So, picking a winner just updates the existing message. The app shares this update over SSE, the same way it shares a live transcription update. The webhook fires again too, this time with the winner's transcript. The system already told other services the primary answer when the recording finished. This second webhook call is the correction. The payload type was already `message.updated` for the first call, so a second update uses that same, correct type.

Messages now have a `configurationId` field. This field names the model configuration that wrote the current answer. The recording sets it at first. Picking a winner then overwrites it. Without this field, a second `message.updated` event would be an unexplained change to the transcript.

The server checks that the winning configuration ID is one it actually serves. The server does not check the transcript text itself, and it cannot: the eval results come from the browser, and the backend keeps no copy of the recording to check against. This write only affects the caller's own message log. So, even though the transcript is not checked, it can only ever change the caller's own messages. The server refuses this request if the message is still recording — a live session could otherwise overwrite the winner. The server accepts this request if the message's primary answer had failed. In that case, the message becomes "done".
