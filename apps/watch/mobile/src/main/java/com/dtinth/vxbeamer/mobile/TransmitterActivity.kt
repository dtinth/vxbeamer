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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * The transmitter's own screen: record, and see what has been sent.
 *
 * Recording itself belongs to [Recorder] and [RecorderService], not here, so
 * it survives this activity being backgrounded, shrunk into
 * picture-in-picture, or closed outright (dtinth/vxbeamer#86).
 */
class TransmitterActivity : ComponentActivity() {
    private var toggleReceiver: BroadcastReceiver? = null
    private val inPipMode = mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Recorder.initialize(this)

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

        // The PiP action is a snapshot Android keeps displaying, not a
        // binding: without this, a window entered while recording keeps
        // offering "Stop" after the recording has finished on its own.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                Recorder.capturingId.collect {
                    if (isInPictureInPictureMode) setPictureInPictureParams(buildPipParams())
                }
            }
        }

        setContent {
            VxbeamerTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    TransmitterScreen(onToggle = ::toggleRecording, compact = inPipMode.value)
                }
            }
        }
    }

    private fun toggleRecording() {
        RecorderService.send(this, RecorderService.ACTION_TOGGLE_CAPTURE)
    }

    /** Leaving mid-recording shrinks to the corner rather than stopping. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Recorder.isCapturing && !RecorderService.isWindowShowing) {
            enterPictureInPictureMode(buildPipParams())
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPipMode.value = isInPictureInPictureMode
        if (isInPictureInPictureMode) setPictureInPictureParams(buildPipParams())
    }

    private fun buildPipParams(): PictureInPictureParams {
        val recording = Recorder.isCapturing
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
        return PictureInPictureParams.Builder()
            // 1:1 — Android allows roughly 2.39:1 to 1:2.39, so a square
            // window is an ordinary request here, not a workaround.
            .setAspectRatio(Rational(1, 1))
            .setActions(
                listOf(
                    RemoteAction(
                        icon,
                        if (recording) "Stop" else "Record",
                        "Toggle recording",
                        pendingIntent,
                    ),
                ),
            )
            .build()
    }

    override fun onDestroy() {
        toggleReceiver?.let { unregisterReceiver(it) }
        super.onDestroy()
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

    /**
     * Launched by [ToggleTileService], which cannot start the microphone
     * itself from the background. Starting here gives that a foreground
     * context, then drops into picture-in-picture so the user is left where
     * they were rather than looking at this screen.
     */
    private fun handleAutoStart(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_AUTO_START, false) != true) return
        // Consume it, or coming back to this activity starts another one.
        intent.removeExtra(EXTRA_AUTO_START)
        val hasMic =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        // Without the mic, PiP would hide the one screen able to ask for it.
        if (!hasMic) return
        if (!Recorder.isCapturing) toggleRecording()
        enterPictureInPictureMode(buildPipParams())
    }

    companion object {
        const val ACTION_TOGGLE = "com.dtinth.vxbeamer.mobile.action.TOGGLE_FROM_PIP"
        const val EXTRA_AUTO_START = "auto_start"
    }
}

