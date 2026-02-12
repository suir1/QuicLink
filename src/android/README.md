# QuicLink Android Scaffold

This directory contains the Android app scaffold for the existing QuicLink desktop/web stack.

## Target architecture

- UI and feature flow: `src/web` (Vue)
- Android container and native lifecycle: `src/android` (Capacitor + Kotlin)
- Reusable LAN host core: `src/android/go/lanhost` (Go placeholder)

## Directory layout

```text
src/android
|- capacitor.config.ts
|- package.json
|- plugins/
|  `- quiclink-native/          # Kotlin bridge plugin scaffold
`- go/
   `- lanhost/                  # Go LAN host module scaffold
```

## Intended workflow

1. Build web assets from `src/web`.
2. Sync assets into Android project via Capacitor.
3. Implement platform features in `plugins/quiclink-native`.
4. Reuse/refactor LAN server logic into `go/lanhost` and bind via gomobile/JNI.

## Bootstrap commands

```bash
cd /Users/sui/Code/projects/QuicLink/src/android
npm install
npm run cap:add
npm run cap:sync
npm run cap:open
```

The command `cap:add` creates the native Android project under `src/android/android`.
