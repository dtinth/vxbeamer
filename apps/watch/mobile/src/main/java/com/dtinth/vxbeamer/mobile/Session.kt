package com.dtinth.vxbeamer.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * The backend's access and refresh tokens. A client gets its first pair by
 * redeeming a pairing code ([Pairing]) and keeps it alive with [refresh].
 */
object Session {
    private val client = OkHttpClient()
    private val JSON = "application/json".toMediaType()

    data class Tokens(val accessToken: String, val refreshToken: String)

    suspend fun refresh(backendUrl: String, refreshToken: String): Tokens {
        val session = postJson(backendUrl.trimEnd('/') + "/auth/refresh", JSONObject().put("refresh_token", refreshToken))
        return Tokens(
            accessToken = session.getString("access_token"),
            refreshToken = session.optString("refresh_token", refreshToken),
        )
    }

    /** POSTs [body] as JSON. Fails with the backend's own `error` text when it has one. */
    internal suspend fun postJson(url: String, body: JSONObject): JSONObject =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(url).post(body.toString().toRequestBody(JSON)).build()
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val reason = runCatching { JSONObject(text).getString("error") }.getOrNull()
                    error(reason ?: "HTTP ${response.code}")
                }
                JSONObject(text)
            }
        }
}
