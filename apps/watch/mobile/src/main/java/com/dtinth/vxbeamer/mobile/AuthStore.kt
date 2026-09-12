package com.dtinth.vxbeamer.mobile

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * Backend URL and tokens, encrypted at rest — the same three values the web
 * app keeps in `localStorage` (dtinth/vxbeamer#86), just under Android's own
 * encrypted-prefs equivalent instead.
 */
class AuthStore(context: Context) {
    private val prefs: SharedPreferences =
        EncryptedSharedPreferences.create(
            context,
            "vxbeamer_auth",
            MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

    var backendUrl: String
        get() = prefs.getString(KEY_BACKEND_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BACKEND_URL, value).apply()

    var accessToken: String?
        get() = prefs.getString(KEY_ACCESS_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_ACCESS_TOKEN, value).apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_REFRESH_TOKEN, value).apply()

    val isSignedIn: Boolean
        get() = !accessToken.isNullOrEmpty() && !refreshToken.isNullOrEmpty()

    fun saveTokens(tokens: Oidc.Tokens) {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
    }

    fun signOut() {
        prefs.edit().remove(KEY_ACCESS_TOKEN).remove(KEY_REFRESH_TOKEN).apply()
    }

    /**
     * The access token to use for the next relay session, refreshing first
     * if it is within [EXPIRY_BUFFER_SECONDS] of expiring. The web app also
     * has a "still fine, refresh quietly in the background" middle zone
     * (`apps/website/src/store.ts`'s `obtainSessionToken`) to keep an
     * interactive recording from ever waiting on a refresh — this app only
     * ever needs a token once, at the start of a relay session, so that
     * extra zone buys nothing here worth the complexity.
     */
    suspend fun currentAccessToken(): String {
        val token = accessToken ?: error("Not signed in")
        val exp = decodeExpiry(token)
        val nowSeconds = System.currentTimeMillis() / 1000
        if (exp == null || exp - nowSeconds < EXPIRY_BUFFER_SECONDS) {
            val refreshed = Oidc.refresh(backendUrl, refreshToken ?: error("Not signed in"))
            saveTokens(refreshed)
            return refreshed.accessToken
        }
        return token
    }

    private fun decodeExpiry(token: String): Long? {
        val segments = token.split(".")
        if (segments.size != 3) return null
        return runCatching {
            val payload = Base64.decode(segments[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            JSONObject(String(payload, Charsets.UTF_8)).getLong("exp")
        }.getOrNull()
    }

    companion object {
        private const val KEY_BACKEND_URL = "backend_url"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val EXPIRY_BUFFER_SECONDS = 5 * 60
    }
}
