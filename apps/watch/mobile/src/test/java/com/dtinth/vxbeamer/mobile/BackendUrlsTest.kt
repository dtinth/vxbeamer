package com.dtinth.vxbeamer.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The scheme case is not hypothetical: swapping to `ws`/`wss` — correct for
 * the browser's WebSocket API — threw `IllegalArgumentException: unexpected
 * scheme: wss` out of OkHttp before any connection was attempted, and it
 * took a device and a logcat to find (dtinth/vxbeamer#86).
 */
class BackendUrlsTest {
    @Test
    fun `websocket url keeps the http scheme rather than swapping to ws`() {
        val url = BackendUrls.webSocket("http://10.0.0.5:8787", "token", "ref", "client")

        assertEquals("http", url.scheme)
    }

    @Test
    fun `websocket url keeps https rather than swapping to wss`() {
        val url = BackendUrls.webSocket("https://vx.example.com", "token", "ref", "client")

        assertEquals("https", url.scheme)
    }

    @Test
    fun `websocket url replaces the path instead of appending to it`() {
        // A backend configured under a sub-path is still reached at /ws, the
        // same way buildBackendSocketUrl does it on the web.
        val url = BackendUrls.webSocket("https://example.com/vxbeamer/", "token", "ref", "client")

        assertEquals("/ws", url.encodedPath)
    }

    @Test
    fun `websocket url carries the credentials and ids`() {
        val url = BackendUrls.webSocket("https://example.com", "tok en", "ref/1", "client")

        assertEquals("tok en", url.queryParameter("access_token"))
        assertEquals("ref/1", url.queryParameter("reference_id"))
        assertEquals("client", url.queryParameter("client_id"))
    }

    @Test
    fun `websocket url drops any query the configured url carried`() {
        val url = BackendUrls.webSocket("https://example.com/?debug=1", "token", "ref", "client")

        assertEquals(null, url.queryParameter("debug"))
    }

    @Test
    fun `sse url replaces the path and carries the token`() {
        val url = BackendUrls.serverSentEvents("https://example.com/base?x=1", "token")

        assertEquals("/sse", url.encodedPath)
        assertEquals("token", url.queryParameter("access_token"))
        assertEquals(null, url.queryParameter("x"))
    }
}
