package com.dtinth.vxbeamer.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * The web app's own colours, so the two halves of vxbeamer look like one
 * thing (dtinth/vxbeamer#86).
 *
 * Taken verbatim from the `--m3-*` custom properties in
 * `apps/website/src/style.css`. That palette is dark-only — the website
 * defines no light variant and does not respond to `prefers-color-scheme` —
 * so this does not either. Following the system here would have meant a
 * light theme the web app has no counterpart for, which is the opposite of
 * matching it.
 */
private val VxbeamerColors =
    darkColorScheme(
        primary = Color(0xFFBBCF82),
        onPrimary = Color(0xFF283500),
        primaryContainer = Color(0xFF3D4C0D),
        onPrimaryContainer = Color(0xFFD7EB9B),
        inversePrimary = Color(0xFF546524),
        secondary = Color(0xFFC3CAA9),
        onSecondary = Color(0xFF2D331C),
        secondaryContainer = Color(0xFF434931),
        onSecondaryContainer = Color(0xFFDFE6C4),
        tertiary = Color(0xFFA1D0C6),
        onTertiary = Color(0xFF023731),
        tertiaryContainer = Color(0xFF204E47),
        onTertiaryContainer = Color(0xFFBCECE2),
        error = Color(0xFFFFB4AB),
        onError = Color(0xFF690005),
        errorContainer = Color(0xFF93000A),
        onErrorContainer = Color(0xFFFFDAD6),
        background = Color(0xFF12140D),
        onBackground = Color(0xFFE3E3D7),
        surface = Color(0xFF12140D),
        onSurface = Color(0xFFE3E3D7),
        surfaceVariant = Color(0xFF46483C),
        onSurfaceVariant = Color(0xFFC6C8B8),
        surfaceTint = Color(0xFFBBCF82),
        inverseSurface = Color(0xFFE3E3D7),
        inverseOnSurface = Color(0xFF303129),
        outline = Color(0xFF909284),
        outlineVariant = Color(0xFF46483C),
        scrim = Color(0xFF000000),
        surfaceBright = Color(0xFF383A32),
        surfaceDim = Color(0xFF12140D),
        surfaceContainerLowest = Color(0xFF0D0F08),
        surfaceContainerLow = Color(0xFF1B1C15),
        surfaceContainer = Color(0xFF1F2019),
        surfaceContainerHigh = Color(0xFF292B23),
        surfaceContainerHighest = Color(0xFF34362D),
    )

/** The floating window is plain views, not Compose, so it reads these directly. */
object VxbeamerPalette {
    const val SURFACE_CONTAINER = 0xFF1F2019.toInt()
    const val ON_SURFACE = 0xFFE3E3D7.toInt()
    const val PRIMARY = 0xFFBBCF82.toInt()
    const val ERROR = 0xFFFFB4AB.toInt()
    const val OUTLINE_VARIANT = 0xFF46483C.toInt()
}

@Composable
fun VxbeamerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = VxbeamerColors, content = content)
}
