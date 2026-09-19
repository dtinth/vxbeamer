# vxbeamer transmitter

Voice input for vxbeamer from a phone, or from a Wear OS watch (built and
tested against a Samsung Galaxy Watch 5) that never talks to the internet
itself (dtinth/vxbeamer#86).

Two separate Android apps live here, in one Gradle project:

- **`wear/`** — runs on the watch. One button. Tap to start: captures the
  mic (16 kHz / 16-bit / mono, the exact format vxbeamer's own `/ws` already
  expects) and streams it to the phone over Bluetooth, using the Wear OS
  Data Layer's `ChannelClient`. Tap again to stop.
- **`mobile/`** — runs on the paired phone. Records from its own
  microphone, and receives audio relayed from the watch.

  **Recording never waits for the network.** Audio goes to local storage as
  it is spoken, and uploading is a separate, retryable thing that happens to
  it afterwards — the same shape as a voice memo. Tapping stop is instant
  whatever the connection is doing, nothing is lost when an upload fails,
  and a bad transcript can be transcribed again from the audio still on the
  device.

  In the normal case the two run at once: the uploader tails the file while
  the microphone is still writing it, so a transcript arrives as promptly as
  it would from a live socket. The same code path run later against a
  finished file is a retry.

  Three ways to start, because none of them is best everywhere:

  |                     | Reach             | Notes                                                                                                                                                       |
  | ------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Full screen         | Open the app      | Record button at the bottom, in thumb reach, above the history                                                                                              |
  | Floating button     | One tap, anywhere | Draggable, live transcript and level meter. Uses "draw over other apps", which banking apps can suppress on Android 12+, so it is opt-in and switchable off |
  | Quick Settings tile | Swipe down, tap   | No permission, and no app can suppress it                                                                                                                   |

  Leaving the app mid-recording drops it into a square picture-in-picture
  window. That window is a **status readout, not a control** — a PiP window
  never delivers touches to its content, so its stop button is the
  `RemoteAction` revealed by tapping it.

  Watch audio goes through the same store, so relayed recordings get the
  same history and the same retry as local ones.

  Any recording's audio can be exported as a WAV, in the same format the
  eval fixtures use, for listening to or testing a transcription against.
  Audio is capped at 10 MB in total, oldest dropped first — except audio
  that has not been transcribed yet, which is never deleted to stay under
  the cap, since that would destroy the only copy of what was said.

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

## Design

| Piece                                          | Job                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `Recording`, `UploadPolicy`, `RetentionPolicy` | What a recording is, what gets uploaded next, what gets kept       |
| `RecordingStore`                               | Audio files and the index on disk                                  |
| `AudioCapture`                                 | Microphone to file. Knows nothing about the network                |
| `TranscriptionUploader`                        | File to `/ws`, and `/sse` back. Knows nothing about the microphone |
| `Recorder`                                     | Ties those together and owns the queue                             |
| `RecorderService`                              | Keeps it alive in the background; hosts the floating button        |

The split is what makes the tests possible: everything in the first four
rows is free of Android APIs, so it runs on a plain JVM.

## Tests

```bash
cd apps/watch
./gradlew testDebugUnitTest
```

Unit tests, no emulator, seconds to run — and they run in CI on every push.
They cover the parts where being wrong is quiet: URL building (a swapped
`ws`/`wss` scheme shipped once and took a device and a logcat to find), the
`/sse` event filtering that decides whether a transcript is _yours_, the
upload and retention rules, crash recovery, and the store's behaviour across
a restart.

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