@Composable
private fun TransmitterScreen(onToggle: () -> Unit, compact: Boolean) {
    val context = LocalContext.current
    val capturingId by Recorder.capturingId.collectAsState()
    val recordings by Recorder.store.recordings.collectAsState()
    val level by Recorder.audioLevel.collectAsState()
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

    val capturing = capturingId != null
    val current = recordings.find { it.id == capturingId }
    val latest = recordings.firstOrNull()

    // A PiP window never delivers touches to its content — Android routes a
    // tap to its own controls overlay — so in that mode this is a readout
    // only, and the window's RemoteAction is the control.
    if (compact) {
        Column(
            modifier = Modifier.fillMaxSize().padding(12.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StatusDot(capturing = capturing, recording = latest)
            Spacer(Modifier.height(6.dp))
            Text(
                text = current?.transcript ?: latest?.transcript ?: if (capturing) "Listening…" else "Ready",
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        return
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SettingsCard(keepScreenOn = keepScreenOn, onKeepScreenOnChange = { keepScreenOn = it })

        History(
            recordings = recordings,
            capturingId = capturingId,
            modifier = Modifier.weight(1f),
            onCopy = { Recorder.copyToClipboard(it) },
            onRetry = { Recorder.retry(it) },
            onDiscard = { Recorder.discard(it) },
        )

        RecordButton(
            recording = capturing,
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

/**
 * What has been recorded, newest first. This is a transmitter, so the list is
 * about *delivery* — what is still going out, what failed, what can be sent
 * again — rather than a reading view of past messages.
 */
@Composable
private fun History(
    recordings: List<Recording>,
    capturingId: String?,
    modifier: Modifier = Modifier,
    onCopy: (String) -> Unit,
    onRetry: (String) -> Unit,
    onDiscard: (String) -> Unit,
) {
    if (recordings.isEmpty()) {
        Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text(
                "Nothing recorded yet.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(recordings, key = { it.id }) { recording ->
            HistoryRow(
                recording = recording,
                capturing = recording.id == capturingId,
                onCopy = onCopy,
                onRetry = onRetry,
                onDiscard = onDiscard,
            )
        }
    }
}

@Composable
private fun HistoryRow(
    recording: Recording,
    capturing: Boolean,
    onCopy: (String) -> Unit,
    onRetry: (String) -> Unit,
    onDiscard: (String) -> Unit,
) {
    val transcript = recording.transcript
    Card(
        modifier =
            Modifier.fillMaxWidth()
                .clickable(enabled = !transcript.isNullOrEmpty()) { onCopy(transcript.orEmpty()) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(capturing = capturing, recording = recording)
                Spacer(Modifier.width(8.dp))
                Text(
                    text = statusLabel(recording, capturing),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = "${formatTime(recording.createdAt)} · ${formatDuration(recording.durationMs)}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (!transcript.isNullOrEmpty()) {
                Text(text = transcript, style = MaterialTheme.typography.bodyMedium)
            } else if (recording.status == RecordingStatus.FAILED) {
                Text(
                    text = recording.error ?: "Failed",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            if (UploadPolicy.canRetry(recording)) {
                Row {
                    TextButton(onClick = { onRetry(recording.id) }) {
                        // The audio is still on the device, so this really is
                        // a fresh transcription, not a replayed result.
                        Text(if (recording.status == RecordingStatus.DONE) "Transcribe again" else "Retry")
                    }
                    if (!transcript.isNullOrEmpty()) {
                        TextButton(onClick = { onCopy(transcript) }) { Text("Copy") }
                    }
                    if (recording.status != RecordingStatus.DONE) {
                        // Otherwise a recording that will never succeed can
                        // only be waited out by retention.
                        TextButton(onClick = { onDiscard(recording.id) }) { Text("Discard") }
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusDot(capturing: Boolean, recording: Recording?) {
    val colour =
        when {
            capturing -> MaterialTheme.colorScheme.error
            recording == null -> MaterialTheme.colorScheme.outline
            else ->
                when (recording.status) {
                    RecordingStatus.CAPTURING -> MaterialTheme.colorScheme.error
                    RecordingStatus.PENDING, RecordingStatus.UPLOADING -> MaterialTheme.colorScheme.tertiary
                    RecordingStatus.DONE -> MaterialTheme.colorScheme.primary
                    RecordingStatus.FAILED -> MaterialTheme.colorScheme.error
                }
        }
    Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(colour))
}

private fun statusLabel(recording: Recording, capturing: Boolean): String =
    when {
        capturing -> "Recording"
        else ->
            when (recording.status) {
                RecordingStatus.CAPTURING -> "Recording"
                RecordingStatus.PENDING -> if (UploadPolicy.isStalled(recording)) "Needs a retry" else "Queued"
                RecordingStatus.UPLOADING -> "Transcribing"
                RecordingStatus.DONE -> "Sent"
                RecordingStatus.FAILED -> "Failed"
            }
    }

private fun formatTime(epochMillis: Long): String =
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(epochMillis))

private fun formatDuration(durationMs: Long): String {
    val totalSeconds = durationMs / 1000
    return if (totalSeconds >= 60) {
        "%d:%02d".format(totalSeconds / 60, totalSeconds % 60)
    } else {
        "${totalSeconds}s"
    }
}

/**
 * The record button, ringed by the live audio level — one thing to watch
 * while speaking rather than a button and a separate meter.
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
    Box(modifier = modifier.size(132.dp), contentAlignment = Alignment.Center) {
        if (recording) {
            Box(
                modifier =
                    Modifier.size((104 + 28 * ring).dp)
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
                        if (recording) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                ),
            modifier = Modifier.size(104.dp),
        ) {
            Text(
                text = if (recording) "Stop" else "Record",
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
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp)) {
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
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
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
 * Opt-in by design: "draw over other apps" is the permission Android 12+
 * lets any app suppress, and banking apps do, so the window should not exist
 * unless it has been asked for (dtinth/vxbeamer#86).
 */
@Composable
private fun FloatingWindowToggle() {
    val context = LocalContext.current
    var showing by remember { mutableStateOf(RecorderService.isWindowShowing) }

    val overlayPermission =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            // The grant lands in Settings.canDrawOverlays, not in the result.
            if (Settings.canDrawOverlays(context)) {
                RecorderService.send(context, RecorderService.ACTION_SHOW_WINDOW)
                showing = true
            }
        }

    SettingRow(
        title = "Floating button",
        subtitle = "Record from inside any app",
        checked = showing,
        onCheckedChange = { wanted ->
            if (!wanted) {
                RecorderService.send(context, RecorderService.ACTION_HIDE_WINDOW)
                showing = false
                return@SettingRow
            }
            if (Settings.canDrawOverlays(context)) {
                RecorderService.send(context, RecorderService.ACTION_SHOW_WINDOW)
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
