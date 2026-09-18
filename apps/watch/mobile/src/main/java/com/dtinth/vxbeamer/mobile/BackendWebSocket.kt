package com.dtinth.vxbeamer.mobile

import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

/**
 * A thin wrapper around vxbeamer's `/ws` — the same endpoint and wire
 * protocol the browser uses (raw PCM binary frames, a `{"type":"stop"}` text
 * frame to finish), so this app has nothing of its own to keep in sync with
 * the backend (dtinth/vxbeamer#86).
 *
 * One socket per upload, and no retry here: retrying is
 * [TranscriptionUploader]'s business, because the audio is on disk and a
 * failed attempt can simply be run again later. The URL is built by
 * [BackendUrls], which is where the `ws`/`wss` scheme trap is documented.
 */
class BackendWebSocket private constructor(private val socket: WebSocket) {
    fun send(chunk: ByteArray) {
        socket.send(chunk.toByteString())
    }

    fun stop() {
        socket.send("""{"type":"stop"}""")
        socket.close(NORMAL_CLOSURE, null)
    }

    fun abort() {
        socket.cancel()
    }

    companion object {
        private const val NORMAL_CLOSURE = 1000
        private val client = OkHttpClient()

        /** Suspends until the socket is open or the connect fails. */
        suspend fun connect(url: HttpUrl): BackendWebSocket =
            suspendCoroutine { continuation ->
                val request = Request.Builder().url(url).build()
                val listener =
                    object : WebSocketListener() {
                        var resumed = false

                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            if (resumed) return
                            resumed = true
                            continuation.resume(BackendWebSocket(webSocket))
                        }

                        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                            if (resumed) return
                            resumed = true
                            continuation.resumeWithException(t)
                        }
                    }
                client.newWebSocket(request, listener)
            }

        /** One id per process, mirroring the web app's own per-page-load
         *  `CLIENT_ID` (`recordingConnection.ts`) — lets a sticky-session
         *  provider like qwen-omni recognise repeat uploads from this app as
         *  the same caller, if one ever runs behind it. */
        val CLIENT_ID: String = UUID.randomUUID().toString()
    }
}
