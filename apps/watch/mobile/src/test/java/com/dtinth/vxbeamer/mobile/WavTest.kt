package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * An exported file is only useful if other tools can actually open it, and
 * if it matches the fixtures the eval uses — so the header is checked field
 * by field against the layout `packages/vxasr/src/audio.ts` writes.
 */
class WavTest {
    private fun ascii(bytes: ByteArray, offset: Int, length: Int) =
        String(bytes, offset, length, Charsets.US_ASCII)

    private fun int32(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or
            ((bytes[offset + 1].toInt() and 0xFF) shl 8) or
            ((bytes[offset + 2].toInt() and 0xFF) shl 16) or
            ((bytes[offset + 3].toInt() and 0xFF) shl 24)

    private fun int16(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or ((bytes[offset + 1].toInt() and 0xFF) shl 8)

    @Test
    fun `the header describes this app's capture format`() {
        val pcm = ByteArray(3200) { 3 }

        val wav = Wav.encode(pcm)

        assertEquals("RIFF", ascii(wav, 0, 4))
        assertEquals("WAVE", ascii(wav, 8, 4))
        assertEquals("fmt ", ascii(wav, 12, 4))
        assertEquals(16, int32(wav, 16)) // fmt body size
        assertEquals(1, int16(wav, 20)) // uncompressed PCM
        assertEquals(1, int16(wav, 22)) // mono
        assertEquals(16_000, int32(wav, 24)) // sample rate
        assertEquals(32_000, int32(wav, 28)) // byte rate: 16000 * 1 * 2
        assertEquals(2, int16(wav, 32)) // block align
        assertEquals(16, int16(wav, 34)) // bits per sample
        assertEquals("data", ascii(wav, 36, 4))
    }

    @Test
    fun `the sizes account for the payload`() {
        val pcm = ByteArray(1000)

        val wav = Wav.encode(pcm)

        assertEquals(Wav.HEADER_BYTES + pcm.size, wav.size)
        // Everything after the RIFF size field itself.
        assertEquals(36 + pcm.size, int32(wav, 4))
        assertEquals(pcm.size, int32(wav, 40))
    }

    @Test
    fun `the audio is copied through unchanged`() {
        val pcm = ByteArray(64) { (it * 3).toByte() }

        val wav = Wav.encode(pcm)

        assertArrayEquals(pcm, wav.copyOfRange(Wav.HEADER_BYTES, wav.size))
    }

    @Test
    fun `an empty recording still produces a valid header`() {
        val wav = Wav.encode(ByteArray(0))

        assertEquals(Wav.HEADER_BYTES, wav.size)
        assertEquals(0, int32(wav, 40))
        assertEquals(36, int32(wav, 4))
    }

    @Test
    fun `an odd byte count is rejected rather than written out misaligned`() {
        // 16-bit samples cannot be an odd number of bytes; writing it anyway
        // would produce a file that opens but is shifted by one byte.
        assertThrows(IllegalArgumentException::class.java) { Wav.encode(ByteArray(3201)) }
    }
}
