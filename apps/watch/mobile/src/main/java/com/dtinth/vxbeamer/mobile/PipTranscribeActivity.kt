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
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
                Transcription.state.collect {
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
        val recording = Transcription.state.value.isActive
        val action = if (recording) PipRecordingService.ACTION_STOP else PipRecordingService.ACTION_START
        startService(Intent(this, PipRecordingService::class.java).setAction(action))
    }

    /** Called when the user leaves this activity (home, recents, another
     *  app) — the moment to snap into the corner, but only while a
     *  recording is actually running; otherwise there is nothing to keep
     *  reachable. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Transcription.state.value.isActive) {
            enterPictureInPictureMode(buildPipParams())
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPipMode.value = isInPictureInPictureMode
        if (isInPictureInPictureMode) setPictureInPictureParams(buildPipParams())
    }

    private fun buildPipParams(): PictureInPictureParams {
        val recording = Transcription.state.value.isActive
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
        if (!Transcription.state.value.isActive) toggleRecording()
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
    val state by Transcription.state.collectAsState()
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

    val level by Transcription.audioLevel.collectAsState()

    // What the model has heard so far, if anything — kept apart from the
    // status line so a transcript never reads as a status and vice versa.
    val transcript =
        when (val s = state) {
            is Transcription.State.Recording -> s.text
            is Transcription.State.Finishing -> s.text
            is Transcription.State.Copied -> s.text
            else -> null
        }?.takeIf { it.isNotEmpty() }

    val status =
        when (state) {
            is Transcription.State.Idle -> "Tap to speak"
            is Transcription.State.Recording -> "Listening…"
            is Transcription.State.Finishing -> "Finishing…"
            is Transcription.State.Copied -> "Copied to clipboard"
            is Transcription.State.Error -> "Failed"
        }

    // A PiP window does not deliver touches to its content — Android routes a
    // tap to its own controls overlay instead, so the button and switches
    // would be decoration the user cannot reach. In that mode this is a status
    // readout only, and the `RemoteAction` on the window is the control
    // (dtinth/vxbeamer#86).
    if (compact) {
        Column(
            modifier = Modifier.fillMaxSize().padding(12.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StatusLine(state = state, status = status)
            if (transcript != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = transcript,
                    textAlign = TextAlign.Center,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        return
    }

    // Settings on top, transcript in the middle, record button at the bottom
    // within thumb reach — the same shape the web app uses, because the phone
    // itself is the microphone in this mode (dtinth/vxbeamer#86).
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        SettingsCard(keepScreenOn = keepScreenOn, onKeepScreenOnChange = { keepScreenOn = it })

        Column(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StatusLine(state = state, status = status)
            Spacer(Modifier.height(12.dp))
            if (transcript != null) {
                Text(
                    text = transcript,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.titleMedium,
                )
            } else if (state is Transcription.State.Error) {
                Text(
                    text = (state as Transcription.State.Error).message,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        // Only offered when there is something to abandon: a provider that
        // never sends a final would otherwise strand the session in
        // "Finishing…" with no way out but force-quitting the app.
        if (state is Transcription.State.Finishing) {
            TextButton(
                onClick = {
                    context.startService(
                        Intent(context, PipRecordingService::class.java)
                            .setAction(PipRecordingService.ACTION_RESET),
                    )
                    context.startService(
                        Intent(context, FloatingWindowService::class.java)
                            .setAction(FloatingWindowService.ACTION_RESET),
                    )
                },
                modifier = Modifier.align(Alignment.CenterHorizontally),
            ) {
                Text("Reset stuck recording")
            }
        }

        RecordButton(
            recording = state.isActive,
            level = level,
            onClick = {
                val hasMic =
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED
                if (hasMic) onToggle() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
            },
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
    }
}

/** Status with a colour-coded dot, so state reads at a glance. */
@Composable
private fun StatusLine(state: Transcription.State, status: String) {
    val colour =
        when (state) {
            is Transcription.State.Recording -> MaterialTheme.colorScheme.error
            is Transcription.State.Finishing -> MaterialTheme.colorScheme.tertiary
            is Transcription.State.Copied -> MaterialTheme.colorScheme.primary
            is Transcription.State.Error -> MaterialTheme.colorScheme.error
            is Transcription.State.Idle -> MaterialTheme.colorScheme.outline
        }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(colour))
        Spacer(Modifier.width(8.dp))
        Text(
            text = status,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The record button, ringed by a live level meter. The ring is the audio
 * level rather than a separate bar, so there is one thing to look at while
 * speaking instead of two (dtinth/vxbeamer#86).
 */
@Composable
private fun RecordButton(
    recording: Boolean,
    level: Float,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ring by animateFloatAsState(targetValue = level, label = "level")
    val ringColour = MaterialTheme.colorScheme.error
    Box(modifier = modifier.size(144.dp), contentAlignment = Alignment.Center) {
        if (recording) {
            Box(
                modifier =
                    Modifier.size((112 + 32 * ring).dp)
                        .clip(CircleShape)
                        .background(ringColour.copy(alpha = 0.18f)),
            )
        }
        Button(
            onClick = onClick,
            shape = CircleShape,
            colors =
                ButtonDefaults.buttonColors(
                    containerColor =
                        if (recording) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.primary
                        },
                ),
            modifier = Modifier.size(112.dp),
        ) {
            Text(
                text = if (recording) "Stop" else "Start",
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}

@Composable
private fun SettingsCard(keepScreenOn: Boolean, onKeepScreenOnChange: (Boolean) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            SettingRow(
                title = "Keep screen on",
                subtitle = "While this screen is open",
                checked = keepScreenOn,
                onCheckedChange = onKeepScreenOnChange,
            )
            FloatingWindowToggle()
        }
    }
}

@Composable
private fun SettingRow(
    title: String,
    subtitle: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

/**
 * Switches the always-on-top record button on and off.
 *
 * The overlay permission is requested here rather than at install time
 * because it is a Settings screen trip, not a normal runtime dialog — and
 * because the window is opt-in by design: "draw over other apps" is what
 * banking apps suppress, so it should not exist unless asked for
 * (dtinth/vxbeamer#86).
 */
@Composable
private fun FloatingWindowToggle() {
    val context = LocalContext.current
    var showing by remember { mutableStateOf(FloatingWindowService.isShowing) }

    // Re-reads the permission on return from Settings; the result itself
    // carries nothing, since the grant lands in Settings.canDrawOverlays.
    val overlayPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            if (Settings.canDrawOverlays(context)) {
                context.startService(Intent(context, FloatingWindowService::class.java))
                showing = true
            }
        }

    SettingRow(
        title = "Floating button",
        subtitle = "Tap to record from inside any app",
        checked = showing,
        onCheckedChange = { wanted ->
            if (!wanted) {
                context.startService(
                    Intent(context, FloatingWindowService::class.java)
                        .setAction(FloatingWindowService.ACTION_HIDE),
                )
                showing = false
                return@SettingRow
            }
            if (Settings.canDrawOverlays(context)) {
                context.startService(Intent(context, FloatingWindowService::class.java))
                showing = true
            } else {
                overlayPermission.launch(
                    Intent(
                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:${context.packageName}"),
                    ),
                )
            }
        },
    )
}
