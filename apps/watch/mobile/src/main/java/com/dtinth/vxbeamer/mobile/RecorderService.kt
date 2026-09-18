package com.dtinth.vxbeamer.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Keeps recording and uploading alive while the user is elsewhere, and hosts
 * the floating button.
 *
 * One service rather than one per surface, because there is one microphone
 * and one upload queue. It also solves a restriction that would otherwise
 * make the floating button impossible: a microphone foreground service
 * cannot be *started* from the background, and a tap on an overlay happens
 * with the app in the background. Starting this service from a visible
 * activity and keeping it up for as long as the button is showing means
 * recording never needs a background start (dtinth/vxbeamer#86).
 *
 * It stops itself once nothing needs it — no capture, no queue, no window —
 * so there is no permanent notification for an app sitting idle.
 */
class RecorderService : Service() {
    private val scope = CoroutineScope(Dispatchers.Main)
    private var window: FloatingWindow? = null
    private var started = false
    private var startedWithMicrophone = false
    private var latestStartId = 0
    private var overlayClearJob: Job? = null

    /** The recording whose result has already been shown and taken away. */
    private var dismissedResultFor: String? = null

    override fun onCreate() {
        super.onCreate()
        Recorder.initialize(this)
        observe()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId = startId
        val wantsMicrophone =
            intent?.action == ACTION_START_CAPTURE ||
                intent?.action == ACTION_TOGGLE_CAPTURE ||
                intent?.action == ACTION_SHOW_WINDOW ||
                Recorder.isCapturing

        // The type has to match what the service is actually about to do: a
        // microphone-typed foreground service needs RECORD_AUDIO granted, and
        // throws SecurityException without it. Coming up purely to drain the
        // upload queue — which is what a watch relay does — must therefore
        // not claim the microphone (dtinth/vxbeamer#86).
        if (!ensureForeground(microphone = wantsMicrophone && hasMicrophonePermission())) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        when (intent?.action) {
            ACTION_SHOW_WINDOW -> showWindow()
            ACTION_HIDE_WINDOW -> {
                hideWindow()
                stopIfIdle()
            }
            ACTION_START_CAPTURE -> startCapture()
            ACTION_STOP_CAPTURE -> Recorder.stopCapture()
            ACTION_TOGGLE_CAPTURE -> if (Recorder.isCapturing) Recorder.stopCapture() else startCapture()
            // Nothing to do but exist: starting brought the queue up, and
            // stopIfIdle will take it down again once the queue is empty.
            ACTION_DRAIN -> stopIfIdle()
        }
        return START_STICKY
    }

    private fun hasMicrophonePermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    /**
     * The mic can be revoked between the UI asking for it and a tap on the
     * overlay or the notification arriving here, so this is checked at the
     * point of use rather than trusted from whoever sent the intent.
     */
    private fun startCapture() {
        // Inline rather than via hasMicrophonePermission(): lint only
        // recognises the check when it can see it at the call site.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            stopIfIdle()
            return
        }
        Recorder.startCapture()
    }

    private fun observe() {
        // The level is deliberately not in this collector: it changes ten
        // times a second, and rebuilding the notification at that rate is
        // both wasteful and rate-limited by the system (dtinth/vxbeamer#86).
        scope.launch {
            combine(Recorder.capturingId, Recorder.store.recordings) { capturingId, recordings ->
                capturingId to recordings
            }
                .collect { (capturingId, recordings) ->
                    val capturing = capturingId != null
                    window?.setRecording(capturing)
                    showOverlayText(capturingId, recordings)
                    if (started) notify(buildNotification(capturing, recordings))
                    stopIfIdle()
                }
        }
        scope.launch { Recorder.audioLevel.collect { window?.setLevel(it) } }
    }

    /**
     * Shows the overlay's text, and takes a finished one away again.
     *
     * A result that stays up forever is in the way — the point of the
     * overlay is the button, not the transcript, which is on the clipboard
     * and in the history by then. A failure lingers longer than a success,
     * since an error nobody sees is worse than one that overstays
     * (dtinth/vxbeamer#86).
     */
    private fun showOverlayText(capturingId: String?, recordings: List<Recording>) {
        overlayClearJob?.cancel()
        val latest = recordings.firstOrNull()

        // Once a result has had its time, it stays gone: any later state
        // change — the queue retrying something else, a notification rebuild —
        // would otherwise put it back on screen minutes later.
        if (capturingId == null && latest != null && latest.id == dismissedResultFor) {
            window?.setTranscript(null)
            return
        }

        val text = overlayText(capturingId, recordings)
        window?.setTranscript(text)
        if (text == null || capturingId != null || latest == null) return

        val linger =
            when (latest.status) {
                RecordingStatus.DONE -> RESULT_LINGER_MS
                RecordingStatus.FAILED -> FAILURE_LINGER_MS
                else -> return // Still working; it will be replaced, not cleared.
            }
        overlayClearJob = scope.launch {
            delay(linger)
            dismissedResultFor = latest.id
            window?.setTranscript(null)
        }
    }

    /** What the overlay shows: this recording's text while it runs, then the last result. */
    private fun overlayText(capturingId: String?, recordings: List<Recording>): String? {
        if (capturingId != null) {
            val current = recordings.find { it.id == capturingId }
            return current?.transcript ?: "Listening…"
        }
        val latest = recordings.firstOrNull() ?: return null
        return when (latest.status) {
            RecordingStatus.DONE -> latest.transcript
            RecordingStatus.FAILED -> "Failed: ${latest.error.orEmpty()}"
            RecordingStatus.UPLOADING, RecordingStatus.PENDING -> latest.transcript ?: "Transcribing…"
            RecordingStatus.CAPTURING -> latest.transcript
        }
    }

    private fun showWindow() {
        if (!Settings.canDrawOverlays(this)) return
        if (window == null) {
            window = FloatingWindow(
                context = this,
                windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager,
                onTap = { if (Recorder.isCapturing) Recorder.stopCapture() else startCapture() },
                onLongPress = ::bringAppToFront,
            )
        }
        window?.show()
        isWindowShowing = true
    }

    /**
     * Brings the app's own screen forward from a long press on the overlay.
     *
     * Allowed from the background because the overlay permission is itself
     * an exemption from the background-activity-start restrictions — which
     * is only true while that permission is granted, and it always is here,
     * since without it there would be no button to long-press
     * (dtinth/vxbeamer#86).
     */
    private fun bringAppToFront() {
        val intent =
            Intent(this, TransmitterActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        runCatching { startActivity(intent) }
            .onFailure { Log.w(TAG, "Could not bring the app to the front", it) }
    }

    private fun hideWindow() {
        window?.hide()
        isWindowShowing = false
    }

    /**
     * Nothing to keep alive for: no mic open, no uploads outstanding, no
     * window on screen. Staying up past this point would be a notification
     * the user cannot get rid of.
     */
    private fun stopIfIdle() {
        if (Recorder.isCapturing || isWindowShowing) return
        val busy =
            Recorder.store.recordings.value.any {
                // A recording that has run out of automatic attempts is not
                // work any more — nothing will pick it up without being asked,
                // so counting it would hold up a notification forever.
                when (it.status) {
                    RecordingStatus.UPLOADING, RecordingStatus.CAPTURING -> true
                    RecordingStatus.PENDING -> !UploadPolicy.isStalled(it)
                    RecordingStatus.DONE, RecordingStatus.FAILED -> false
                }
            }
        if (busy) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        started = false
        // With the start id, so a startService that arrived while this was
        // being decided is not silently dropped.
        stopSelf(latestStartId)
    }

    /** False if the system refused, in which case the caller must give up. */
    private fun ensureForeground(microphone: Boolean): Boolean {
        if (started && microphone == startedWithMicrophone) return true
        val notification = buildNotification(Recorder.isCapturing, Recorder.store.recordings.value)
        val type =
            if (microphone) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, type)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            started = true
            startedWithMicrophone = microphone
            true
        } catch (t: Throwable) {
            // Android 12+ refuses a foreground start from the background in
            // some states, and a microphone-typed one needs the permission
            // granted. Crashing here would take the app down for what is a
            // recoverable "not now".
            Log.e(TAG, "Could not start in the foreground", t)
            false
        }
    }

    private fun notify(notification: android.app.Notification) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(capturing: Boolean, recordings: List<Recording>): android.app.Notification {
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "vxbeamer transmitter", NotificationManager.IMPORTANCE_LOW),
            )

        val queued =
            recordings.count { it.status == RecordingStatus.PENDING || it.status == RecordingStatus.UPLOADING }
        val text =
            when {
                capturing -> "Listening…"
                queued > 0 -> "Transcribing $queued recording${if (queued == 1) "" else "s"}…"
                isWindowShowing -> "Tap the floating button to record"
                else -> "Ready"
            }

        val open =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, TransmitterActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        val builder =
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("vxbeamer transmitter")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_tile_mic)
                .setContentIntent(open)
                .setOngoing(true)

        if (capturing) {
            builder.addAction(0, "Stop", service(ACTION_STOP_CAPTURE))
        } else {
            builder.addAction(0, "Record", service(ACTION_START_CAPTURE))
        }
        if (isWindowShowing) {
            builder.addAction(0, "Hide button", service(ACTION_HIDE_WINDOW))
        }
        return builder.build()
    }

    private fun service(action: String): PendingIntent =
        PendingIntent.getService(
            this,
            action.hashCode(),
            Intent(this, RecorderService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    override fun onDestroy() {
        hideWindow()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START_CAPTURE = "com.dtinth.vxbeamer.mobile.action.START_CAPTURE"
        const val ACTION_STOP_CAPTURE = "com.dtinth.vxbeamer.mobile.action.STOP_CAPTURE"
        const val ACTION_TOGGLE_CAPTURE = "com.dtinth.vxbeamer.mobile.action.TOGGLE_CAPTURE"
        const val ACTION_SHOW_WINDOW = "com.dtinth.vxbeamer.mobile.action.SHOW_WINDOW"
        const val ACTION_HIDE_WINDOW = "com.dtinth.vxbeamer.mobile.action.HIDE_WINDOW"

        /** Come up long enough to send whatever is queued, then stop. */
        const val ACTION_DRAIN = "com.dtinth.vxbeamer.mobile.action.DRAIN"

        private const val TAG = "RecorderService"
        private const val RESULT_LINGER_MS = 5_000L
        private const val FAILURE_LINGER_MS = 20_000L
        private const val NOTIFICATION_ID = 2
        private const val CHANNEL_ID = "transmitter"

        /** Whether the floating button is on screen, for the settings toggle to reflect. */
        @Volatile
        var isWindowShowing: Boolean = false
            private set

        fun send(context: Context, action: String) {
            context.startService(Intent(context, RecorderService::class.java).setAction(action))
        }
    }
}
