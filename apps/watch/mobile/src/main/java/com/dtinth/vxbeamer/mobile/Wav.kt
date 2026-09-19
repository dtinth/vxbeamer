package com.dtinth.vxbeamer.mobile

/**
 * Wraps raw captured PCM in a WAV header, so a recording can leave the app
 * as a file anything else can open (dtinth/vxbeamer#86).
 *
 * Deliberately byte-for-byte the same layout as `writeWav` in
 * `packages/vxasr/src/audio.ts`: 44-byte canonical header, uncompressed
 * PCM, little-endian, at this app's own capture format. Exported audio
 * should be indistinguishable from what the eval fixtures use, or it is not
 * much use for testing against them.
 */
object Wav {
    const val HEADER_BYTES = 44
    private const val BITS_PER_SAMPLE = 16
    private const val CHANNELS = 1
    private const val FORMAT_PCM: Short = 1

    fun encode(pcm: ByteArray, sampleRate: Int = AudioCapture.SAMPLE_RATE_HZ): ByteArray {
        require(pcm.size % 2 == 0) {
            "Raw PCM has an odd byte length (${pcm.size}); 16-bit samples cannot be odd-sized"
        }

        val bytesPerSample = BITS_PER_SAMPLE / 8
        val out = ByteArray(HEADER_BYTES + pcm.size)

        ascii(out, 0, "RIFF")
        // Everything after this field: the header's remaining 36 bytes plus
        // the payload.
        int32(out, 4, 36 + pcm.size)
        ascii(out, 8, "WAVE")

        ascii(out, 12, "fmt ")
        int32(out, 16, 16) // fmt chunk body size
        int16(out, 20, FORMAT_PCM)
        int16(out, 22, CHANNELS.toShort())
        int32(out, 24, sampleRate)
        int32(out, 28, sampleRate * CHANNELS * bytesPerSample) // byte rate
        int16(out, 32, (CHANNELS * bytesPerSample).toShort()) // block align
        int16(out, 34, BITS_PER_SAMPLE.toShort())

        ascii(out, 36, "data")
        int32(out, 40, pcm.size)
        pcm.copyInto(out, HEADER_BYTES)

        return out
    }

    private fun ascii(out: ByteArray, offset: Int, value: String) {
        for ((index, character) in value.withIndex()) {
            out[offset + index] = character.code.toByte()
        }
    }

    private fun int32(out: ByteArray, offset: Int, value: Int) {
        out[offset] = (value and 0xFF).toByte()
        out[offset + 1] = ((value shr 8) and 0xFF).toByte()
        out[offset + 2] = ((value shr 16) and 0xFF).toByte()
        out[offset + 3] = ((value shr 24) and 0xFF).toByte()
    }

    private fun int16(out: ByteArray, offset: Int, value: Short) {
        val intValue = value.toInt()
        out[offset] = (intValue and 0xFF).toByte()
        out[offset + 1] = ((intValue shr 8) and 0xFF).toByte()
    }
}
