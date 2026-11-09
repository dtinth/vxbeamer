package com.dtinth.vxbeamer.mobile

import android.content.Intent
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
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
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
    var pairingLink by rememberSaveable { mutableStateOf("") }
    var statusMessage by rememberSaveable { mutableStateOf("") }
    var signedIn by remember { mutableStateOf(authStore.isSignedIn) }

    fun pair(text: String) {
        val link = Pairing.parseLink(text)
        if (link == null) {
            statusMessage = "That is not a pairing link."
            return
        }
        statusMessage = "Pairing…"
        scope.launch {
            runCatching { Pairing.redeem(link) }
                .onSuccess { tokens ->
                    backendUrl = link.backendUrl
                    authStore.backendUrl = link.backendUrl
                    authStore.saveTokens(tokens)
                    signedIn = true
                    pairingLink = ""
                    statusMessage = ""
                }
                .onFailure { statusMessage = it.message ?: "Pairing failed" }
        }
    }

    fun scan() {
        val options =
            GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(context, options)
            .startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let(::pair) }
            .addOnFailureListener { statusMessage = it.message ?: "Could not scan" }
    }

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

        if (signedIn) {
            SignedInCard(
                backendUrl = backendUrl,
                onTranscribe = { context.startActivity(Intent(context, TransmitterActivity::class.java)) },
                onSignOut = {
                    authStore.signOut()
                    signedIn = false
                    statusMessage = ""
                },
            )
        } else {
            PairingCard(
                link = pairingLink,
                onLinkChange = { pairingLink = it },
                onPair = { pair(pairingLink) },
                onScan = ::scan,
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
private fun SignedInCard(backendUrl: String, onTranscribe: () -> Unit, onSignOut: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Signed in", style = MaterialTheme.typography.titleMedium)
            if (backendUrl.isNotBlank()) {
                Text(
                    backendUrl,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
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

/**
 * The way in that needs no browser round trip on this phone: sign in on
 * `/pair` wherever you are signed in, then scan its QR code or paste its link.
 */
@Composable
private fun PairingCard(
    link: String,
    onLinkChange: (String) -> Unit,
    onPair: () -> Unit,
    onScan: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Pair with a link", style = MaterialTheme.typography.titleMedium)
            Text(
                "Open /pair on your backend, sign in there, then scan the QR code it shows or paste its link.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onScan, modifier = Modifier.fillMaxWidth()) {
                Text("Scan QR code")
            }
            OutlinedTextField(
                value = link,
                onValueChange = onLinkChange,
                label = { Text("Pairing link") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = onPair,
                enabled = link.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Pair")
            }
        }
    }
}
