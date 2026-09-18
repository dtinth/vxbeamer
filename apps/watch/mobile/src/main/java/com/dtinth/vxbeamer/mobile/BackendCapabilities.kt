package com.dtinth.vxbeamer.mobile

import org.json.JSONObject

/**
 * What the backend says about the model it is configured to use.
 *
 * Only one thing is needed so far: whether the provider behind the primary
 * configuration tolerates being sent a whole recording at once. The backend
 * already publishes it on `/asr/configurations` (`supportsFastDump`, from
 * `ProviderSpec` in vxasr), so this asks rather than guesses — a batch
 * endpoint can take a clip as fast as it can be written, while a realtime
 * one expects roughly the pace it was spoken at, and getting that wrong is
 * the kind of thing that fails only against some providers
 * (dtinth/vxbeamer#86).
 */
object BackendCapabilities {
    /**
     * Reads the primary configuration's `supportsFastDump` out of an
     * `/asr/configurations` response. Returns false for anything it cannot
     * make sense of: pacing is always safe, dumping is not.
     */
    fun fastDumpSupported(json: String): Boolean {
        val body = runCatching { JSONObject(json) }.getOrNull() ?: return false
        val primaryId = body.optString("primaryConfigurationId").takeIf { it.isNotEmpty() } ?: return false
        val configurations = body.optJSONArray("configurations") ?: return false
        for (index in 0 until configurations.length()) {
            val configuration = configurations.optJSONObject(index) ?: continue
            if (configuration.optString("id") == primaryId) {
                return configuration.optBoolean("supportsFastDump", false)
            }
        }
        return false
    }
}
