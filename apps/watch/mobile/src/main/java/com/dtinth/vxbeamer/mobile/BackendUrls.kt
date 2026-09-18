package com.dtinth.vxbeamer.mobile

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * Builds the backend's own URLs, mirroring `buildBackendSocketUrl` in
 * `apps/website/src/backendSocket.ts`: the path is *replaced*, not appended
 * to, any query the configured URL carried is dropped, and the parameters
 * are set fresh.
 *
 * Pulled out as pure functions because getting this wrong is silent and
 * expensive. It already was once: the scheme was being swapped to `ws`/`wss`
 * — right for the browser's WebSocket API, but OkHttp models only
 * `http`/`https` and upgrades the request itself, so `HttpUrl` threw
 * `IllegalArgumentException: unexpected scheme: wss` before any connection
 * was attempted. That shipped and needed a device to find
 * (dtinth/vxbeamer#86); it is a one-line unit test here.
 */
object BackendUrls {
    fun webSocket(
        backendUrl: String,
        accessToken: String,
        referenceId: String,
        clientId: String,
    ): HttpUrl =
        backendUrl.toHttpUrl().newBuilder()
            .encodedPath("/ws")
            .query(null)
            .addQueryParameter("access_token", accessToken)
            .addQueryParameter("reference_id", referenceId)
            .addQueryParameter("client_id", clientId)
            .build()

    fun serverSentEvents(backendUrl: String, accessToken: String): HttpUrl =
        backendUrl.toHttpUrl().newBuilder()
            .encodedPath("/sse")
            .query(null)
            .addQueryParameter("access_token", accessToken)
            .build()
}
