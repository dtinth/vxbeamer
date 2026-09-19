package com.dtinth.vxbeamer.mobile

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Same "desktop" sign-in flow the Tauri app already uses (dtinth/vxbeamer#86)
 * — this app never receives the OIDC redirect itself. The browser lands on
 * vxbeamer's hosted web app, which shows a "here is your code" screen (its
 * `redirect_uri` is fixed to that page, see [DESKTOP_REDIRECT_URI]); the
 * operator copies that code and pastes it in here. This mirrors
 * `apps/website/src/oidc.ts`'s `createAuthUrl`/`exchangeDesktopCode`
 * function for function — nothing on the backend or website needed to
 * change for a second app to reuse this same path.
 */
object Oidc {
    private const val DESKTOP_REDIRECT_URI = "https://vxbeamer.vercel.app/"
    private val client = OkHttpClient()

    data class AuthConfig(val clientId: String, val authorizationEndpoint: String, val tokenEndpoint: String)

    data class PendingSignIn(val authUrl: String, val codeVerifier: String, val state: String)

    data class Tokens(val accessToken: String, val refreshToken: String)

    suspend fun fetchAuthConfig(backendUrl: String): AuthConfig =
        onIoDispatcher {
            val request = Request.Builder().url(urlJoin(backendUrl, "/auth/config")).build()
            val body = executeForBody(request, "Failed to fetch auth config")
            val json = JSONObject(body)
            AuthConfig(
                clientId = json.getString("clientId"),
                authorizationEndpoint = json.getString("authorizationEndpoint"),
                tokenEndpoint = json.getString("tokenEndpoint"),
            )
        }

    suspend fun beginSignIn(backendUrl: String): PendingSignIn {
        val config = fetchAuthConfig(backendUrl)
        val codeVerifier = randomUrlSafeString(32)
        val codeChallenge = sha256UrlSafe(codeVerifier)
        val state = "desktop:${UUID.randomUUID()}"

        val authUrl =
            config.authorizationEndpoint.toHttpUrl().newBuilder()
                .addQueryParameter("response_type", "code")
                .addQueryParameter("client_id", config.clientId)
                .addQueryParameter("redirect_uri", DESKTOP_REDIRECT_URI)
                .addQueryParameter("scope", "openid profile")
                .addQueryParameter("code_challenge", codeChallenge)
                .addQueryParameter("code_challenge_method", "S256")
                .addQueryParameter("state", state)
                .build()

        return PendingSignIn(authUrl.toString(), codeVerifier, state)
    }

    /** [pastedCode] is the `<code>#<state>` string copied from the browser. */
    suspend fun completeSignIn(
        backendUrl: String,
        pastedCode: String,
        codeVerifier: String,
        expectedState: String,
    ): Tokens =
        onIoDispatcher {
            val parts = pastedCode.split("#", limit = 2)
            require(parts.size == 2) { "Invalid code format — expected <code>#<state>" }
            val (code, returnedState) = parts
            require(returnedState == expectedState) { "State mismatch — did you paste the right code?" }

            val config = fetchAuthConfig(backendUrl)
            val tokenBody =
                FormBody.Builder()
                    .add("grant_type", "authorization_code")
                    .add("client_id", config.clientId)
                    .add("code", code)
                    .add("redirect_uri", DESKTOP_REDIRECT_URI)
                    .add("code_verifier", codeVerifier)
                    .build()
            val tokenRequest = Request.Builder().url(config.tokenEndpoint).post(tokenBody).build()
            val tokenResponseBody = executeForBody(tokenRequest, "Token exchange failed")
            val idToken =
                JSONObject(tokenResponseBody).optString("id_token").ifEmpty {
                    error("No id_token in token response")
                }

            val sessionRequest =
                Request.Builder()
                    .url(urlJoin(backendUrl, "/auth/session"))
                    .post(JSONObject().put("id_token", idToken).toString().toRequestBody(JSON))
                    .build()
            val sessionBody = executeForBody(sessionRequest, "Session creation failed")
            val session = JSONObject(sessionBody)
            Tokens(
                accessToken = session.getString("access_token"),
                refreshToken = session.getString("refresh_token"),
            )
        }

    suspend fun refresh(backendUrl: String, refreshToken: String): Tokens =
        onIoDispatcher {
            val request =
                Request.Builder()
                    .url(urlJoin(backendUrl, "/auth/refresh"))
                    .post(JSONObject().put("refresh_token", refreshToken).toString().toRequestBody(JSON))
                    .build()
            val body = executeForBody(request, "Refresh failed")
            val session = JSONObject(body)
            Tokens(
                accessToken = session.getString("access_token"),
                refreshToken = session.optString("refresh_token", refreshToken),
            )
        }

    private fun executeForBody(request: Request, errorPrefix: String): String {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("$errorPrefix: HTTP ${response.code} $body")
            return body
        }
    }

    private val JSON = "application/json".toMediaType()

    private suspend fun <T> onIoDispatcher(block: suspend () -> T): T = withContext(Dispatchers.IO) { block() }

    private fun randomUrlSafeString(byteLength: Int): String {
        val bytes = ByteArray(byteLength)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun sha256UrlSafe(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    }

    private fun urlJoin(base: String, path: String): String = base.trimEnd('/') + path
}
