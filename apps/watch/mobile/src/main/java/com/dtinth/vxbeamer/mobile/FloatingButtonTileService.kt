package com.dtinth.vxbeamer.mobile

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * A Quick Settings tile that switches the floating record button on and off,
 * so it can be summoned over any app — and put away again — without opening
 * this one (dtinth/vxbeamer#86).
 *
 * The sibling of [ToggleTileService], which records: that one is for speaking,
 * this one is for deciding whether the overlay should exist at all.
 *
 * Showing the button needs the "draw over other apps" grant, which can only
 * be given on a Settings screen. With no grant there is nothing a tap can do
 * from here, so it opens the app, where the toggle knows how to ask for it.
 * Hiding needs nothing.
 *
 * **Showing has to go through the activity**, for the same reason as in
 * [ToggleTileService]: hiding stops the idle service, and bringing it back up
 * is a microphone foreground start, which the background may not do. The
 * activity starts it and steps aside.
 */
class FloatingButtonTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        render()
    }

    override fun onClick() {
        super.onClick()
        when {
            RecorderService.isWindowShowing -> {
                RecorderService.send(this, RecorderService.ACTION_HIDE_WINDOW)
                // The service flips its flag asynchronously; draw what was asked for.
                render(active = false)
            }
            // Not a straight service start: with the service stopped, showing
            // the button means a microphone foreground start, which is refused
            // from the background — so it goes through the activity.
            Settings.canDrawOverlays(this) -> launchApp(showFloating = true)
            else -> launchApp()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun launchApp(showFloating: Boolean = false) {
        val intent =
            Intent(this, TransmitterActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(TransmitterActivity.EXTRA_SHOW_FLOATING, showFloating)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    this,
                    1,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun render(active: Boolean = RecorderService.isWindowShowing) {
        val tile = qsTile ?: return
        tile.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = getString(R.string.floating_tile_label)
        tile.updateTile()
    }
}
