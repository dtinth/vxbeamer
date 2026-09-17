package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

/**
 * "Transcribe anywhere" — a button that streams the phone's own mic to
 * vxbeamer, then copies the finished transcript, without needing the watch
 * or the PWA (dtinth/vxbeamer#86). Throwing this into picture-in-picture
 * (leaving the app while recording) snaps it to a square corner window with
 * a single tap-to-stop action, so it stays reachable over any other app —
 * unlike a "draw over other apps" overlay, PiP is not the permission
 * banking apps block.
 *
 * The actual capture lives in [PipRecordingService], not here — this
 * activity only starts/stops it and reflects its state, so recording
 * survives this activity being resized into PiP or backgrounded.
 */
class PipTranscribeActivity : ComponentActivity() {
    private var toggleReceiver: BroadcastReceiver? = null
    private val inPipMode = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) = toggleRecording()
            }
        toggleReceiver = receiver
        ContextCompat.registerReceiver(
            this,
            receiver,
            IntentFilter(ACTION_TOGGLE),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        // The PiP action button is a snapshot, not a binding: Android keeps
        // showing whatever `RemoteAction` was last handed to it. Without this,
        // a window entered while recording keeps offering "Stop" forever, even
        // after the recording finishes on its own (dtinth/vxbeamer#86).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                PipRecordingService.state.collect {
                    if (isInPictureInPictureMode) setPictureInPictureParams(buildPipParams())
                }
            }
        }

        setContent {
            VxbeamerTheme {
                Surface { TranscribeScreen(onToggle = ::toggleRecording, compact = inPipMode.value) }
            }
        }
    }

    private fun toggleRecording() {
        val recording = PipRecordingService.state.value.isActive
        val action = if (recording) PipRecordingService.ACTION_STOP else PipRecordingService.ACTION_START
        startService(Intent(this, PipRecordingService::class.java).setAction(action))
    }

    /** Called when the user leaves this activity (home, recents, another
     *  app) — the moment to snap into the corner, but only while a
     *  recording is actually running; otherwise there is nothing to keep
     *  reachable. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (PipRecordingService.state.value.isActive) {
            enterPictureInPictureMode(buildPipParams())
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPipMode.value = isInPictureInPictureMode
        if (isInPictureInPictureMode) setPictureInPictureParams(buildPipParams())
    }

    private fun buildPipParams(): PictureInPictureParams {
        val recording = PipRecordingService.state.value.isActive
        val icon =
            Icon.createWithResource(
                this,
                if (recording) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
            )
        val pendingIntent =
            PendingIntent.getBroadcast(
                this,
                0,
                Intent(ACTION_TOGGLE).setPackage(packageName),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val action =
            RemoteAction(icon, if (recording) "Stop" else "Start", "Toggle vxbeamer recording", pendingIntent)
        return PictureInPictureParams.Builder()
            // 1:1 — Android's supported range is roughly 2.39:1 to 1:2.39, so a
            // square window is a normal request here, not a workaround
            // (dtinth/vxbeamer#86).
            .setAspectRatio(Rational(1, 1))
            .setActions(listOf(action))
            .build()
    }

    override fun onDestroy() {
        toggleReceiver?.let { unregisterReceiver(it) }
        super.onDestroy()
    }

    /**
     * Launched by [ToggleTileService] to start a recording: the tile itself
     * cannot, since a microphone foreground service may not be started from
     * the background. Starting here gives that a real foreground context,
     * then goes straight to PiP so the user is left where they were rather
     * than staring at this screen (dtinth/vxbeamer#86).
     */
    private fun handleAutoStart(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_AUTO_START, false) != true) return
        // Consume it, or returning to this activity later re-triggers a start.
        intent.removeExtra(EXTRA_AUTO_START)
        // Without the mic the service would start and immediately stop, and
        // PiP would hide the very screen able to ask for the permission.
        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!hasMic) return
        if (!PipRecordingService.state.value.isActive) toggleRecording()
        enterPictureInPictureMode(buildPipParams())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAutoStart(intent)
    }

    override fun onResume() {
        super.onResume()
        handleAutoStart(intent)
    }

    companion object {
        const val ACTION_TOGGLE = "com.dtinth.vxbeamer.mobile.action.TOGGLE_PIP_RECORDING"
        const val EXTRA_AUTO_START = "auto_start"
    }
}

@Composable
private fun TranscribeScreen(onToggle: () -> Unit, compact: Boolean) {
    val context = LocalContext.current
    val state by PipRecordingService.state.collectAsState()
    var keepScreenOn by remember { mutableStateOf(false) }

    val micPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) onToggle()
        }
    val notificationPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    LaunchedEffect(keepScreenOn) {
        val window = (context as? android.app.Activity)?.window ?: return@LaunchedEffect
        if (keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    val label =
        when (val s = state) {
            is PipRecordingService.State.Idle -> "Tap to speak"
            is PipRecordingService.State.Recording -> s.text?.takeIf { it.isNotEmpty() } ?: "Listening…"
            is PipRecordingService.State.Finishing -> s.text?.takeIf { it.isNotEmpty() } ?: "Finishing…"
            is PipRecordingService.State.Error -> "Failed: ${s.message}"
        }

    // A PiP window does not deliver touches to its content — Android routes a
    // tap to its own controls overlay instead, so the button and switch below
    // would be decoration the user cannot reach. In that mode this is a status
    // readout only, and the `RemoteAction` on the window is the control
    // (dtinth/vxbeamer#86).
    if (compact) {
        Column(
            modifier = Modifier.fillMaxSize().padding(12.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = label,
                textAlign = TextAlign.Center,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text(label)

        Button(
            onClick = {
                val hasMic =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED
                if (hasMic) onToggle() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
            },
        ) {
            Text(if (state.isActive) "Stop" else "Start")
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Keep screen on")
            Switch(checked = keepScreenOn, onCheckedChange = { keepScreenOn = it })
        }

        Text("Leave this screen while recording to shrink it into a corner. Tap the window there to reveal its stop button.")
    }
}
