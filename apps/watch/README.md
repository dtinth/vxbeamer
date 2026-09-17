# vxbeamer transmitter

Voice input for vxbeamer from a phone, or from a Wear OS watch (built and
tested against a Samsung Galaxy Watch 5) that never talks to the internet
itself (dtinth/vxbeamer#86).

Two separate Android apps live here, in one Gradle project:

- **`wear/`** — runs on the watch. One button. Tap to start: captures the
  mic (16 kHz / 16-bit / mono, the exact format vxbeamer's own `/ws` already
  expects) and streams it to the phone over Bluetooth, using the Wear OS
  Data Layer's `ChannelClient`. Tap again to stop.
- **`mobile/`** — runs on the paired phone. Two independent ways to get
  audio into vxbeamer:
  - Watch relay, with no screen interaction needed once signed in. Woken
    automatically by the system the moment the watch opens a stream (a
    `WearableListenerService`, so no notification or battery cost while
    idle). Reads the raw audio from that stream and forwards it straight to
    vxbeamer's `/ws`, the same protocol the browser uses, then sends the
    normal stop message once the watch closes its side.
  - "Transcribe anywhere" — the phone's own mic, no watch involved
    (`PipTranscribeActivity`, with the recording itself in
    `TranscriptionSession`, shared with the floating window). The finished
    transcript is copied to the clipboard automatically, watched over
    `/sse` — the same events the web app reacts to.

    Three ways to reach it, because none of them is best everywhere:

    |                     | Reach             | Notes                                                                                                                                                       |
    | ------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | Full screen         | Open the app      | Record button at the bottom, in thumb reach                                                                                                                 |
    | Floating button     | One tap, anywhere | Draggable, live transcript and level meter. Uses "draw over other apps", which banking apps can suppress on Android 12+, so it is opt-in and switchable off |
    | Quick Settings tile | Swipe down, tap   | No permission, and no app can suppress it                                                                                                                   |

    Leaving the app mid-recording drops it into a square picture-in-picture
    window. That window is a **status readout, not a control** — a PiP
    window never delivers touches to its content, so its stop button is the
    `RemoteAction` revealed by tapping it.

Sign-in reuses the desktop app's own flow: the phone app opens your browser,
you sign in, the hosted web app shows a short code, and you paste that code
back into the phone app. Nothing on the backend or website needed to change
for a second app to reuse this path.

## Status

The **phone app works** — transcribing from its own mic is verified on real
hardware (dtinth/vxbeamer#86).

The **watch relay is still unverified**: it has never completed a recording
on a real watch, and the watch it was written for has a failing battery. It
compiles and its one known bug is fixed (the relay shares
`BackendWebSocket` with the phone, which was rejecting its own URLs until
that was found on device), but treat it as untested.

This is developed in a sandbox with no emulator (no hardware
virtualization), so anything not listed as verified above has only been
checked for `assembleDebug` and `lintDebug` passing.

## Prerequisites

| Requirement     | Notes                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- |
| **JDK 21**      | e.g. `mise use -g java@21`                                                              |
| **Android SDK** | `compileSdk 34`; command-line tools are enough, Android Studio is not required to build |

On an Apple Silicon Mac or another arm64 Linux machine, Google's own `aapt2`
(pulled in by the Android Gradle Plugin) is x86_64-only and will fail to run.
See [Commit451/android-arm-build-tools](https://github.com/Commit451/android-arm-build-tools)
for a drop-in arm64 replacement, or build on an x86_64 machine — GitHub
Actions' runners already are, so CI needs none of this.

## Building

```bash
cd apps/watch
./gradlew assembleDebug
```

Produces two unsigned-but-debug-signed APKs:

- `mobile/build/outputs/apk/debug/mobile-debug.apk`
- `wear/build/outputs/apk/debug/wear-debug.apk`

## Installing

Both apps are personal and unpublished — there is no Play Store listing.
Install straight from the APK:

```bash
adb install mobile/build/outputs/apk/debug/mobile-debug.apk   # to the phone
adb -s <watch-serial> install wear/build/outputs/apk/debug/wear-debug.apk   # to the watch, over adb-over-wifi or a USB dock
```

Or download the built APKs from GitHub Actions (see below) and open the file
directly on-device.

Sign in inside the phone app once, with the backend URL, before trying to
record from the watch.

## CI

The [Build Watch Apps](../../.github/workflows/watch.yml) workflow builds
both APKs on every push to `main` and on pull requests touching this
directory, and uploads them as GitHub Actions artifacts — open the workflow
run and download `vxbeamer-watch-relay-mobile-debug` /
`vxbeamer-watch-relay-wear-debug` from the bottom of the page.
