# QuicLink 1.0.0

QuicLink is a room-based sync and transfer system for **Web + Desktop**.
It combines signaling, LAN acceleration, WebRTC, and VPS relay to maximize transfer success across mixed networks.

Current scope:
- Clipboard sync
- Notepad sync
- File transfer (LAN / P2P / VPS relay / cloud)

---

## Key Concepts

### Two file panels with different semantics

- `FilePanel`
  - Shared list + persistent storage workflow.
  - LAN host can store files on disk.
- `P2PFilePanel`
  - Relay-first workflow.
  - Designed for transient transfer and fallback chain.

### 4 transfer modes

1. Desktop LAN server (HTTP / WebTransport)
2. Browser P2P (WebRTC DataChannel)
3. VPS relay (`/api/relay/*`)
4. Cloud storage upload/download (`/upload`, `/api/files`)

---

## Transport Strategy (Implemented)

### Upload / relay (high-level)

- Desktop native path (preferred when available):
  - Go native LAN relay (`StartNativeRelayUpload`)
  - fallback to VPS native relay (`UploadVpsRelayFile`)
- Web path:
  - LAN WT relay -> WebRTC -> VPS relay fallback

### Download (web)

Web has two download modes:
- `compat` (default): URL handoff first (browser download manager)
- `speed`: WT(JS) first, then URL fallback

For LAN URL handoff in `compat` mode:
- HTTPS URL first
- HTTP URL second

### Download (desktop)

- Go native LAN relay download first
- WT relay fallback
- HTTP URL fallback

---

## Repository Layout

- `src/server` - Go signaling + API server (HTTP/3 + WS + relay APIs)
- `src/web` - Vue 3 + TypeScript web client
- `src/desktop` - Wails desktop app (Go backend + Vue frontend)

---

## Quick Start (Local)

## 1) Start server

```bash
cd src/server
go run .
```

Default behavior:
- Reads `config.json` in `src/server`
- If `use_https=true` and cert files are missing, self-signed certs are generated automatically

## 2) Start web client (dev)

```bash
cd src/web
npm install
npm run dev
```

## 3) Start desktop client (dev)

```bash
cd src/desktop
wails dev
```

Prerequisites:
- Go 1.24+
- Node.js 18+
- Wails v2

---

## Server Config

Path: `src/server/config.json`

Example:

```json
{
  "app_mode": "public",
  "admin_password": "",
  "use_https": true,
  "port": 3100,
  "room_ttl_hours": 48,
  "cert_file": "cert.pem",
  "key_file": "key.pem",
  "force_cert_hash": true,
  "limits": {
    "max_upload_size_mb": 10,
    "file_retention_minutes": 10,
    "allow_p2p_relay": false
  }
}
```

Notes:
- `app_mode=private` requires `admin_password`
- `limits.max_upload_size_mb` affects relay/cloud limits
- `limits.file_retention_minutes` controls relay TTL

---

## Web Environment

Path: `src/web/.env`

Example keys:

```env
VITE_VPS_HOST=localhost:3100
VITE_TURN_URL=
VITE_TURN_USERNAME=
VITE_TURN_CREDENTIAL=
VITE_ICE_SERVERS=
```

---

## Relay APIs

Server endpoints:

- `POST /api/relay/upload/:id`
- `GET  /api/relay/meta/:id`
- `GET  /api/relay/download/:id`
- `POST /api/relay/ack/:id`

Typical use:
- upload -> broadcast offer -> receiver downloads -> receiver ack

---

## Build

### Web

```bash
cd src/web
npm run build
```

### Desktop frontend

```bash
cd src/desktop/frontend
npm run build
```

### Desktop Go

```bash
cd src/desktop
go build ./...
```

### Server

```bash
cd src/server
go build .
```

---

## Deployment

- `Makefile` includes VPS build/deploy helpers
- `docker-compose.yml` and `docker-compose.prod.yml` are provided
- For public WT/HTTP3 usage, TLS and UDP exposure are required

---

## Operational Notes

- Browser mixed-content restrictions still apply to HTTPS page -> HTTP fetch.
- URL navigation handoff and QR/open-new-tab flows are used where browser policy blocks fetch.
- Some embedded webviews do not support WebTransport; fallback paths are required.

---

## License

MIT
