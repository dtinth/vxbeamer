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

    /** A megabyte is about 32 seconds at this app's capture format. */
    private val oneMegabyte = 1024L * 1024

    private fun planWithEqualSizes(recordings: List<Recording>, size: Long = oneMegabyte) =
        RetentionPolicy.plan(recordings) { size }

    @Test
    fun `entries beyond the cap are dropped, newest kept`() {
        val recordings = (1..RetentionPolicy.MAX_ENTRIES + 10).map { recording("r$it", it.toLong()) }

        val plan = planWithEqualSizes(recordings)

        assertEquals(RetentionPolicy.MAX_ENTRIES, plan.keep.size)
        assertEquals("r${RetentionPolicy.MAX_ENTRIES + 10}", plan.keep.first().id)
    }

    // --- Audio is bounded by megabytes, not by how many files there are ---

    @Test
    fun `audio is kept up to the budget and no further`() {
        // Twenty megabytes offered, ten allowed: the newest ten survive.
        val recordings = (1..20).map { recording("r$it", it.toLong()) }

        val plan = planWithEqualSizes(recordings)

        val kept = plan.keep.filterNot { it in plan.dropAudioFor }
        assertEquals(10, kept.size)
        // Newest first, so the survivors are the most recent.
        assertEquals("r20", kept.first().id)
        assertEquals("r11", kept.last().id)
    }

    @Test
    fun `one long recording can use the whole budget`() {
        // A count-based cap could not express this: a single ten-minute
        // recording is worth more megabytes than twenty short ones.
        val long = recording("long", createdAt = 100)
        val short = recording("short", createdAt = 50)

        val plan =
            RetentionPolicy.plan(listOf(long, short)) {
                if (it.id == "long") RetentionPolicy.MAX_AUDIO_BYTES else oneMegabyte
            }

        assertTrue("long" !in plan.dropAudioFor.map { it.id })
        assertTrue("short" in plan.dropAudioFor.map { it.id })
    }

    @Test
    fun `a recording that fits is kept even after a larger one was dropped`() {
        // The budget is spent per recording, so a small tail still fits under
        // a big one that did not.
        val recordings =
            listOf(
                recording("newest", createdAt = 300),
                recording("huge", createdAt = 200),
                recording("small", createdAt = 100),
            )

        val plan =
            RetentionPolicy.plan(recordings) {
                when (it.id) {
                    "newest" -> 9 * oneMegabyte
                    "huge" -> 8 * oneMegabyte
                    else -> oneMegabyte
                }
            }

        val dropped = plan.dropAudioFor.map { it.id }
        assertTrue("huge" in dropped)
        assertTrue("small" !in dropped)
    }

    @Test
    fun `recordings with no audio left do not consume the budget`() {
        val recordings = (1..20).map { recording("r$it", it.toLong()) }

        // Only the newest five still have audio; all of them fit.
        val plan =
            RetentionPolicy.plan(recordings) { r ->
                if (r.id in listOf("r20", "r19", "r18", "r17", "r16")) oneMegabyte else 0
            }

        assertTrue(plan.dropAudioFor.isEmpty())
    }

    // --- Anything that still has to be sent keeps its audio ---

    @Test
    fun `audio is never taken from a recording that still needs to send it`() {
        // An old recording that has not been transcribed yet has nothing else
        // to upload — deleting its audio would strand it permanently.
        val stale = recording("ancient-pending", createdAt = 1, status = RecordingStatus.PENDING)
        val uploading = recording("ancient-uploading", createdAt = 2, status = RecordingStatus.UPLOADING)
        val capturing = recording("ancient-capturing", createdAt = 3, status = RecordingStatus.CAPTURING)
        val newer = (10..30).map { recording("r$it", it.toLong()) }

        val plan = planWithEqualSizes(newer + listOf(stale, uploading, capturing))

        val droppedIds = plan.dropAudioFor.map { it.id }
        assertTrue(stale.id !in droppedIds)
        assertTrue(uploading.id !in droppedIds)
        assertTrue(capturing.id !in droppedIds)
    }

    @Test
    fun `audio is kept for a failure that will be retried`() {
        val retryable = recording("old-failure", createdAt = 1, status = RecordingStatus.FAILED, attempts = 1)
        val newer = (10..30).map { recording("r$it", it.toLong()) }

        val plan = planWithEqualSizes(newer + retryable)

        assertTrue(retryable.id !in plan.dropAudioFor.map { it.id })
    }

    @Test
    fun `audio is reclaimed once a failure has run out of attempts`() {
        // It can still be retried by hand, but not at the cost of holding
        // megabytes for something that has failed three times.
        val exhausted =
            recording(
                "given-up",
                createdAt = 1,
                status = RecordingStatus.FAILED,
                attempts = UploadPolicy.MAX_ATTEMPTS,
            )
        val newer = (10..30).map { recording("r$it", it.toLong()) }

        val plan = planWithEqualSizes(newer + exhausted)

        assertTrue(exhausted.id in plan.dropAudioFor.map { it.id })
    }

    @Test
    fun `an exempt backlog still pushes older audio out`() {
        // The realistic shape: a stretch offline leaves a queue of recent
        // recordings that cannot be pruned, with older transcribed ones
        // behind them. The queue's audio is real disk use, so it counts
        // against the budget even though it cannot be dropped — otherwise the
        // total quietly runs past the cap.
        val queued =
            (20..31).map { recording("queued$it", it.toLong(), status = RecordingStatus.PENDING) }
        val finished = (1..11).map { recording("done$it", it.toLong()) }

        val plan = planWithEqualSizes(queued + finished)

        // The queue alone is over budget, so nothing older keeps its audio.
        assertTrue(plan.dropAudioFor.map { it.id }.containsAll(finished.map { it.id }))
        assertTrue(plan.dropAudioFor.none { it.id.startsWith("queued") })
    }

    @Test
    fun `a queue larger than the budget still keeps all of its audio`() {
        // The one case where the cap is deliberately exceeded: this audio has
        // not been transcribed yet, so deleting it to stay under budget would
        // destroy the only copy of what was said.
        val queued =
            (1..15).map { recording("queued$it", it.toLong(), status = RecordingStatus.PENDING) }

        val plan = planWithEqualSizes(queued)

        assertTrue(plan.dropAudioFor.isEmpty())
    }

    @Test
    fun `a short history keeps everything`() {
        val plan = planWithEqualSizes(listOf(recording("a", 1), recording("b", 2)))

        assertEquals(2, plan.keep.size)
        assertTrue(plan.dropAudioFor.isEmpty())
    }

    @Test
    fun `entries come back newest first`() {
        val plan = planWithEqualSizes(listOf(recording("old", 1), recording("new", 9)))

        assertEquals(listOf("new", "old"), plan.keep.map { it.id })
    }
}
