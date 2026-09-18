package com.dtinth.vxbeamer.mobile

import org.json.JSONArray
import org.json.JSONObject

/**
 * The history file's format. Hand-rolled over `org.json` rather than pulled
 * in with a serialization library: it is one flat list of one small record
 * type, and the app already depends on `org.json` for reading the backend's
 * own events.
 *
 * Decoding never throws. History is a convenience, not a source of truth —
 * a file truncated by a crash or written by an older build should cost the
 * user the entries it cannot parse, never the ability to open the app.
 */
object RecordingSerializer {
    fun encode(recordings: List<Recording>): String {
        val array = JSONArray()
        for (recording in recordings) {
            array.put(
                JSONObject().apply {
                    put(KEY_ID, recording.id)
                    put(KEY_CREATED_AT, recording.createdAt)
                    put(KEY_STATUS, recording.status.name)
                    put(KEY_DURATION_MS, recording.durationMs)
                    put(KEY_ATTEMPTS, recording.attempts)
                    recording.transcript?.let { put(KEY_TRANSCRIPT, it) }
                    recording.error?.let { put(KEY_ERROR, it) }
                },
            )
        }
        return array.toString()
    }

    fun decode(json: String): List<Recording> {
        val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        val recordings = mutableListOf<Recording>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString(KEY_ID).takeIf { it.isNotEmpty() } ?: continue
            val status =
                runCatching { RecordingStatus.valueOf(item.optString(KEY_STATUS)) }.getOrNull()
                    ?: continue
            recordings.add(
                Recording(
                    id = id,
                    createdAt = item.optLong(KEY_CREATED_AT),
                    status = status,
                    durationMs = item.optLong(KEY_DURATION_MS),
                    transcript = item.optString(KEY_TRANSCRIPT).takeIf { it.isNotEmpty() },
                    error = item.optString(KEY_ERROR).takeIf { it.isNotEmpty() },
                    attempts = item.optInt(KEY_ATTEMPTS),
                ),
            )
        }
        return recordings
    }

    private const val KEY_ID = "id"
    private const val KEY_CREATED_AT = "createdAt"
    private const val KEY_STATUS = "status"
    private const val KEY_DURATION_MS = "durationMs"
    private const val KEY_TRANSCRIPT = "transcript"
    private const val KEY_ERROR = "error"
    private const val KEY_ATTEMPTS = "attempts"
}
