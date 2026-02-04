# QuicLink (Fast-Run) ⚡

A high-performance P2P Sync Engine built on **HTTP/3 (WebTransport)** and **WebSocket** for private data orchestration.
QuicLink allows real-time synchronization of **Clipboard**, **Notepad**, and **Files** across your Browser, Windows, macOS, and Linux devices.

**Current Status:** Active Development (Beta).

## ✨ Features

- **Real-time Clipboard Sync**: Copy on one device, paste on another instantly.
- **Live Notepad**: Real-time collaborative notepad editing across all connected devices.
- **P2P File Transfer**: High-speed, direct file transfer between devices using WebTransport (or WebSocket fallback).
- **Cross-Platform**:
    - **Web**: Access via any modern browser (Chrome/Edge recommended for HTTP/3).
    - **Desktop**: Native-like experience on Windows, macOS, and Linux (via Wails).

## 🏗️ Architecture

The project utilizes a modern hybrid architecture:

- **Server (`src/server`)**:
    - **Language**: Go (Golang)
    - **Role**: Signaling server, room management, and WebTransport gateway.
    - **Protocol**: HTTP/3 (QUIC) + WebSocket (Fallback).
- **Web Frontend (`src/web`)**:
    - **Framework**: Vue 3 + TypeScript + Vite + Element Plus.
    - **Role**: Browser-based client.
- **Desktop Client (`src/desktop`)**:
    - **Framework**: [Wails](https://wails.io) (Go + Vue 3).
    - **Role**: Native desktop application with system integration (Clipboard access).

## 📂 Project Structure

```text
QuicLink/
├── src/
│   ├── server/      # Go Signaling Server
│   ├── web/         # Web Client (Vue 3)
│   └── desktop/     # Desktop Client (Wails application)
├── .github/         # CI/CD Workflows (GitHub Actions)
└── go.work          # Go Workspace
```

## 🚀 Getting Started

### Prerequisites

- **Go**: 1.21+
- **Node.js**: 18+
- **Wails**: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`

### 1. Run Server (Go)

```bash
cd src/server
go run .
# Server starts on http://localhost:8080
```

### 2. Run Web Client

```bash
cd src/web
npm install
npm run dev
# Access at http://localhost:5173
```

### 3. Run Desktop Client

```bash
cd src/desktop
wails dev
# Application window will open
```

## 🛠️ Build & Deploy

This project uses **GitHub Actions** for automated builds:

- **Web**: Built to `src/web/dist`.
- **Desktop**: Automatically packages native binaries for Windows (`.exe`), macOS (`.app`), and Linux.
- **Server**: Compiles binaries for multiple architectures.

To trigger a build, simply push to the `main` branch.
To create a release, push a tag starting with `v` (e.g., `v1.0.0`).

## 📜 License

MIT License.
