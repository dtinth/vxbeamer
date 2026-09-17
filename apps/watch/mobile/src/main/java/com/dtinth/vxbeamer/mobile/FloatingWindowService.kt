package com.dtinth.vxbeamer.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * A draggable always-on-top record button, so a recording can be started
 * from inside any other app with a single tap (dtinth/vxbeamer#86).
 *
 * This uses "draw over other apps" (`SYSTEM_ALERT_WINDOW`), which Android
 * 12+ lets any app suppress via `setHideOverlayWindows` — banking apps
 * commonly do. That is survivable here only because the window is
 * explicitly switched on and off by the user from [PipTranscribeActivity]:
 * it does not exist at all unless they asked for it.
 *
 * **Why this service also owns the microphone.** A microphone foreground
 * service cannot be started from the background, and a tap on this overlay
 * happens with the app in the background. Starting the whole service from a
 * visible activity, with the `microphone` type, and keeping it alive for as
 * long as the window is up, means the recording never needs a background
 * start. The mic is still only opened while actually recording, so the
 * system's mic indicator stays honest.
 */
class FloatingWindowService : Service() {
    private lateinit var windowManager: WindowManager
    private val scope = CoroutineScope(Dispatchers.Main)
    private var rootView: View? = null
    private var layoutParams: WindowManager.LayoutParams? = null

    private var recordButton: View? = null
    private var levelBar: View? = null
    private var transcriptView: TextView? = null

    private var session: TranscriptionSession? = null
    private var sessionJob: Job? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HIDE -> {
                teardown()
                return START_NOT_STICKY
            }
            else -> show()
        }
        return START_STICKY
    }

    private fun show() {
        if (rootView != null) return
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return
        }
        startForegroundCompat()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        buildWindow()
        observeState()
        isShowing = true
    }

    private fun teardown() {
        session?.requestStop()
        rootView?.let { runCatching { windowManager.removeView(it) } }
        rootView = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // --- The window itself ---

    private fun buildWindow() {
        val container =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(dp(10), dp(10), dp(10), dp(10))
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(20).toFloat()
                        setColor(Color.argb(235, 28, 28, 30))
                    }
            }

        val button =
            View(this).apply {
                layoutParams = LinearLayout.LayoutParams(dp(56), dp(56))
                background = buttonBackground(recording = false)
            }
        recordButton = button
        container.addView(button)

        val levelTrack =
            FrameLayout(this).apply {
                layoutParams =
                    LinearLayout.LayoutParams(dp(56), dp(4)).apply { topMargin = dp(8) }
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(2).toFloat()
                        setColor(Color.argb(90, 255, 255, 255))
                    }
            }
        val level =
            View(this).apply {
                layoutParams = FrameLayout.LayoutParams(dp(56), dp(4))
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(2).toFloat()
                        setColor(Color.rgb(120, 220, 140))
                    }
                scaleX = 0f
                pivotX = 0f
            }
        levelBar = level
        levelTrack.addView(level)
        container.addView(levelTrack)

        val transcript =
            TextView(this).apply {
                layoutParams =
                    LinearLayout.LayoutParams(dp(180), LinearLayout.LayoutParams.WRAP_CONTENT)
                        .apply { topMargin = dp(8) }
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                maxLines = 3
                visibility = View.GONE
            }
        transcriptView = transcript
        container.addView(transcript)

        val params =
            WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayWindowType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT,
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = dp(16)
                y = dp(160)
            }
        layoutParams = params

        container.setOnTouchListener(DragToMoveOrTap(params) { toggleRecording() })

        rootView = container
        windowManager.addView(container, params)
    }

    /**
     * A tap toggles recording; a drag moves the window. Distinguished by
     * whether the pointer travelled past the system's touch slop, so a
     * slightly imprecise tap is not swallowed as a tiny drag.
     */
    private inner class DragToMoveOrTap(
        private val params: WindowManager.LayoutParams,
        private val onTap: () -> Unit,
    ) : View.OnTouchListener {
        private val touchSlop = ViewConfiguration.get(this@FloatingWindowService).scaledTouchSlop
        private var startX = 0
        private var startY = 0
        private var touchX = 0f
        private var touchY = 0f
        private var dragging = false

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    dragging = false
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - touchX
                    val dy = event.rawY - touchY
                    if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) dragging = true
                    if (dragging) {
                        params.x = startX + dx.roundToInt()
                        params.y = startY + dy.roundToInt()
                        runCatching { windowManager.updateViewLayout(rootView, params) }
                    }
                    return true
                }
                MotionEvent.ACTION_UP -> {
                    if (!dragging) {
                        view.performClick()
                        onTap()
                    }
                    return true
                }
            }
            return false
        }
    }

    // --- Recording ---

    private fun toggleRecording() {
        val current = session
        if (Transcription.state.value.isActive && current != null) {
            current.requestStop()
            return
        }
        val next = TranscriptionSession(this)
        session = next
        sessionJob = scope.launch(Dispatchers.IO) { next.run() }
    }

    private fun observeState() {
        scope.launch {
            Transcription.state.collect { state ->
                val recording = state.isActive
                recordButton?.background = buttonBackground(recording)
                val text =
                    when (state) {
                        is Transcription.State.Recording -> state.text
                        is Transcription.State.Finishing -> state.text
                        is Transcription.State.Copied -> "Copied: ${state.text}"
                        is Transcription.State.Error -> "Failed: ${state.message}"
                        is Transcription.State.Idle -> null
                    }
                transcriptView?.apply {
                    this.text = text.orEmpty()
                    visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
                }
            }
        }
        scope.launch {
            Transcription.audioLevel.collect { level -> levelBar?.scaleX = level }
        }
    }

    private fun buttonBackground(recording: Boolean): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (recording) Color.rgb(230, 70, 70) else Color.rgb(240, 240, 245))
            setStroke(dp(3), Color.argb(70, 255, 255, 255))
        }

    // --- Service plumbing ---

    private fun startForegroundCompat() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "vxbeamer floating button", NotificationManager.IMPORTANCE_LOW),
        )
        val hide =
            PendingIntent.getService(
                this,
                0,
                Intent(this, FloatingWindowService::class.java).setAction(ACTION_HIDE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val notification =
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("vxbeamer floating button")
                .setContentText("Tap the button anywhere to transcribe")
                .setSmallIcon(R.drawable.ic_tile_mic)
                .setOngoing(true)
                .addAction(0, "Hide", hide)
                .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun overlayWindowType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

    override fun onDestroy() {
        session?.requestStop()
        sessionJob?.cancel()
        rootView?.let { runCatching { windowManager.removeView(it) } }
        rootView = null
        isShowing = false
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_HIDE = "com.dtinth.vxbeamer.mobile.action.HIDE_FLOATING_WINDOW"

        private const val NOTIFICATION_ID = 3
        private const val CHANNEL_ID = "floating_window"

        /** Whether the window is up, for the activity's own toggle to reflect. */
        @Volatile
        var isShowing: Boolean = false
            private set
    }
}
