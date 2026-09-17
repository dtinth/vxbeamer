package com.dtinth.vxbeamer.mobile

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/**
 * A Quick Settings tile that toggles a recording from inside any other app —
 * swipe down, tap, speak (dtinth/vxbeamer#86).
 *
 * This exists because the picture-in-picture window cannot be a control: a
 * PiP window never delivers touches to its own content, so reaching its
 * action costs a tap to reveal plus a tap to press, and the controls hide
 * themselves again. The alternatives were worse:
 *
 * - **"Draw over other apps"**: the permission Android 12+ lets any app
 *   suppress via `setHideOverlayWindows`, which banking apps do.
 * - **An accessibility shortcut**: worse still in Thailand specifically —
 *   banking apps there refuse to run at all while *any* accessibility
 *   service is enabled, not merely while one is on screen.
 *
 * A tile needs no permission at all and no app can suppress it.
 *
 * **Starting has to go through the activity.** A microphone foreground
 * service cannot be started from the background, and `onClick` runs with the
 * app in the background — so starting launches [PipTranscribeActivity] with
 * [PipTranscribeActivity.EXTRA_AUTO_START], which starts the capture from a
 * real foreground context and drops straight into PiP. Stopping has no such
 * restriction and is sent to the service directly.
 */
class ToggleTileService : TileService() {
    private var watchJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onStartListening() {
        super.onStartListening()
        // The tile is only visible while listening, so this is also the only
        // window in which it is worth following the service's state.
        watchJob =
            scope.launch {
                PipRecordingService.state.collect { render() }
            }
    }

    override fun onStopListening() {
        watchJob?.cancel()
        watchJob = null
        super.onStopListening()
    }

    override fun onClick() {
        super.onClick()
        if (PipRecordingService.state.value.isActive) {
            startService(
                Intent(this, PipRecordingService::class.java).setAction(PipRecordingService.ACTION_STOP),
            )
            return
        }
        launchForStart()
    }

    // The deprecated `Intent` overload only throws on Android 14+, which the
    // branch below never reaches — and it is still the only variant that
    // exists on the older versions this app supports (minSdk 26).
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun launchForStart() {
        val intent =
            Intent(this, PipTranscribeActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(PipTranscribeActivity.EXTRA_AUTO_START, true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun render() {
        val tile = qsTile ?: return
        val active = PipRecordingService.state.value.isActive
        tile.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = getString(R.string.tile_label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = if (active) "Listening…" else null
        }
        tile.updateTile()
    }
}
