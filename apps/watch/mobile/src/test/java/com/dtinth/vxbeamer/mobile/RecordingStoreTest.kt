package com.dtinth.vxbeamer.mobile

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The store takes a plain directory rather than a `Context`, so the whole
 * persistence layer runs here against a temporary folder — no emulator, and
 * the retention and crash-recovery rules are exercised for real rather than
 * reasoned about (dtinth/vxbeamer#86).
 */
class RecordingStoreTest {
    private lateinit var directory: File
    private lateinit var store: RecordingStore

    @Before
    fun setUp() {
        directory = File.createTempFile("recordings", "").let {
            it.delete()
            it.mkdirs()
            it
        }
        store = RecordingStore(directory)
        store.load()
    }

    @After
    fun tearDown() {
        directory.deleteRecursively()
    }

    private fun writeAudio(recording: Recording, milliseconds: Int) {
        store.audioFile(recording).writeBytes(ByteArray(milliseconds * PCM_BYTES_PER_MS))
    }

    @Test
    fun `a new recording starts out capturing`() {
        val recording = store.beginRecording("a", now = 100)

        assertEquals(RecordingStatus.CAPTURING, recording.status)
        assertEquals(listOf("a"), store.recordings.value.map { it.id })
    }

    @Test
    fun `finishing capture queues the recording with its real duration`() {
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 1_500)

        store.finishCapture("a")

        val stored = store.get("a")!!
        assertEquals(RecordingStatus.PENDING, stored.status)
        assertEquals(1_500, stored.durationMs)
    }

    @Test
    fun `finishing a capture that produced no audio drops it`() {
        store.beginRecording("a", now = 100)

        store.finishCapture("a")

        // An entry with no audio could only ever fail to upload.
        assertNull(store.get("a"))
        assertTrue(store.recordings.value.isEmpty())
    }

    @Test
    fun `an empty recording is dropped even once an upload has claimed it`() {
        // The live upload stamps UPLOADING before the user can lift a finger,
        // so this is the *realistic* state at this point — gating the cleanup
        // on CAPTURING meant it never ran, and a stray tap left an entry that
        // could only burn attempts timing out against silence.
        store.beginRecording("a", now = 100)
        store.update("a") { it.copy(status = RecordingStatus.UPLOADING) }

        store.finishCapture("a")

        assertNull(store.get("a"))
    }

    @Test
    fun `the audio file exists as soon as the recording does`() {
        // The uploader starts tailing it immediately and would otherwise race
        // the microphone's slower setup and fail before a word was spoken.
        val recording = store.beginRecording("a", now = 100)

        assertTrue(store.audioFile(recording).exists())
    }

    @Test
    fun `an in-memory update is published but not persisted`() {
        // Transcript partials arrive several times a second and are worth
        // nothing after a restart.
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 500)
        store.finishCapture("a")

        store.updateInMemory("a") { it.copy(transcript = "partial so far") }

        assertEquals("partial so far", store.get("a")?.transcript)
        val reopened = RecordingStore(directory)
        reopened.load()
        assertNull(reopened.get("a")?.transcript)
    }

    @Test
    fun `finishing capture does not disturb an upload already in flight`() {
        // The normal path: an upload tails the file while capture runs, so by
        // the time capture ends the uploader already owns the status. Stamping
        // PENDING over it would queue a second send of the same audio.
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 500)
        store.update("a") { it.copy(status = RecordingStatus.UPLOADING) }

        store.finishCapture("a")

        assertEquals(RecordingStatus.UPLOADING, store.get("a")!!.status)
        assertEquals(500, store.get("a")!!.durationMs)
    }

    @Test
    fun `recordings are exposed newest first`() {
        store.beginRecording("old", now = 100)
        store.beginRecording("new", now = 200)

        assertEquals(listOf("new", "old"), store.recordings.value.map { it.id })
    }

    @Test
    fun `updating a recording that has been pruned away is a no-op`() {
        // The upload loop can outlive the entry it was working on.
        store.update("never-existed") { it.copy(status = RecordingStatus.DONE) }

        assertTrue(store.recordings.value.isEmpty())
    }

    @Test
    fun `requeueing clears the error and the attempt count`() {
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 500)
        store.finishCapture("a")
        store.update("a") {
            it.copy(status = RecordingStatus.FAILED, error = "no signal", attempts = 3)
        }

        store.requeue("a")

        val stored = store.get("a")!!
        assertEquals(RecordingStatus.PENDING, stored.status)
        assertEquals(0, stored.attempts)
        assertNull(stored.error)
    }

    @Test
    fun `deleting removes the entry and its audio`() {
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 500)

        store.delete("a")

        assertNull(store.get("a"))
        assertFalse(store.audioFile(recording).exists())
    }

    // --- Across a restart ---

    @Test
    fun `recordings survive being reloaded`() {
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 2_000)
        store.finishCapture("a")
        store.update("a") { it.copy(status = RecordingStatus.DONE, transcript = "hello") }

        val reopened = RecordingStore(directory)
        reopened.load()

        assertEquals("hello", reopened.get("a")?.transcript)
        assertEquals(RecordingStatus.DONE, reopened.get("a")?.status)
    }

    @Test
    fun `an upload interrupted by the process dying is queued again on load`() {
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 2_000)
        store.finishCapture("a")
        store.update("a") { it.copy(status = RecordingStatus.UPLOADING) }

        val reopened = RecordingStore(directory)
        reopened.load()

        assertEquals(RecordingStatus.PENDING, reopened.get("a")?.status)
    }

    @Test
    fun `a capture interrupted by the process dying keeps the audio it got`() {
        val recording = store.beginRecording("a", now = 100)
        writeAudio(recording, milliseconds = 3_000)
        // No finishCapture: the process died with the mic open.

        val reopened = RecordingStore(directory)
        reopened.load()

        assertEquals(RecordingStatus.PENDING, reopened.get("a")?.status)
        assertEquals(3_000L, reopened.get("a")!!.durationMs)
    }

    @Test
    fun `a corrupt index costs the history but not the app`() {
        store.beginRecording("a", now = 100)
        File(directory, "recordings.json").writeText("{ not the index }")

        val reopened = RecordingStore(directory)
        reopened.load()

        assertTrue(reopened.recordings.value.isEmpty())
    }

    // --- Retention ---

    @Test
    fun `old entries and their audio are pruned as new ones arrive`() {
        val created = mutableListOf<Recording>()
        for (index in 1..RetentionPolicy.MAX_ENTRIES + 5) {
            val recording = store.beginRecording("r$index", now = index.toLong())
            writeAudio(recording, milliseconds = 100)
            store.finishCapture(recording.id)
            created += recording
        }

        assertEquals(RetentionPolicy.MAX_ENTRIES, store.recordings.value.size)
        // The very oldest are gone entirely, audio included.
        assertFalse(store.audioFile(created.first()).exists())
        assertNull(store.get(created.first().id))
        // The newest keeps both.
        assertTrue(store.audioFile(created.last()).exists())
    }
}
