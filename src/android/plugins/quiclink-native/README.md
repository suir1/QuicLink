# quiclink-native plugin scaffold

This plugin is the Android native bridge for features that cannot be handled by WebView alone.

## Planned responsibilities

- Foreground service lifecycle for LAN host mode
- Android storage APIs (SAF, MediaStore)
- Download manager integration
- Runtime permissions and notification channels
- Bridge calls between Vue app and native code

## Next implementation steps

1. Register plugin in the Capacitor app once `android/` project exists.
2. Wire `startLanHost`/`stopLanHost` to a real foreground service.
3. Bind Go LAN module via gomobile/JNI from the service.
