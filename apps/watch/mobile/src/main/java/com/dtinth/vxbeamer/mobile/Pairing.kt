package com.dtinth.vxbeamer.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Signing in with a link from the backend's `/pair` page, instead of running
 * the OIDC flow here: the link is `<backend>/pair#<code>`, so it names the
 * backend as well as the code, and the app hardcodes neither. Mirrors
 * `apps/website/src/pairing.ts`.
 */
object Pairing {
    private val CODE = Regex("^[0-9A-HJKMNP-TV-Z]{12}$")
    private val JSON = "application/json".toMediaType()
    private val client = OkHttpClient()

    data class Link(val backendUrl: String, val code: String)

    /** Reads a pairing link as pasted or scanned. `null` when it is not one. */
    fun parseLink(input: String): Link? {
        val url = input.trim().toHttpUrlOrNull() ?: return null
        val isLocal = url.host == "localhost" || url.host == "127.0.0.1"
        if (!url.isHttps && !isLocal) return null
        if (url.encodedPath.trimEnd('/') != "/pair") return null
        val code = url.fragment.orEmpty().filterNot { it.isWhitespace() || it == '-' }.uppercase()
        if (!CODE.matches(code)) return null
        val port = if (url.port == HttpUrl.defaultPort(url.scheme)) "" else ":${url.port}"
        return Link("${url.scheme}://${url.host}$port", code)
    }

    suspend fun redeem(link: Link): Session.Tokens =
        withContext(Dispatchers.IO) {
            val request =
                Request.Builder()
                    .url(link.backendUrl + "/auth/pair")
                    .post(JSONObject().put("code", link.code).toString().toRequestBody(JSON))
                    .build()
            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val reason = runCatching { JSONObject(body).getString("error") }.getOrNull()
                    error(reason ?: "Pairing failed: HTTP ${response.code}")
                }
                val json = JSONObject(body)
                Session.Tokens(
                    accessToken = json.getString("access_token"),
                    refreshToken = json.getString("refresh_token"),
                )
            }
        }
}
