package com.dtinth.vxbeamer.mobile

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject

/**
 * Signing in with a link from the backend's `/pair` page, instead of running
 * the OIDC flow here: the link is `<backend>/pair#<code>`, so it names the
 * backend as well as the code, and the app hardcodes neither. Mirrors
 * `apps/website/src/pairing.ts`.
 */
object Pairing {
    private val CODE = Regex("^[0-9A-HJKMNP-TV-Z]{12}$")

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

    suspend fun redeem(link: Link): Session.Tokens {
        val json = Session.postJson(link.backendUrl + "/auth/pair", JSONObject().put("code", link.code))
        return Session.Tokens(
            accessToken = json.getString("access_token"),
            refreshToken = json.getString("refresh_token"),
        )
    }
}
