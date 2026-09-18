package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RetentionPolicyTest {
    private fun recording(
        id: String,
        createdAt: Long,
        status: RecordingStatus = RecordingStatus.DONE,
        attempts: Int = 0,
    ) = Recording(id = id, createdAt = createdAt, status = status, attempts = attempts)

    @Test
    fun `entries beyond the cap are dropped, newest kept`() {
        val recordings = (1..RetentionPolicy.MAX_ENTRIES + 10).map { recording("r$it", it.toLong()) }

        val plan = RetentionPolicy.plan(recordings)

        assertEquals(RetentionPolicy.MAX_ENTRIES, plan.keep.size)
        assertEquals("r${RetentionPolicy.MAX_ENTRIES + 10}", plan.keep.first().id)
    }

    @Test
    fun `audio is dropped well before entries are`() {
        val recordings = (1..RetentionPolicy.MAX_ENTRIES).map { recording("r$it", it.toLong()) }

        val plan = RetentionPolicy.plan(recordings)

        // A minute of PCM is a couple of megabytes; the transcript that came
        // out of it is a few hundred bytes, so they are kept for different
        // lengths of time.
        assertEquals(RetentionPolicy.MAX_ENTRIES, plan.keep.size)
        assertEquals(
            RetentionPolicy.MAX_ENTRIES - RetentionPolicy.MAX_AUDIO_FILES,
            plan.dropAudioFor.size,
        )
    }

    @Test
    fun `audio is never taken from a recording that still needs to send it`() {
        // An old recording that has not been transcribed yet has nothing else
        // to upload — deleting its audio would strand it permanently.
        val stale = recording("ancient-pending", createdAt = 1, status = RecordingStatus.PENDING)
        val uploading = recording("ancient-uploading", createdAt = 2, status = RecordingStatus.UPLOADING)
        val capturing = recording("ancient-capturing", createdAt = 3, status = RecordingStatus.CAPTURING)
        val newer = (10..RetentionPolicy.MAX_ENTRIES + 5).map { recording("r$it", it.toLong()) }

        val plan = RetentionPolicy.plan(newer + listOf(stale, uploading, capturing))

        val droppedIds = plan.dropAudioFor.map { it.id }
        assertTrue(stale.id !in droppedIds)
        assertTrue(uploading.id !in droppedIds)
        assertTrue(capturing.id !in droppedIds)
    }

    @Test
    fun `audio is kept for a failure that will be retried`() {
        // Retention runs on every recording, so an old failure would lose its
        // audio while keeping its Retry button — which could then only ever
        // fail with a missing file.
        val retryable = recording("old-failure", createdAt = 1, status = RecordingStatus.FAILED, attempts = 1)
        val newer = (10..RetentionPolicy.MAX_ENTRIES).map { recording("r$it", it.toLong()) }

        val plan = RetentionPolicy.plan(newer + retryable)

        assertTrue(retryable.id !in plan.dropAudioFor.map { it.id })
    }

    @Test
    fun `audio is reclaimed once a failure has run out of attempts`() {
        // It can still be retried by hand, but not indefinitely at the cost of
        // holding megabytes of PCM for something that has failed three times.
        val exhausted =
            recording(
                "given-up",
                createdAt = 1,
                status = RecordingStatus.FAILED,
                attempts = UploadPolicy.MAX_ATTEMPTS,
            )
        val newer = (10..RetentionPolicy.MAX_ENTRIES).map { recording("r$it", it.toLong()) }

        val plan = RetentionPolicy.plan(newer + exhausted)

        assertTrue(exhausted.id in plan.dropAudioFor.map { it.id })
    }

    @Test
    fun `a short history keeps everything`() {
        val recordings = listOf(recording("a", 1), recording("b", 2))

        val plan = RetentionPolicy.plan(recordings)

        assertEquals(2, plan.keep.size)
        assertTrue(plan.dropAudioFor.isEmpty())
    }

    @Test
    fun `entries come back newest first`() {
        val plan = RetentionPolicy.plan(listOf(recording("old", 1), recording("new", 9)))

        assertEquals(listOf("new", "old"), plan.keep.map { it.id })
    }
}
