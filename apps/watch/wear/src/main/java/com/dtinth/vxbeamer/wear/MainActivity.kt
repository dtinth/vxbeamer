package com.dtinth.vxbeamer.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text

/**
 * One button: tap to start [RecordingService], tap again to stop it. The
 * service itself owns the mic and the stream to the phone — this activity
 * only reflects [RecordingService.isRunning] and toggles it, the same
 * relationship the web app's record button has to its own recording state
 * (dtinth/vxbeamer#86).
 */
class MainActivity : ComponentActivity() {
    private val requestMicPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startRecording()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            RecordButtonScreen(
                isRecording = { RecordingService.isRunning },
                onToggle = ::onToggle,
            )
        }
    }

    private fun onToggle() {
        if (RecordingService.isRunning) {
            stopRecording()
            return
        }
        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (hasMic) {
            startRecording()
        } else {
            requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startRecording() {
        ContextCompat.startForegroundService(this, Intent(this, RecordingService::class.java))
    }

    private fun stopRecording() {
        startService(Intent(this, RecordingService::class.java).setAction(RecordingService.ACTION_STOP))
    }
}

@Composable
private fun RecordButtonScreen(isRecording: () -> Boolean, onToggle: () -> Unit) {
    // RecordingService.isRunning is a plain var, not observable state, so
    // this polls it on every recomposition trigger from the click itself —
    // good enough for a single button with no other moving parts.
    var recording by remember { mutableStateOf(isRecording()) }

    MaterialTheme {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Button(
                onClick = {
                    onToggle()
                    recording = isRecording()
                },
                colors =
                    ButtonDefaults.buttonColors(
                        backgroundColor = if (recording) Color(0xFFEF4444) else Color(0xFF3A3A3A),
                    ),
                modifier = Modifier.padding(16.dp),
                shape = CircleShape,
            ) {
                Text(if (recording) "Stop" else "Record")
            }
        }
    }
}
