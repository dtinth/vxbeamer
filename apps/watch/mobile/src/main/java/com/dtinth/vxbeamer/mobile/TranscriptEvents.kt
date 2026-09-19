package com.dtinth.vxbeamer.mobile

import org.json.JSONObject

/** What one `/sse` event means for the upload that is watching for it. */
sealed interface TranscriptUpdate {
    /** Transcription in progress; the text so far. */
    data class Partial(val text: String) : TranscriptUpdate

    /** The finished transcript. Nothing further will arrive for this recording. */
    data class Final(val text: String) : TranscriptUpdate

    /** The backend gave up on this recording. */
    data class Failed(val message: String) : TranscriptUpdate
}

/**
 * Reads the backend's `/sse` stream, mirroring `applySSEEvent` in
 * `apps/website/src/store.ts`: `created` and `updated` carry one `message`,
 * `snapshot` carries the whole list.
 *
 * **The `referenceId` filter is the whole point.** `/sse` carries every
 * message on the account — other devices, and this device's earlier
 * recordings — so an upload must pick out its own and ignore the rest. Not
 * doing so put somebody else's transcript on screen once already
 * (dtinth/vxbeamer#86), which is why this is a pure function with tests
 * rather than a branch buried in a listener.
 */
object TranscriptEvents {
    fun parse(json: String, referenceId: String): TranscriptUpdate? {
        val event = runCatching { JSONObject(json) }.getOrNull() ?: return null
        val message =
            when (event.optString("type")) {
                "created", "updated" -> event.optJSONObject("message")
                "snapshot" -> {
                    val messages = event.optJSONArray("messages") ?: return null
                    (0 until messages.length())
                        .mapNotNull { messages.optJSONObject(it) }
                        .lastOrNull { it.optString("referenceId") == referenceId }
                }
                else -> null
            } ?: return null

        if (message.optString("referenceId") != referenceId) return null

        // `final` is checked before `status`: the backend can deliver the
        // final text slightly ahead of the event that flips `status` to
        // "done", the same race `messageFeedScroll.ts`'s `isMessageCopyable`
        // has to account for on the web.
        val final = message.optString("final")
        if (final.isNotEmpty()) return TranscriptUpdate.Final(final)

        if (message.optString("status") == "error") {
            val error = message.optString("error").takeIf { it.isNotEmpty() } ?: "Transcription failed"
            return TranscriptUpdate.Failed(error)
        }

        val partial = message.optString("partial")
        if (partial.isNotEmpty()) return TranscriptUpdate.Partial(partial)

        return null
    }
}
