# lanhost module scaffold

This module is a placeholder for extracting reusable LAN host logic from:

- `/Users/sui/Code/projects/QuicLink/src/desktop/server/local_server.go`

## Goal

Create a mobile-safe Go core that can be exported with gomobile and called from Android.

## Extraction plan

1. Move protocol handlers and relay state logic into this package.
2. Replace desktop-specific paths (`~/Downloads`, `os.TempDir`) with injected providers.
3. Expose start/stop/status APIs with simple exported types for gomobile binding.
