package com.dtinth.vxbeamer.mobile

import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioLevelTest {
    /** Little-endian signed 16-bit, the format the mic and `/ws` both use. */
    private fun pcm(samples: List<Int>): ByteArray {
        val bytes = ByteArray(samples.size * 2)
        samples.forEachIndexed { index, sample ->
            bytes[index * 2] = (sample and 0xFF).toByte()
            bytes[index * 2 + 1] = ((sample shr 8) and 0xFF).toByte()
        }
        return bytes
    }

    @Test
    fun `silence reads as zero`() {
        val silence = pcm(List(160) { 0 })

        assertEquals(0f, AudioLevel.of(silence, silence.size), 0.0001f)
    }

    @Test
    fun `an empty buffer reads as zero rather than dividing by zero`() {
        assertEquals(0f, AudioLevel.of(ByteArray(0), 0), 0.0001f)
        assertEquals(0f, AudioLevel.of(ByteArray(2), 1), 0.0001f)
    }

    @Test
    fun `a loud signal saturates at one`() {
        val loud = pcm(List(160) { 32_000 })

        assertEquals(1f, AudioLevel.of(loud, loud.size), 0.0001f)
    }

    @Test
    fun `speech-level audio lands in the usable middle of the range`() {
        // The scale is tuned for speech, not for full-scale sine waves: a
        // true 0..32767 mapping would leave the meter barely twitching.
        val speech = pcm((0 until 160).map { (3_000 * sin(it / 4.0)).toInt() })

        val level = AudioLevel.of(speech, speech.size)

        assertTrue("expected a visible level, got $level", level > 0.2f)
        assertTrue("expected headroom left, got $level", level < 0.9f)
    }

    @Test
    fun `louder audio reads higher than quieter audio`() {
        val quiet = pcm(List(160) { 500 })
        val loud = pcm(List(160) { 4_000 })

        assertTrue(AudioLevel.of(loud, loud.size) > AudioLevel.of(quiet, quiet.size))
    }

    @Test
    fun `negative samples count as loudly as positive ones`() {
        // RMS, not a mean — a waveform swinging negative is not silence.
        val positive = pcm(List(160) { 3_000 })
        val negative = pcm(List(160) { -3_000 })

        assertEquals(
            AudioLevel.of(positive, positive.size),
            AudioLevel.of(negative, negative.size),
            0.0001f,
        )
    }

    @Test
    fun `only the bytes actually read are measured`() {
        // AudioRecord fills part of a reused buffer; stale tail bytes from an
        // earlier, louder chunk must not count.
        val buffer = pcm(List(160) { 0 } + List(160) { 30_000 })

        assertEquals(0f, AudioLevel.of(buffer, 320), 0.0001f)
    }

    @Test
    fun `duration is derived from pcm length`() {
        // 16 kHz, 16-bit, mono — 32 bytes per millisecond.
        assertEquals(1_000, durationMsForPcmBytes(32_000))
        assertEquals(0, durationMsForPcmBytes(0))
    }
}
