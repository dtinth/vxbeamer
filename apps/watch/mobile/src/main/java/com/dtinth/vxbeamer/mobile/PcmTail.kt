package com.dtinth.vxbeamer.mobile

import java.io.File
import kotlinx.coroutines.delay

/**
 * Reads a PCM file that may still be being written, and hands out whole
 * chunks of it.
 *
 * This is how a recording reaches the backend while it is still being
 * spoken: capture appends to the file, this tails it. The same call against
 * a file nobody is writing any more simply reads it to the end, which is
 * what a retry is (dtinth/vxbeamer#86).
 *
 * Pulled out of [TranscriptionUploader] to be testable, because the ordering
 * below is subtle and getting it wrong is almost invisible: it silently
 * truncates the end of a recording rather than failing.
 */
object PcmTail {
    const val CHUNK_BYTES = 3200 // 100 ms at 16 kHz / 16-bit / mono

    /** Never send faster than this multiple of real time — see [stream]. */
    const val MAX_SPEED_MULTIPLIER = 8

    private const val WAIT_FOR_AUDIO_MS = 40L

    /**
     * Sends [file] to [send] until capture is finished and the file is
     * exhausted.
     *
     * [captureFinished] must mean "the writer has closed the file", not "the
     * user asked it to stop" — the two are not the same moment, and a writer
     * that is still flushing its last chunk would otherwise be cut off.
     *
     * [fastDump] sends with no pacing at all, for a backend whose provider
     * says it accepts that (see [BackendCapabilities]). Otherwise sending is
     * capped at [MAX_SPEED_MULTIPLIER] times real time, since a realtime
     * provider expects roughly the pace the audio was spoken at and a
     * backlog item would otherwise arrive all at once.
     */
    suspend fun stream(
        file: File,
        captureFinished: () -> Boolean,
        fastDump: Boolean = false,
        send: (ByteArray) -> Unit,
    ) {
        val buffer = ByteArray(CHUNK_BYTES)
        // Pacing only ever bites on a retry or a backlog: a live recording
        // paces itself, because the bytes are not there yet.
        val minimumChunkIntervalMs =
            if (fastDump) 0L else ((CHUNK_BYTES / PCM_BYTES_PER_MS) / MAX_SPEED_MULTIPLIER).toLong()

        file.inputStream().use { stream ->
            while (true) {
                // Sampled *before* the read, and this order is the whole
                // point: a chunk written between the read and the check would
                // otherwise be lost, because the check would say "finished"
                // about a read taken before that chunk existed. Since the
                // uploader runs ahead of real time and spends most of a
                // recording waiting, that was every recording's last chunk.
                val finished = captureFinished()
                val read = stream.read(buffer)
                if (read > 0) {
                    send(if (read == buffer.size) buffer.copyOf() else buffer.copyOf(read))
                    if (minimumChunkIntervalMs > 0) delay(minimumChunkIntervalMs)
                    continue
                }
                if (finished) break
                delay(WAIT_FOR_AUDIO_MS)
            }
        }
    }
}
