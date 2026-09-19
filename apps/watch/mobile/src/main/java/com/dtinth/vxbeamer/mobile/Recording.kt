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
    /** When the last attempt began, for [UploadPolicy.automaticRetries]' backoff. */
    val lastAttemptAt: Long = 0,
    /**
     * Whether the audio file is still on disk.
     *
     * Derived, not stored: [RecordingStore] stamps it when it publishes, so
     * the UI can offer Retry and Export without doing file IO of its own,
     * and retention deleting a file is reflected the moment it happens.
     */
    val hasAudio: Boolean = false,
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

    /**
     * Whether a hand-driven retry is worth offering. Includes a `PENDING`
     * recording that has run out of automatic attempts: nothing will pick it
     * up again on its own, so the button is the only way out.
     */
    fun canRetry(recording: Recording): Boolean =
        when (recording.status) {
            RecordingStatus.FAILED, RecordingStatus.DONE -> true
            RecordingStatus.PENDING -> recording.attempts >= MAX_ATTEMPTS
            RecordingStatus.CAPTURING, RecordingStatus.UPLOADING -> false
        }

    /** Queued, but nothing will send it without being asked. */
    fun isStalled(recording: Recording): Boolean =
        recording.status == RecordingStatus.PENDING && recording.attempts >= MAX_ATTEMPTS

    /**
     * Failed recordings due another try, given how long ago they last had
     * one. A transient failure is the common one — no signal, a backend
     * restart — so the queue re-attempts on its own up to [MAX_ATTEMPTS].
     *
     * Backed off rather than retried on a fixed interval, because the
     * failure this most needs to survive is being out of signal for a while,
     * and a flat interval would spend every attempt in the first minute of
     * it (dtinth/vxbeamer#86).
     */
    fun automaticRetries(recordings: List<Recording>, now: Long): List<Recording> =
        recordings.filter {
            it.status == RecordingStatus.FAILED &&
                it.attempts < MAX_ATTEMPTS &&
                now - it.lastAttemptAt >= backoffMs(it.attempts)
        }

    /** 30 s, 2 min, 8 min — roughly ten minutes of cover in total. */
    fun backoffMs(attempts: Int): Long =
        INITIAL_BACKOFF_MS shl (2 * (attempts - 1).coerceAtLeast(0))

    private const val INITIAL_BACKOFF_MS = 30_000L

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
                // `attempts` is reset because the attempt never got a verdict —
                // the process died. Counting it would let a recording reload as
                // PENDING with the budget spent, which nothing then picks up and
                // no Retry button is offered for: stranded, and still counted as
                // "busy" by the foreground service, which could then never stop
                // (dtinth/vxbeamer#86).
                RecordingStatus.UPLOADING ->
                    recording.copy(status = RecordingStatus.PENDING, attempts = 0)
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
 * How much history to keep.
 *
 * Metadata is cheap and worth keeping far longer than the audio, which is
 * not: 16 kHz 16-bit mono runs at about 1.9 MB per minute, so a handful of
 * long recordings would otherwise quietly occupy hundreds of megabytes.
 * Audio is therefore capped by *total size* rather than by count — what
 * matters to the device is the megabytes, and a count cannot bound them
 * when recordings vary from two seconds to ten minutes
 * (dtinth/vxbeamer#86).
 *
 * The cap is a target rather than a guarantee: audio that has not been
 * transcribed yet is never deleted to stay under it, since that would
 * destroy the only copy of what was said. A long stretch offline can
 * therefore exceed it until the queue drains.
 */
object RetentionPolicy {
    const val MAX_ENTRIES = 50
    const val MAX_AUDIO_BYTES = 10L * 1024 * 1024

    data class Plan(
        /** The entries to keep, newest first. */
        val keep: List<Recording>,
        /** Recordings whose audio file should be deleted. */
        val dropAudioFor: List<Recording>,
    )

    /**
     * [audioSizeOf] gives each recording's audio size in bytes; a recording
     * whose file is already gone should report 0.
     */
    fun plan(recordings: List<Recording>, audioSizeOf: (Recording) -> Long): Plan {
        val newestFirst = recordings.sortedByDescending { it.createdAt }
        val keep = newestFirst.take(MAX_ENTRIES)
        val dropped = newestFirst.drop(MAX_ENTRIES)

        // Newest audio is kept first, up to the budget. Anything that still
        // has to be sent is exempt: a recording waiting to upload has nothing
        // else to send, and a failure with attempts left would retry into a
        // file that is no longer there.
        val exempt = { r: Recording ->
            when (r.status) {
                RecordingStatus.PENDING, RecordingStatus.UPLOADING, RecordingStatus.CAPTURING -> true
                RecordingStatus.FAILED -> r.attempts < UploadPolicy.MAX_ATTEMPTS
                RecordingStatus.DONE -> false
            }
        }

        var budget = MAX_AUDIO_BYTES
        val dropAudioFor = mutableListOf<Recording>()
        for (recording in keep) {
            val size = audioSizeOf(recording)
            if (size <= 0) continue
            if (exempt(recording)) {
                // Counted against the budget even though it cannot be
                // dropped, so an exempt backlog still pushes older audio out
                // rather than letting the total run past the cap unnoticed.
                budget -= size
                continue
            }
            if (size <= budget) {
                budget -= size
            } else {
                dropAudioFor += recording
            }
        }

        return Plan(keep = keep, dropAudioFor = dropAudioFor + dropped)
    }
}
