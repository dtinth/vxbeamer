package com.dtinth.vxbeamer.mobile

/**
 * One captured utterance, and how far it has got towards a transcript.
 *
 * Capture and transcription are deliberately separate concerns here
 * (dtinth/vxbeamer#86): the audio is written to local storage the instant it
 * is spoken, and uploading is something that happens to it *afterwards*,
 * possibly more than once. That is what lets recording stay responsive with
 * no server, and what makes a failed transcription retryable rather than
 * lost.
 */
data class Recording(
    val id: String,
    val createdAt: Long,
    val status: RecordingStatus,
    /** Audio length, derived from the file's size — see [durationMsForPcmBytes]. */
    val durationMs: Long = 0,
    val transcript: String? = null,
    val error: String? = null,
    /** Upload attempts so far, for [UploadPolicy]'s retry ceiling. */
    val attempts: Int = 0,
) {
    /** The audio file's name within the store's directory. */
    val audioFileName: String
        get() = "$id.pcm"
}

enum class RecordingStatus {
    /** The mic is open and bytes are still arriving. */
    CAPTURING,

    /** Complete audio, waiting for its turn to upload. */
    PENDING,

    /** Being streamed to the backend right now. */
    UPLOADING,

    /** Transcribed. [Recording.transcript] holds the text. */
    DONE,

    /** The upload or the transcription failed. Retryable — the audio is still here. */
    FAILED,
}

/** 16 kHz, 16-bit, mono — 32 bytes of PCM per millisecond. */
const val PCM_BYTES_PER_MS = 32

fun durationMsForPcmBytes(bytes: Long): Long = bytes / PCM_BYTES_PER_MS

/**
 * Decides what the uploader does next. Pure, so the retry rules can be
 * tested without a network or a clock.
 */
object UploadPolicy {
    /**
     * Give up after this many tries. A recording that has exhausted them is
     * not retried automatically, but stays on the list so it can still be
     * retried by hand — the audio has not gone anywhere.
     */
    const val MAX_ATTEMPTS = 3

    /** Oldest first, so utterances are transcribed in the order they were spoken. */
    fun nextToUpload(recordings: List<Recording>): Recording? {
        if (recordings.any { it.status == RecordingStatus.UPLOADING }) return null
        return recordings
            .filter { it.status == RecordingStatus.PENDING && it.attempts < MAX_ATTEMPTS }
            .minByOrNull { it.createdAt }
    }

    /** Whether a hand-driven retry is worth offering for this recording. */
    fun canRetry(recording: Recording): Boolean =
        recording.status == RecordingStatus.FAILED || recording.status == RecordingStatus.DONE

    /**
     * Failed recordings worth trying again without being asked. A transient
     * failure is the common one — no signal, a backend restart — so the
     * queue re-attempts on its own up to [MAX_ATTEMPTS], and only then waits
     * to be asked.
     */
    fun automaticRetries(recordings: List<Recording>): List<Recording> =
        recordings.filter { it.status == RecordingStatus.FAILED && it.attempts < MAX_ATTEMPTS }

    /**
     * Repairs state left behind by a process that died mid-flight.
     *
     * `UPLOADING` means an upload was in progress when the app went away, so
     * nothing is coming to finish it — it goes back in the queue. `CAPTURING`
     * means the mic was open, and whatever audio reached the file is still
     * worth transcribing, so it is treated as a complete (if truncated)
     * utterance rather than thrown away.
     */
    fun reconcile(recordings: List<Recording>, durationOf: (Recording) -> Long): List<Recording> =
        recordings.map { recording ->
            when (recording.status) {
                RecordingStatus.UPLOADING -> recording.copy(status = RecordingStatus.PENDING)
                RecordingStatus.CAPTURING -> {
                    val duration = durationOf(recording)
                    if (duration > 0) {
                        recording.copy(status = RecordingStatus.PENDING, durationMs = duration)
                    } else {
                        recording.copy(
                            status = RecordingStatus.FAILED,
                            durationMs = duration,
                            error = "Recording was interrupted",
                        )
                    }
                }
                else -> recording
            }
        }
}

/**
 * How much history to keep. Metadata is cheap and worth keeping longer than
 * the audio, which is not: a minute of PCM is about 2 MB, so old audio is
 * dropped well before old entries are (dtinth/vxbeamer#86).
 */
object RetentionPolicy {
    const val MAX_ENTRIES = 50
    const val MAX_AUDIO_FILES = 20

    data class Plan(
        /** The entries to keep, newest first. */
        val keep: List<Recording>,
        /** Recordings whose audio file should be deleted. */
        val dropAudioFor: List<Recording>,
    )

    fun plan(recordings: List<Recording>): Plan {
        val newestFirst = recordings.sortedByDescending { it.createdAt }
        val keep = newestFirst.take(MAX_ENTRIES)
        val dropped = newestFirst.drop(MAX_ENTRIES)

        // Audio is only kept for the newest few, and never dropped from under
        // a recording that still needs it — one waiting to upload, or being
        // uploaded right now, has nothing else to send.
        val stillNeedsAudio = { r: Recording ->
            r.status == RecordingStatus.PENDING || r.status == RecordingStatus.UPLOADING
        }
        val audioKeepers = keep.filterIndexed { index, r -> index < MAX_AUDIO_FILES || stillNeedsAudio(r) }
        val dropAudioFor = (keep - audioKeepers.toSet()) + dropped

        return Plan(keep = keep, dropAudioFor = dropAudioFor)
    }
}
