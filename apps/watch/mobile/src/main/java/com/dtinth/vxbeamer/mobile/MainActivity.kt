package com.dtinth.vxbeamer.mobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * The only screen this app has. It is not where audio flows through — that
 * is [RelayListenerService], woken by the system on its own. This screen
 * exists purely to enter the backend URL and sign in once, the same
 * desktop-style flow the Tauri app uses (dtinth/vxbeamer#86).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface { SignInScreen() }
            }
        }
    }
}

@Composable
private fun SignInScreen() {
    val context = LocalContext.current
    val authStore = remember { AuthStore(context) }
    val scope = rememberCoroutineScope()

    var backendUrl by rememberSaveable { mutableStateOf(authStore.backendUrl) }
    var pendingCodeVerifier by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingState by rememberSaveable { mutableStateOf<String?>(null) }
    var pastedCode by rememberSaveable { mutableStateOf("") }
    var statusMessage by rememberSaveable { mutableStateOf("") }
    var signedIn by remember { mutableStateOf(authStore.isSignedIn) }

    Column(
        modifier = Modifier.fillMaxWidth().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("vxbeamer Watch Relay")

        OutlinedTextField(
            value = backendUrl,
            onValueChange = {
                backendUrl = it
                authStore.backendUrl = it
            },
            label = { Text("Backend URL") },
            modifier = Modifier.fillMaxWidth(),
        )

        if (signedIn) {
            Text("Signed in. The watch app can relay recordings now.")
            Button(
                onClick = { context.startActivity(Intent(context, PipTranscribeActivity::class.java)) },
            ) {
                Text("Start transcribing")
            }
            Button(
                onClick = {
                    authStore.signOut()
                    signedIn = false
                    statusMessage = ""
                },
            ) {
                Text("Sign out")
            }
        } else {
            Button(
                onClick = {
                    scope.launch {
                        runCatching { Oidc.beginSignIn(backendUrl) }
                            .onSuccess { pending ->
                                pendingCodeVerifier = pending.codeVerifier
                                pendingState = pending.state
                                statusMessage = "Sign in, then paste the code shown below."
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(pending.authUrl)))
                            }
                            .onFailure { statusMessage = it.message ?: "Could not start sign-in" }
                    }
                },
            ) {
                Text("Sign in")
            }

            if (pendingCodeVerifier != null) {
                OutlinedTextField(
                    value = pastedCode,
                    onValueChange = { pastedCode = it },
                    label = { Text("Paste the code from the browser") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        val codeVerifier = pendingCodeVerifier ?: return@Button
                        val state = pendingState ?: return@Button
                        scope.launch {
                            runCatching { Oidc.completeSignIn(backendUrl, pastedCode, codeVerifier, state) }
                                .onSuccess { tokens ->
                                    authStore.saveTokens(tokens)
                                    signedIn = true
                                    pendingCodeVerifier = null
                                    pendingState = null
                                    pastedCode = ""
                                    statusMessage = "Signed in."
                                }
                                .onFailure { statusMessage = it.message ?: "Sign-in failed" }
                        }
                    },
                ) {
                    Text("Complete sign-in")
                }
            }
        }

        if (statusMessage.isNotEmpty()) Text(statusMessage)
    }
}
