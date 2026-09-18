package com.dtinth.vxbeamer.mobile

import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * The tailing read is the subtlest thing in this app: getting it wrong does
 * not fail, it silently sends slightly less audio than was recorded. It cost
 * the end of every recording once (dtinth/vxbeamer#86), so the ordering is
 * pinned here rather than left to be re-derived.
 *
 * These use `runBlocking` on a real dispatcher rather than `runTest`: the
 * behaviour under test *is* the interleaving of a reader and a writer, and
 * `runTest`'s virtual time would skip the waiting that makes it a race at
 * all.
 */
class PcmTailTest {
    private lateinit var file: File

    @Before
    fun setUp() {
        file = File.createTempFile("tail", ".pcm")
    }

    @After
    fun tearDown() {
        file.delete()
    }

    private fun audio(bytes: Int, value: Byte = 1) = ByteArray(bytes) { value }

    /** Collects what the tail reader sends, with a timeout so a bug that hangs fails instead. */
    private fun stream(captureFinished: () -> Boolean, whileStreaming: () -> Unit = {}): List<ByteArray> =
        runBlocking {
            val sent = java.util.Collections.synchronizedList(mutableListOf<ByteArray>())
            val streaming =
                async(Dispatchers.IO) { PcmTail.stream(file, captureFinished) { sent += it } }
            whileStreaming()
            withTimeout(10_000) { streaming.await() }
            sent.toList()
        }

    @Test
    fun `a finished file is sent in full`() {
        file.writeBytes(audio(PcmTail.CHUNK_BYTES * 2 + 100))

        val sent = stream(captureFinished = { true })

        assertEquals(PcmTail.CHUNK_BYTES * 2 + 100, sent.sumOf { it.size })
    }

    @Test
    fun `an empty finished file sends nothing and returns`() {
        assertEquals(0, stream(captureFinished = { true }).size)
    }

    @Test
    fun `audio written after the reader caught up is still sent`() {
        // The live case: the reader reaches the end of the file long before
        // the speaker has finished.
        val holder = object { @Volatile var done = false }

        val sent =
            stream(captureFinished = { holder.done }) {
                file.appendBytes(audio(PcmTail.CHUNK_BYTES))
                Thread.sleep(150)
                file.appendBytes(audio(PcmTail.CHUNK_BYTES))
                Thread.sleep(150)
                holder.done = true
            }

        assertEquals(PcmTail.CHUNK_BYTES * 2, sent.sumOf { it.size })
    }

    @Test
    fun `the last chunk is not lost when it lands as capture finishes`() {
        // The regression this exists for, forced rather than raced.
        //
        // A real writer flushes its final chunk and only then closes the
        // file, so audio can appear between the reader's last look and the
        // moment it is told capture is over. That window is microseconds
        // wide, so provoking it with sleeps is hopeless — instead the
        // finished-check itself writes the tail, which puts the write in
        // exactly that gap every time.
        //
        // Sampling the flag *after* the read sees "finished" about a read
        // taken before the tail existed, and stops one chunk early. Sampling
        // it before means the read that follows picks the tail up.
        // The file starts empty, so the read that matters is one that comes
        // back with nothing — which is the only case where the order of the
        // two decides whether the tail is ever seen.
        var tailWritten = false

        val sent =
            stream(
                captureFinished = {
                    if (!tailWritten) {
                        tailWritten = true
                        file.appendBytes(audio(PcmTail.CHUNK_BYTES, value = 7))
                    }
                    true
                },
            )

        assertEquals("the tail was dropped", PcmTail.CHUNK_BYTES, sent.sumOf { it.size })
        assertArrayEquals(audio(PcmTail.CHUNK_BYTES, 7), sent.last())
    }

    @Test
    fun `a partial trailing chunk is sent at its real length`() {
        // 100 ms chunks rarely divide an utterance evenly; the remainder is
        // real audio, not padding.
        file.writeBytes(audio(PcmTail.CHUNK_BYTES + 7))

        val sent = stream(captureFinished = { true })

        assertEquals(2, sent.size)
        assertEquals(7, sent.last().size)
    }

    @Test
    fun `chunks are copies, so a later read cannot alter what was sent`() {
        file.writeBytes(audio(PcmTail.CHUNK_BYTES, value = 1) + audio(PcmTail.CHUNK_BYTES, value = 2))

        val sent = stream(captureFinished = { true })

        // The read buffer is reused; handing it out directly would mean the
        // socket sent whatever happened to be in it by the time it flushed.
        assertArrayEquals(audio(PcmTail.CHUNK_BYTES, 1), sent[0])
        assertArrayEquals(audio(PcmTail.CHUNK_BYTES, 2), sent[1])
    }
}
