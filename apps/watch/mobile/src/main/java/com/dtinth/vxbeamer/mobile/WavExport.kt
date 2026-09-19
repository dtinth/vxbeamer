package com.dtinth.vxbeamer.mobile

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Hands one recording's audio to another app as a WAV, for listening to or
 * testing a transcription against (dtinth/vxbeamer#86).
 *
 * Shared through a [FileProvider] scoped to a single cache directory rather
 * than written somewhere world-readable: the app's own storage also holds
 * every other recording and the auth tokens, and a share should expose one
 * file, not the drawer it came from.
 */
object WavExport {
    private const val DIRECTORY = "exports"

    /** An intent that shares [id]'s audio, or null if there is no audio left. */
    fun shareIntent(context: Context, id: String): Intent? {
        val wav = Recorder.store.wavBytes(id) ?: return null
        val recording = Recorder.store.get(id) ?: return null

        val directory = File(context.cacheDir, DIRECTORY).apply { mkdirs() }
        // Previous exports are cleared each time: they are copies, and the
        // originals are still in the store.
        directory.listFiles()?.forEach { it.delete() }

        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date(recording.createdAt))
        val file = File(directory, "vxbeamer-$stamp.wav")
        runCatching { file.writeBytes(wav) }.getOrElse { return null }

        val uri =
            FileProvider.getUriForFile(context, "${context.packageName}.exports", file)
        return Intent(Intent.ACTION_SEND).apply {
            type = "audio/wav"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, file.name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }
}
