package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.annotation.RequiresPermission
import java.io.File

/**
 * The microphone, writing straight to a file.
 *
 * Nothing here knows about the network. Capture's only job is to get audio
 * onto disk as it is spoken, so that stopping is instant and the recording
 * exists whether or not anything ever manages to upload it
 * (dtinth/vxbeamer#86).
 *
 * 16 kHz / 16-bit / mono little-endian, which is exactly what vxbeamer's
 * `/ws` expects, so no conversion happens anywhere in this app.
 */
object AudioCapture {
    const val SAMPLE_RATE_HZ = 16000
    private const val CHUNK_BYTES = 3200 // 100 ms
    private const val MIN_BUFFER_MULTIPLIER = 4

    /**
     * Records into [file] until [shouldContinue] goes false, reporting
     * loudness through [onLevel]. Blocking: call it off the main thread.
     *
     * Throws if the mic cannot be opened, which the caller surfaces as a
     * failed recording rather than a silent no-op.
     */
    @RequiresPermission(Manifest.permission.RECORD_AUDIO)
    fun record(file: File, shouldContinue: () -> Boolean, onLevel: (Float) -> Unit) {
        val minBuffer =
            AudioRecord.getMinBufferSize(
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
        check(minBuffer > 0) { "This device cannot record 16 kHz mono PCM" }

        val recorder =
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuffer * MIN_BUFFER_MULTIPLIER,
            )
        check(recorder.state == AudioRecord.STATE_INITIALIZED) {
            "Could not open the microphone"
        }

        val buffer = ByteArray(CHUNK_BYTES)
        try {
            recorder.startRecording()
            // Appending and flushing per chunk, so the uploader tailing this
            // file sees the audio as it is spoken rather than at the end.
            file.outputStream().use { output ->
                while (shouldContinue()) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read <= 0) break
                    output.write(buffer, 0, read)
                    output.flush()
                    onLevel(AudioLevel.of(buffer, read))
                }
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
            onLevel(0f)
        }
    }
}
