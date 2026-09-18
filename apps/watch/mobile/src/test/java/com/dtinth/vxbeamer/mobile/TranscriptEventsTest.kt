package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `/sse` carries every message on the account — other devices, and this
 * device's earlier recordings — so an upload has to pick out its own. Not
 * doing so put somebody else's transcript on screen once already
 * (dtinth/vxbeamer#86), which is the reason these are tests and not a branch
 * buried in a listener.
 */
class TranscriptEventsTest {
    @Test
    fun `an updated event for this recording yields its partial`() {
        val json =
            """{"type":"updated","message":{"referenceId":"mine","partial":"hello th"}}"""

        val update = TranscriptEvents.parse(json, "mine")

        assertEquals(TranscriptUpdate.Partial("hello th"), update)
    }

    @Test
    fun `a final transcript is reported as final`() {
        val json =
            """{"type":"updated","message":{"referenceId":"mine","final":"hello there"}}"""

        val update = TranscriptEvents.parse(json, "mine")

        assertEquals(TranscriptUpdate.Final("hello there"), update)
    }

    @Test
    fun `another device's recording is ignored`() {
        val json =
            """{"type":"updated","message":{"referenceId":"theirs","final":"not mine"}}"""

        assertNull(TranscriptEvents.parse(json, "mine"))
    }

    @Test
    fun `a snapshot picks out this recording and ignores the rest`() {
        val json =
            """
            {"type":"snapshot","messages":[
              {"referenceId":"theirs","final":"not mine"},
              {"referenceId":"mine","final":"mine"},
              {"referenceId":"other","final":"also not mine"}
            ]}
            """.trimIndent()

        assertEquals(TranscriptUpdate.Final("mine"), TranscriptEvents.parse(json, "mine"))
    }

    @Test
    fun `a final arriving before the status flips is still final`() {
        // The backend can deliver the text one event ahead of status becoming
        // "done" — the same race isMessageCopyable has to handle on the web.
        val json =
            """{"type":"updated","message":{"referenceId":"mine","status":"recording","final":"done text"}}"""

        assertEquals(TranscriptUpdate.Final("done text"), TranscriptEvents.parse(json, "mine"))
    }

    @Test
    fun `an errored message is reported as failed with its reason`() {
        val json =
            """{"type":"updated","message":{"referenceId":"mine","status":"error","error":"provider exploded"}}"""

        assertEquals(TranscriptUpdate.Failed("provider exploded"), TranscriptEvents.parse(json, "mine"))
    }

    @Test
    fun `an errored message with no reason still fails rather than being ignored`() {
        val json = """{"type":"updated","message":{"referenceId":"mine","status":"error"}}"""

        assertTrue(TranscriptEvents.parse(json, "mine") is TranscriptUpdate.Failed)
    }

    @Test
    fun `unrelated event types are ignored`() {
        assertNull(TranscriptEvents.parse("""{"type":"deleted","messageId":"mine"}""", "mine"))
        assertNull(TranscriptEvents.parse("""{"type":"swiped","message":{}}""", "mine"))
    }

    @Test
    fun `malformed json is ignored rather than thrown`() {
        assertNull(TranscriptEvents.parse("not json at all", "mine"))
        assertNull(TranscriptEvents.parse("", "mine"))
    }

    @Test
    fun `a message with nothing to report yields nothing`() {
        val json = """{"type":"created","message":{"referenceId":"mine","status":"recording"}}"""

        assertNull(TranscriptEvents.parse(json, "mine"))
    }
}
