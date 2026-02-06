# QuicLink (Fast-Run) ⚡

A high-performance P2P Sync Engine built on **HTTP/3 (WebTransport)** and **WebSocket** for private data orchestration.
QuicLink allows real-time synchronization of **Clipboard**, **Notepad**, and **Files** across your Browser, Windows, macOS, and Linux devices.

**Current Status:** Active Development (Beta).

---

## ✨ Features

- **Real-time Clipboard Sync**: Copy on one device, paste on another instantly.
- **Live Notepad**: Real-time collaborative notepad editing across all connected devices.
- **P2P File Transfer**: High-speed, direct file transfer between devices using WebTransport (or WebSocket fallback).
- **Cross-Platform**:
    - **Web**: Access via any modern browser (Chrome/Edge recommended for HTTP/3).
    - **Desktop**: Native-like experience on Windows, macOS, and Linux (via Wails).

## 🚀 Installation & Usage

### 📦 Desktop Client (Windows / macOS / Linux)

1.  **Download**: Go to the [Releases](../../releases) page and download the client for your OS.
    -   **Windows**: `.zip` (Extract and run `QuicLink.exe`)
    -   **macOS**: `.zip` (Extract and run `QuicLink.app`)
    -   **Linux**: `.tar.gz` (Extract and run `QuicLink`)
2.  **Configuration**:
    -   On first launch, click the **Settings (⚙️)** icon in the top toolbar to configure your server address.
    -   Default: `localhost:8080` (If you are running your own server).
3.  **Connection**:
    -   **Public Mode**: Enter any room name (e.g., `my-room`) or generate a random one to join.
    -   **Private Mode**: If the server is in private mode, you will be prompted for a password.

### 🌐 Web Client

1.  Access the web client via your browser: `https://your-server-domain.com`.
2.  If running locally: `http://localhost:5173`.
3.  **Room Access**:
    -   Enter a room name to join.
    -   You can also use a direct link: `https://your-server-domain.com/#/my-room`.

### 🖥️ Self-Hosting Server (Go)

You can run your own QuicLink server for complete privacy and control.

#### Option 1: Run from Source

1.  **Prerequisites**: Go 1.21+
2.  **Clone & Run**:
    ```bash
    git clone https://github.com/suir1/QuicLink.git
    cd QuicLink/src/server
    go run .
    ```
3.  **Configuration**:
    The server looks for `config.json` in the working directory.
    Example `config.json`:
    ```json
    {
      "host": "0.0.0.0",
      "port": 8080,
      "mode": "public",  // "public" or "private"
      "password": "your-secret-password", // Required if mode is "private"
      "cert_file": "./cert.pem", // SSL Cert (Optional for localhost, Required for Public WebTransport)
      "key_file": "./key.pem"    // SSL Key
    }
    ```

#### Option 2: Deploy on VPS with Domain & SSL (Recommended)

To use WebTransport over the internet, you **must** use a valid SSL certificate (browser requirement).

1.  **Install Certbot** (Ubuntu/Debian):
    ```bash
    sudo apt update
    sudo apt install certbot
    ```

2.  **Generate Certificate**:
    Replace `your-domain.com` with your actual domain.
    ```bash
    # Stop any running server on port 80 first
    sudo certbot certonly --standalone -d your-domain.com
    ```
    This will generate certificates in `/etc/letsencrypt/live/your-domain.com/`.

3.  **Configure Server**:
    Update `config.json` to point to your new certificates.
    *Note: You may need to copy the certs to your app directory if permission issues arise, or run the server with appropriate read permissions.*

    ```bash
    # Example: Copy certs to current directory (Automation recommended for renewals)
    sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ./cert.pem
    sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem ./key.pem
    sudo chown $USER:$USER cert.pem key.pem
    ```

    Or update `config.json` directly if permissions allow:
    ```json
    {
      "port": 8080,
      "cert_file": "/etc/letsencrypt/live/your-domain.com/fullchain.pem",
      "key_file": "/etc/letsencrypt/live/your-domain.com/privkey.pem"
    }
    ```

#### Option 3: Docker Deployment (Fastest)

Deploy the full stack (Server + Web) using Docker Compose.

1.  **Clone Repo**:
    ```bash
    git clone https://github.com/your-repo/QuicLink.git
    cd QuicLink
    ```

2.  **Configure**:
    *   `docker-compose.yml` mounts `src/server/config.json`.
    *   Copy example config and edit it (Enable HTTPS and set cert paths if deploying to public).
    ```bash
    cp src/server/config.example.json src/server/config.json
    nano src/server/config.json
    ```

3.  **Run**:
    ```bash
    # Build and start in background
    docker-compose up -d --build
    ```
    *   Server on port `8080` (HTTPS/HTTP3).
    *   Web Client (if served separately, though current Dockerfile builds static assets to server) -> The server serves the web client at `/`.

    *Note: The Dockerfile uses multi-stage builds. It compiles everything inside the container, so you don't need Go or Node.js installed on your host.*

## 🛠️ Development

### Prerequisites

- **Go**: 1.21+
- **Node.js**: 18+
- **Wails**: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`

### Run Locally

1.  **Server**:
    ```bash
    cd src/server
    go run .
    ```

2.  **Web Client**:
    ```bash
    cd src/web
    npm install
    npm run dev
    ```

3.  **Desktop Client**:
    ```bash
    cd src/desktop
    wails dev
    ```

## 🏗️ Architecture

- **Server (`src/server`)**: Go (HTTP/3 + WebSocket signaling).
- **Web Frontend (`src/web`)**: Vue 3 + TypeScript + Element Plus.
- **Desktop Client (`src/desktop`)**: Wails (Go + Vue 3).

## 📜 License

MIT License.
