package com.dtinth.vxbeamer.mobile

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The draggable always-on-top record button, and the transcript readout that
 * follows it around.
 *
 * Two windows rather than one: text arriving and growing inside the button's
 * own window resized it, which moved the button out from under the user's
 * finger mid-recording (dtinth/vxbeamer#86). Keeping the transcript in a
 * separate window lets it come and go while the button stays exactly where
 * it was put.
 *
 * Views are built in code rather than inflated from XML because this is a
 * handful of primitives with no state worth a layout file, and it keeps the
 * whole overlay legible in one place.
 */
class FloatingWindow(
    private val context: Context,
    private val windowManager: WindowManager,
    private val onTap: () -> Unit,
    private val onLongPress: () -> Unit,
) {
    private var buttonView: View? = null
    private var recordButton: View? = null
    private var levelBar: View? = null
    private var transcriptView: TextView? = null
    private var buttonParams: WindowManager.LayoutParams? = null
    private var transcriptParams: WindowManager.LayoutParams? = null
    private var transcriptAttached = false

    val isShowing: Boolean
        get() = buttonView != null

    fun show() {
        if (isShowing) return
        addButtonWindow()
        addTranscriptWindow()
    }

    fun hide() {
        transcriptView?.let { if (transcriptAttached) runCatching { windowManager.removeView(it) } }
        transcriptAttached = false
        transcriptView = null
        buttonView?.let { runCatching { windowManager.removeView(it) } }
        buttonView = null
    }

    fun setRecording(recording: Boolean) {
        recordButton?.background = buttonBackground(recording)
    }

    fun setLevel(level: Float) {
        levelBar?.scaleX = level
    }

    fun setTranscript(text: String?) {
        val view = transcriptView ?: return
        view.text = text.orEmpty()
        view.visibility = if (text.isNullOrEmpty()) View.GONE else View.VISIBLE
        positionTranscript()
    }

    private fun addButtonWindow() {
        val container =
            LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(dp(10), dp(10), dp(10), dp(10))
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(24).toFloat()
                        setColor(Color.argb(235, 28, 28, 30))
                    }
            }

        val button =
            View(context).apply {
                layoutParams = LinearLayout.LayoutParams(dp(BUTTON_DP), dp(BUTTON_DP))
                background = buttonBackground(recording = false)
            }
        recordButton = button
        container.addView(button)

        val track =
            FrameLayout(context).apply {
                layoutParams = LinearLayout.LayoutParams(dp(BUTTON_DP), dp(5)).apply { topMargin = dp(8) }
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(3).toFloat()
                        setColor(Color.argb(90, 255, 255, 255))
                    }
            }
        val level =
            View(context).apply {
                layoutParams = FrameLayout.LayoutParams(dp(BUTTON_DP), dp(5))
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(3).toFloat()
                        setColor(Color.rgb(120, 220, 140))
                    }
                scaleX = 0f
                pivotX = 0f
            }
        levelBar = level
        track.addView(level)
        container.addView(track)

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
        buttonParams = params
        container.setOnTouchListener(DragToMoveOrTap(params))

        buttonView = container
        windowManager.addView(container, params)
    }

    private fun addTranscriptWindow() {
        val transcript =
            TextView(context).apply {
                setTextColor(Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                maxLines = 4
                setPadding(dp(12), dp(8), dp(12), dp(8))
                visibility = View.GONE
                background =
                    GradientDrawable().apply {
                        cornerRadius = dp(12).toFloat()
                        setColor(Color.argb(235, 28, 28, 30))
                    }
            }
        transcriptView = transcript

        val params =
            WindowManager.LayoutParams(
                dp(TRANSCRIPT_WIDTH_DP),
                WindowManager.LayoutParams.WRAP_CONTENT,
                overlayWindowType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT,
            ).apply { gravity = Gravity.TOP or Gravity.START }
        transcriptParams = params

        windowManager.addView(transcript, params)
        transcriptAttached = true
        positionTranscript()
    }

    private fun positionTranscript() {
        val button = buttonParams ?: return
        val params = transcriptParams ?: return
        val view = transcriptView ?: return
        params.x = button.x
        params.y = button.y + dp(BUTTON_DP + 40)
        if (transcriptAttached) runCatching { windowManager.updateViewLayout(view, params) }
    }

    /**
     * A tap toggles recording, a long press opens the app, and a drag moves
     * the window.
     *
     * Tap and drag are told apart by the system's touch slop, so an imprecise
     * tap is not swallowed as a tiny drag. The long press uses the system's
     * own timeout, and cancels the moment a drag starts — moving the button
     * should never be mistaken for asking to leave (dtinth/vxbeamer#86).
     */
    private inner class DragToMoveOrTap(private val params: WindowManager.LayoutParams) :
        View.OnTouchListener {
        private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
        private val longPressTimeout = ViewConfiguration.getLongPressTimeout().toLong()
        private var startX = 0
        private var startY = 0
        private var touchX = 0f
        private var touchY = 0f
        private var dragging = false
        private var longPressed = false
        private var pendingLongPress: Runnable? = null

        private fun cancelLongPress(view: View) {
            pendingLongPress?.let { view.removeCallbacks(it) }
            pendingLongPress = null
        }

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    dragging = false
                    longPressed = false
                    val runnable =
                        Runnable {
                            if (dragging) return@Runnable
                            longPressed = true
                            onLongPress()
                        }
                    pendingLongPress = runnable
                    view.postDelayed(runnable, longPressTimeout)
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - touchX
                    val dy = event.rawY - touchY
                    if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
                        dragging = true
                        cancelLongPress(view)
                    }
                    if (dragging) {
                        params.x = startX + dx.roundToInt()
                        params.y = startY + dy.roundToInt()
                        runCatching { windowManager.updateViewLayout(buttonView, params) }
                        positionTranscript()
                    }
                    return true
                }
                MotionEvent.ACTION_UP -> {
                    cancelLongPress(view)
                    // A long press has already acted; releasing must not also
                    // start or stop a recording.
                    if (!dragging && !longPressed) {
                        view.performClick()
                        onTap()
                    }
                    return true
                }
                MotionEvent.ACTION_CANCEL -> {
                    cancelLongPress(view)
                    return true
                }
            }
            return false
        }
    }

    private fun buttonBackground(recording: Boolean): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (recording) Color.rgb(230, 70, 70) else Color.rgb(240, 240, 245))
            setStroke(dp(3), Color.argb(70, 255, 255, 255))
        }

    private fun overlayWindowType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

    private fun dp(value: Int): Int = (value * context.resources.displayMetrics.density).roundToInt()

    private companion object {
        const val BUTTON_DP = 72
        const val TRANSCRIPT_WIDTH_DP = 240
    }
}
