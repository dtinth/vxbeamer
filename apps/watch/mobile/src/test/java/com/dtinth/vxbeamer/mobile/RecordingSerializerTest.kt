package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingSerializerTest {
    @Test
    fun `a recording survives a round trip`() {
        val recordings =
            listOf(
                Recording(
                    id = "a",
                    createdAt = 1_700_000_000_000,
                    status = RecordingStatus.DONE,
                    durationMs = 9_218,
                    transcript = "โปรเจกต์นี้เขียนด้วยภาษา TypeScript",
                    attempts = 2,
                ),
                Recording(
                    id = "b",
                    createdAt = 1_700_000_001_000,
                    status = RecordingStatus.FAILED,
                    durationMs = 1_000,
                    error = "unexpected scheme: wss",
                    attempts = 3,
                ),
            )

        assertEquals(recordings, RecordingSerializer.decode(RecordingSerializer.encode(recordings)))
    }

    @Test
    fun `absent transcript and error decode as null rather than empty strings`() {
        val recording = Recording(id = "a", createdAt = 1, status = RecordingStatus.PENDING)

        val decoded = RecordingSerializer.decode(RecordingSerializer.encode(listOf(recording)))

        assertEquals(null, decoded.single().transcript)
        assertEquals(null, decoded.single().error)
    }

    @Test
    fun `an empty list round trips`() {
        assertTrue(RecordingSerializer.decode(RecordingSerializer.encode(emptyList())).isEmpty())
    }

    // --- History is a convenience, never a reason to fail to start ---

    @Test
    fun `a corrupt file decodes as empty rather than throwing`() {
        assertTrue(RecordingSerializer.decode("{ this is not the index }").isEmpty())
        assertTrue(RecordingSerializer.decode("").isEmpty())
    }

    @Test
    fun `entries that cannot be understood are skipped, not fatal`() {
        // A status this build does not know, and an entry with no id at all —
        // both plausible from an older or half-written file.
        val json =
            """
            [
              {"id":"good","createdAt":5,"status":"DONE"},
              {"id":"future","createdAt":6,"status":"TELEPORTING"},
              {"createdAt":7,"status":"DONE"}
            ]
            """.trimIndent()

        val decoded = RecordingSerializer.decode(json)

        assertEquals(listOf("good"), decoded.map { it.id })
    }
}
