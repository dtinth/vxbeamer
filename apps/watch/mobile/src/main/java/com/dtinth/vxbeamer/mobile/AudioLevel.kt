package com.dtinth.vxbeamer.mobile

import kotlin.math.min
import kotlin.math.sqrt

/**
 * Turns a chunk of PCM into a 0..1 loudness for the level meter.
 *
 * RMS rather than peak, so one stray click does not pin the meter for a
 * frame, and scaled by [FULL_SCALE] rather than the sample range: ordinary
 * speech sits far below a full-scale sine, so a true 0..32767 mapping would
 * leave the meter barely twitching (dtinth/vxbeamer#86).
 */
object AudioLevel {
    /** Roughly the RMS of comfortable speech close to a phone's mic. */
    const val FULL_SCALE = 6000.0

    /** [buffer] is signed 16-bit little-endian; only the first [length] bytes are read. */
    fun of(buffer: ByteArray, length: Int): Float {
        var sumOfSquares = 0.0
        var count = 0
        var index = 0
        while (index + 1 < length) {
            val sample = ((buffer[index + 1].toInt() shl 8) or (buffer[index].toInt() and 0xFF)).toShort().toInt()
            sumOfSquares += sample.toDouble() * sample.toDouble()
            count++
            index += 2
        }
        if (count == 0) return 0f
        return min(1.0, sqrt(sumOfSquares / count) / FULL_SCALE).toFloat()
    }
}
