package com.dtinth.vxbeamer.mobile

import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The recordings on this device: their audio, their transcripts, and what
 * still needs uploading.
 *
 * Takes a plain directory rather than a `Context` on purpose — nothing here
 * needs Android, so the persistence and retention rules can be exercised
 * against a temporary directory in an ordinary unit test
 * (dtinth/vxbeamer#86).
 *
 * Every mutation goes through [mutate], which holds a lock, rewrites the
 * index and republishes the list. Capture and upload run on different
 * threads and both write here.
 */
class RecordingStore(private val directory: File) {
    private val lock = Any()
    private val indexFile = File(directory, INDEX_FILE_NAME)

    private val _recordings = MutableStateFlow<List<Recording>>(emptyList())

    /** Newest first, as the history list shows them. */
    val recordings: StateFlow<List<Recording>> = _recordings.asStateFlow()

    /**
     * Reads the index, repairs anything a previous process left mid-flight,
     * and prunes. Call once, before anything else touches the store.
     */
    fun load() {
        synchronized(lock) {
            directory.mkdirs()
            val stored =
                runCatching { indexFile.readText() }
                    .map { RecordingSerializer.decode(it) }
                    .getOrDefault(emptyList())
            val reconciled =
                UploadPolicy.reconcile(stored) { durationMsForPcmBytes(audioFile(it).length()) }
            writeLocked(applyRetention(reconciled))
        }
    }

    fun audioFile(recording: Recording): File = File(directory, recording.audioFileName)

    fun get(id: String): Recording? = _recordings.value.find { it.id == id }

    /** Adds a new [RecordingStatus.CAPTURING] entry and returns it. */
    fun beginRecording(id: String, now: Long): Recording {
        val recording = Recording(id = id, createdAt = now, status = RecordingStatus.CAPTURING)
        synchronized(lock) {
            // Created here, not by whoever writes the audio: the uploader
            // starts tailing this file straight away and would otherwise race
            // the microphone's own slower setup and fail with
            // FileNotFoundException before a word was spoken
            // (dtinth/vxbeamer#86).
            directory.mkdirs()
            runCatching { audioFile(recording).createNewFile() }
            // Not retained yet: pruning here could delete the audio of a
            // recording that is still being captured into.
            writeLocked(listOf(recording) + _recordings.value)
        }
        return recording
    }

    /**
     * Applies [transform] to one recording. A no-op if it has since been
     * pruned away, which is what makes the upload loop safe to run against a
     * store that is also being trimmed.
     */
    fun update(id: String, transform: (Recording) -> Recording) {
        synchronized(lock) {
            val current = _recordings.value
            if (current.none { it.id == id }) return
            writeLocked(current.map { if (it.id == id) transform(it) else it })
        }
    }

    /**
     * Like [update], but only publishes — nothing is written to disk.
     *
     * For transcript partials, which arrive several times a second and are
     * worth nothing after a restart. Persisting them re-encoded and rewrote
     * the whole index that often, under the lock the capture thread also
     * wants (dtinth/vxbeamer#86).
     */
    fun updateInMemory(id: String, transform: (Recording) -> Recording) {
        synchronized(lock) {
            val current = _recordings.value
            if (current.none { it.id == id }) return
            _recordings.value = current.map { if (it.id == id) transform(it) else it }
        }
    }

    /**
     * Capture finished: record the duration from what actually landed on
     * disk, and queue the recording if nothing is already sending it.
     *
     * The status is only moved out of [RecordingStatus.CAPTURING] — in the
     * normal case an upload is already tailing this file and owns the status
     * itself, and stamping `PENDING` over its `UPLOADING` would queue a
     * second send of the same audio.
     */
    fun finishCapture(id: String) {
        synchronized(lock) {
            val current = _recordings.value
            val recording = current.find { it.id == id } ?: return
            val duration = durationMsForPcmBytes(audioFile(recording).length())

            if (duration <= 0) {
                // Nothing was captured — a mic that never opened, or a tap so
                // brief no audio arrived. Dropped regardless of what status the
                // live upload has already stamped on it: it always wins that
                // race, so gating this on CAPTURING never fired, and a stray
                // tap left an entry that could only burn attempts timing out
                // against silence (dtinth/vxbeamer#86).
                audioFile(recording).delete()
                writeLocked(current.filterNot { it.id == id })
                return
            }

            val updated =
                recording.copy(
                    durationMs = duration,
                    status =
                        if (recording.status == RecordingStatus.CAPTURING) {
                            RecordingStatus.PENDING
                        } else {
                            recording.status
                        },
                )
            writeLocked(applyRetention(current.map { if (it.id == id) updated else it }))
        }
    }

    /** Puts a failed or finished recording back in the queue. */
    fun requeue(id: String) {
        update(id) {
            it.copy(status = RecordingStatus.PENDING, attempts = 0, error = null)
        }
    }

    fun delete(id: String) {
        synchronized(lock) {
            val recording = _recordings.value.find { it.id == id } ?: return
            audioFile(recording).delete()
            writeLocked(_recordings.value.filterNot { it.id == id })
        }
    }

    /** Drops every entry and its audio. */
    fun clear() {
        synchronized(lock) {
            for (recording in _recordings.value) audioFile(recording).delete()
            writeLocked(emptyList())
        }
    }

    /** Applies [RetentionPolicy], deleting the audio it says is no longer needed. */
    private fun applyRetention(recordings: List<Recording>): List<Recording> {
        val plan = RetentionPolicy.plan(recordings)
        for (recording in plan.dropAudioFor) audioFile(recording).delete()
        return plan.keep
    }

    /** Caller must hold [lock]. */
    private fun writeLocked(recordings: List<Recording>) {
        val ordered = recordings.sortedByDescending { it.createdAt }
        _recordings.value = ordered
        runCatching {
            directory.mkdirs()
            // Written via a temporary file and renamed, so an interrupted
            // write leaves the previous index intact rather than a truncated
            // one.
            val temporary = File(directory, "$INDEX_FILE_NAME.tmp")
            temporary.writeText(RecordingSerializer.encode(ordered))
            if (!temporary.renameTo(indexFile)) {
                indexFile.writeText(RecordingSerializer.encode(ordered))
                temporary.delete()
            }
        }
    }

    companion object {
        private const val INDEX_FILE_NAME = "recordings.json"
    }
}
