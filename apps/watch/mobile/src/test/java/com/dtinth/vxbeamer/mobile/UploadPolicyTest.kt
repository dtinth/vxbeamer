package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadPolicyTest {
    private fun recording(
        id: String,
        status: RecordingStatus,
        createdAt: Long = 0,
        attempts: Int = 0,
        lastAttemptAt: Long = 0,
    ) = Recording(
        id = id,
        createdAt = createdAt,
        status = status,
        attempts = attempts,
        lastAttemptAt = lastAttemptAt,
    )

    @Test
    fun `the oldest pending recording goes first`() {
        val recordings =
            listOf(
                recording("new", RecordingStatus.PENDING, createdAt = 300),
                recording("old", RecordingStatus.PENDING, createdAt = 100),
                recording("mid", RecordingStatus.PENDING, createdAt = 200),
            )

        // Utterances are transcribed in the order they were spoken.
        assertEquals("old", UploadPolicy.nextToUpload(recordings)?.id)
    }

    @Test
    fun `nothing is picked while an upload is already running`() {
        val recordings =
            listOf(
                recording("busy", RecordingStatus.UPLOADING),
                recording("waiting", RecordingStatus.PENDING),
            )

        // One at a time: the device is likely on mobile data, and the backend
        // pairs one socket with one recording.
        assertNull(UploadPolicy.nextToUpload(recordings))
    }

    @Test
    fun `done, failed and capturing recordings are not queued`() {
        val recordings =
            listOf(
                recording("done", RecordingStatus.DONE),
                recording("failed", RecordingStatus.FAILED),
                recording("capturing", RecordingStatus.CAPTURING),
            )

        assertNull(UploadPolicy.nextToUpload(recordings))
    }

    @Test
    fun `a recording that exhausted its attempts is not picked up again`() {
        val recordings =
            listOf(recording("tired", RecordingStatus.PENDING, attempts = UploadPolicy.MAX_ATTEMPTS))

        assertNull(UploadPolicy.nextToUpload(recordings))
    }

    @Test
    fun `automatic retries cover failures that have attempts left`() {
        val recordings =
            listOf(
                recording("retryable", RecordingStatus.FAILED, attempts = 1),
                recording("exhausted", RecordingStatus.FAILED, attempts = UploadPolicy.MAX_ATTEMPTS),
                recording("fine", RecordingStatus.DONE),
            )

        val due = UploadPolicy.automaticRetries(recordings, now = 10 * 60_000)

        assertEquals(listOf("retryable"), due.map { it.id })
    }

    @Test
    fun `a failure is left alone until its backoff has passed`() {
        val justFailed =
            listOf(recording("a", RecordingStatus.FAILED, attempts = 1, lastAttemptAt = 1_000))

        // Retrying immediately would spend the whole budget inside the first
        // minute of being out of signal.
        assertTrue(UploadPolicy.automaticRetries(justFailed, now = 2_000).isEmpty())
        assertEquals(1, UploadPolicy.automaticRetries(justFailed, now = 1_000 + 30_000).size)
    }

    @Test
    fun `each attempt waits longer than the last`() {
        val first = UploadPolicy.backoffMs(1)
        val second = UploadPolicy.backoffMs(2)
        val third = UploadPolicy.backoffMs(3)

        assertTrue(second > first)
        assertTrue(third > second)
        // Enough cover to survive a stretch with no signal, rather than
        // giving up half a minute after the user stopped speaking.
        assertTrue("total cover was ${first + second + third} ms", first + second + third >= 5 * 60_000)
    }

    @Test
    fun `a finished recording can still be transcribed again by hand`() {
        // The audio is on the device, so a bad transcript is worth another go.
        assertTrue(UploadPolicy.canRetry(recording("a", RecordingStatus.DONE)))
        assertTrue(UploadPolicy.canRetry(recording("b", RecordingStatus.FAILED)))
        assertFalse(UploadPolicy.canRetry(recording("c", RecordingStatus.CAPTURING)))
        assertFalse(UploadPolicy.canRetry(recording("d", RecordingStatus.UPLOADING)))
    }

    @Test
    fun `a queued recording with no attempts left is offered a manual retry`() {
        // Nothing picks this up on its own, so without the button it would
        // sit in the queue forever.
        val stalled =
            recording("a", RecordingStatus.PENDING, attempts = UploadPolicy.MAX_ATTEMPTS)

        assertTrue(UploadPolicy.isStalled(stalled))
        assertTrue(UploadPolicy.canRetry(stalled))
        assertFalse(UploadPolicy.isStalled(recording("b", RecordingStatus.PENDING, attempts = 1)))
    }

    // --- Repairing state a dead process left behind ---

    @Test
    fun `an interrupted upload goes back in the queue`() {
        val recovered =
            UploadPolicy.reconcile(listOf(recording("a", RecordingStatus.UPLOADING))) { 1000 }

        assertEquals(RecordingStatus.PENDING, recovered.single().status)
    }

    @Test
    fun `an interrupted upload does not spend an attempt`() {
        // The attempt never reached a verdict — the process died. Counting it
        // could reload a recording as PENDING with the budget gone, which
        // nothing picks up and no Retry button is offered for: stranded, and
        // still counted as work by the foreground service.
        val killed =
            listOf(recording("a", RecordingStatus.UPLOADING, attempts = UploadPolicy.MAX_ATTEMPTS))

        val recovered = UploadPolicy.reconcile(killed) { 1000 }

        assertEquals(0, recovered.single().attempts)
        assertEquals("a", UploadPolicy.nextToUpload(recovered)?.id)
    }

    @Test
    fun `an interrupted capture keeps whatever audio reached the disk`() {
        val recovered =
            UploadPolicy.reconcile(listOf(recording("a", RecordingStatus.CAPTURING))) { 4_500 }

        // A truncated utterance is still worth transcribing.
        assertEquals(RecordingStatus.PENDING, recovered.single().status)
        assertEquals(4_500, recovered.single().durationMs)
    }

    @Test
    fun `an interrupted capture with no audio is marked failed`() {
        val recovered =
            UploadPolicy.reconcile(listOf(recording("a", RecordingStatus.CAPTURING))) { 0 }

        assertEquals(RecordingStatus.FAILED, recovered.single().status)
    }

    @Test
    fun `settled recordings are left alone`() {
        val recordings =
            listOf(
                recording("done", RecordingStatus.DONE),
                recording("failed", RecordingStatus.FAILED),
                recording("pending", RecordingStatus.PENDING),
            )

        assertEquals(recordings, UploadPolicy.reconcile(recordings) { 1000 })
    }
}
