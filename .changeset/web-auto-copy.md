---
"website": minor
---

Add an auto-copy setting: when on, a transcript is copied to the clipboard as soon as it finishes, however the recording was stopped — the record button, the `r` shortcut, or releasing Space.

Only recordings made on this device are copied. The feed carries every signed-in device's messages, so "the transcript that just finished" is not the same thing as "the transcript I just recorded"; the watcher is keyed to a reference id this client minted when it started recording. Off by default, since taking over the clipboard is not something to opt someone into.

Push-to-talk keeps copying on release regardless of the setting, and now shares the same waiting logic rather than carrying its own copy of it.
