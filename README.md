# QuicLink
A high-performance P2P Sync Engine used on QUIC &amp; WebTransport for private data orchestration.


**Current Status:** In active development (Architecture scaffolding phase).

## 📖 Introduction
QuicLink solves the fragmentation of data across heterogenous networks. It establishes a secure, private tunnel between your Browser, Windows, and macOS devices without relying on public cloud relays.

## 🏗️ Architecture
The project follows a **Hybrid Architecture**:

* **Core / Client (`src/client`)**: 
    * Native C++20 application based on **Qt 6**.
    * Acts as a local QUIC Server & WebTransport Gateway.
    * Handles file I/O, encryption, and system integration (Clipboard/Tray).
* **Signaling Server (`src/server`)**: 
    * High-concurrency **Golang** service.
    * Handles device discovery and SDP exchange via WebSocket.
* **Web Frontend (`src/web`)**: 
    * (Planned) TypeScript + Vue 3 interface using WebTransport API.

## 📂 Project Structure
```text
QuicLink/
├── src/
│   ├── client/      # C++ Native Client (Qt6 + CMake)
│   ├── server/      # Go Signaling Server
│   ├── core/        # Shared Protocol & Logic (C++20)
│   └── platform/    # OS-specific implementations (JNI, Cocoa, Win32)
├── third_party/     # Dependencies (msquic, etc.)
└── docker/          # Server deployment scripts

```

## ⚡ Getting Started

### Prerequisites

* **C++ Compiler:** Clang (macOS) or MSVC (Windows) supporting C++20.
* **Qt 6:** Required for the client GUI and networking.
* **Go 1.20+:** Required for the signaling server.
* **CMake 3.16+:** Build system.

### 1. Build & Run Client (C++)

```bash
mkdir build && cd build
cmake ..
cmake --build .

# Run the client
./src/client/QuicLinkClient

```

### 2. Run Signaling Server (Go)

```bash
cd src/server
go run .

```

## 🗺️ Roadmap

* [x] Project Scaffolding (CMake + Go Module)
* [x] Cross-platform System Tray (Qt)
* [ ] WebSocket Connection (C++ <-> Go)
* [ ] Integration of MsQuic
* [ ] WebTransport Handshake Implementation

```
