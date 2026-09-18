package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pacing is always safe and dumping is not, so every case this cannot read
 * confidently has to come back false.
 */
class BackendCapabilitiesTest {
    private fun response(primary: String, vararg configurations: Pair<String, Boolean>): String {
        val entries =
            configurations.joinToString(",") { (id, fast) ->
                """{"id":"$id","supportsFastDump":$fast}"""
            }
        return """{"primaryConfigurationId":"$primary","configurations":[$entries]}"""
    }

    @Test
    fun `a batch provider accepts a fast dump`() {
        val json = response("openrouter/meta/muse-voice-transcribe-1.0", "openrouter/meta/muse-voice-transcribe-1.0" to true)

        assertTrue(BackendCapabilities.fastDumpSupported(json))
    }

    @Test
    fun `a realtime provider does not`() {
        val json = response("openai/gpt-live-transcribe", "openai/gpt-live-transcribe" to false)

        assertFalse(BackendCapabilities.fastDumpSupported(json))
    }

    @Test
    fun `the primary is what matters, not the others`() {
        // Every configured model is listed; only the one actually in use
        // decides how this recording may be sent.
        val json =
            response(
                "openai/gpt-live-transcribe",
                "openrouter/meta/muse-voice-transcribe-1.0" to true,
                "openai/gpt-live-transcribe" to false,
            )

        assertFalse(BackendCapabilities.fastDumpSupported(json))
    }

    @Test
    fun `anything unreadable falls back to pacing`() {
        assertFalse(BackendCapabilities.fastDumpSupported("not json"))
        assertFalse(BackendCapabilities.fastDumpSupported(""))
        assertFalse(BackendCapabilities.fastDumpSupported("""{"configurations":[]}"""))
        assertFalse(BackendCapabilities.fastDumpSupported("""{"primaryConfigurationId":"x"}"""))
        // A primary that is not in the list at all — an older backend, or a
        // configuration removed between the two being assembled.
        assertFalse(BackendCapabilities.fastDumpSupported(response("missing", "other" to true)))
        // Present, but the field is absent: an older backend that does not
        // publish it yet must not be read as permission.
        assertFalse(
            BackendCapabilities.fastDumpSupported(
                """{"primaryConfigurationId":"a","configurations":[{"id":"a"}]}""",
            ),
        )
    }
}
