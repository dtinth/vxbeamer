package com.dtinth.vxbeamer.mobile

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * `MaterialTheme`'s own `colorScheme` default is a fixed light scheme — it
 * does not follow the system setting on its own, which is why both screens
 * stayed light-only until this existed (dtinth/vxbeamer#86). One shared
 * theme composable so a future screen picks this up automatically rather
 * than needing the same `isSystemInDarkTheme()` check copied into it.
 */
@Composable
fun VxbeamerTheme(content: @Composable () -> Unit) {
    val colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
    MaterialTheme(colorScheme = colorScheme, content = content)
}
