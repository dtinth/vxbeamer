package com.dtinth.vxbeamer.mobile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
 * Setup and sign-in. Recording does not happen here — that is
 * [TransmitterActivity] for the phone's own mic, and [RelayListenerService]
 * for audio relayed from the watch, which the system wakes on its own
 * (dtinth/vxbeamer#86).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            VxbeamerTheme {
                Surface(modifier = Modifier.fillMaxSize()) { SignInScreen() }
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
        modifier =
            Modifier.fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("vxbeamer transmitter", style = MaterialTheme.typography.headlineSmall)
            Text(
                "Voice input for vxbeamer, from this phone or a paired watch.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        OutlinedTextField(
            value = backendUrl,
            onValueChange = {
                backendUrl = it
                authStore.backendUrl = it
            },
            label = { Text("Backend URL") },
            singleLine = true,
            enabled = !signedIn,
            supportingText = if (signedIn) ({ Text("Sign out to change this.") }) else null,
            modifier = Modifier.fillMaxWidth(),
        )

        if (signedIn) {
            SignedInCard(
                onTranscribe = { context.startActivity(Intent(context, TransmitterActivity::class.java)) },
                onSignOut = {
                    authStore.signOut()
                    signedIn = false
                    statusMessage = ""
                },
            )
        } else {
            SignInCard(
                pendingCode = pendingCodeVerifier != null,
                pastedCode = pastedCode,
                onPastedCodeChange = { pastedCode = it },
                onBeginSignIn = {
                    scope.launch {
                        runCatching { Oidc.beginSignIn(backendUrl) }
                            .onSuccess { pending ->
                                pendingCodeVerifier = pending.codeVerifier
                                pendingState = pending.state
                                statusMessage = "Sign in, then paste the code shown in the browser."
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(pending.authUrl)))
                            }
                            .onFailure { statusMessage = it.message ?: "Could not start sign-in" }
                    }
                },
                onCompleteSignIn = {
                    val codeVerifier = pendingCodeVerifier ?: return@SignInCard
                    val state = pendingState ?: return@SignInCard
                    scope.launch {
                        runCatching { Oidc.completeSignIn(backendUrl, pastedCode, codeVerifier, state) }
                            .onSuccess { tokens ->
                                authStore.saveTokens(tokens)
                                signedIn = true
                                pendingCodeVerifier = null
                                pendingState = null
                                pastedCode = ""
                                statusMessage = ""
                            }
                            .onFailure { statusMessage = it.message ?: "Sign-in failed" }
                    }
                },
            )
        }

        if (statusMessage.isNotEmpty()) {
            Text(
                statusMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SignedInCard(onTranscribe: () -> Unit, onSignOut: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Signed in", style = MaterialTheme.typography.titleMedium)
            Text(
                "The watch can relay recordings now, or use this phone's own microphone.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onTranscribe, modifier = Modifier.fillMaxWidth()) {
                Text("Start transcribing")
            }
            OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) {
                Text("Sign out")
            }
        }
    }
}

@Composable
private fun SignInCard(
    pendingCode: Boolean,
    pastedCode: String,
    onPastedCodeChange: (String) -> Unit,
    onBeginSignIn: () -> Unit,
    onCompleteSignIn: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Sign in", style = MaterialTheme.typography.titleMedium)
            Text(
                // The desktop app's own flow, reused as-is: the browser lands
                // on the hosted web app, which shows a code to paste back here.
                "Opens your browser. Copy the code it shows back into this app.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onBeginSignIn, modifier = Modifier.fillMaxWidth()) {
                Text(if (pendingCode) "Open browser again" else "Sign in")
            }

            if (pendingCode) {
                OutlinedTextField(
                    value = pastedCode,
                    onValueChange = onPastedCodeChange,
                    label = { Text("Code from the browser") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = onCompleteSignIn,
                    enabled = pastedCode.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Complete sign-in")
                }
            }
        }
    }
}
