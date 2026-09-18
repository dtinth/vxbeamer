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
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
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

    override fun onCreate() {
        super.onCreate()
        Recorder.initialize(this)
        observe()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureForeground()
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

    /**
     * The mic can be revoked between the UI asking for it and a tap on the
     * overlay or the notification arriving here, so this is checked at the
     * point of use rather than trusted from whoever sent the intent.
     */
    private fun startCapture() {
        val granted =
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        if (!granted) {
            stopIfIdle()
            return
        }
        Recorder.startCapture()
    }

    private fun observe() {
        // One collector over everything the notification and the overlay
        // reflect, so they can never disagree about the current state.
        scope.launch {
            combine(
                Recorder.capturingId,
                Recorder.store.recordings,
                Recorder.audioLevel,
            ) { capturingId, recordings, level ->
                Triple(capturingId, recordings, level)
            }
                .collect { (capturingId, recordings, level) ->
                    val capturing = capturingId != null
                    window?.setRecording(capturing)
                    window?.setLevel(level)
                    window?.setTranscript(overlayText(capturingId, recordings))
                    if (started) notify(buildNotification(capturing, recordings))
                    stopIfIdle()
                }
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
            )
        }
        window?.show()
        isWindowShowing = true
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
                it.status == RecordingStatus.PENDING || it.status == RecordingStatus.UPLOADING
            }
        if (busy) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        started = false
        stopSelf()
    }

    private fun ensureForeground() {
        if (started) return
        started = true
        val recordings = Recorder.store.recordings.value
        val notification = buildNotification(Recorder.isCapturing, recordings)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
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
