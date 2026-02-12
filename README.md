# QuicLink

QuicLink 是一个面向 `Web + Desktop` 的房间式协作与传输系统，主目标是：

1. 局域网内优先走高性能链路（LAN Relay / WebTransport / 原生数据面）。
2. 跨网和复杂网络环境下仍能自动降级并成功传输（WebRTC / VPS Relay）。
3. 保持统一的同步体验（剪贴板、记事板、文件列表）。

## 功能概览

- 剪贴板同步（文本/图片）
- 记事板同步（多标签、冲突保护）
- 文件传输（LAN、WebRTC、VPS Relay、云端文件）
- 桌面端本地 LAN Server（HTTP + HTTP/3 + WT）

## 传输架构（Mode 1~4）

| Mode | 通道 | 适用场景 | 状态 |
| --- | --- | --- | --- |
| Mode 1 | Desktop LAN Server（HTTP/HTTP3/WebTransport + Go Native） | 局域网内、桌面端在线 | 主路径 |
| Mode 2 | WebRTC DataChannel | 无 LAN 主机或 LAN 握手失败 | 自动降级 |
| Mode 3 | VPS Relay（`/api/relay/*`） | WebRTC 不可达、跨网兜底 | 已实现 |
| Mode 4 | Cloud Files（`/upload` + `/api/files`） | 临时落盘分享、异步下载 | 已实现 |

## 面板语义

### `FilePanel`（共享列表 + 可落盘）

- 支持“懒共享”：先广播元数据，不立即上传到 LAN 主机。
- 当接收方点击下载后，发送方才触发 relay 上传。
- 允许“直接上传到主机”形成可留存文件。
- 适合“文件管理/留存”场景。

### `P2PFilePanel`（即时中转 + 不留存）

- 优先 LAN Relay，失败自动切 WebRTC，再失败切 VPS Relay。
- `relayStatus`: `pending` / `requesting` / `ready`。
- 删除采用房间级同步广播（`p2p_offer_removed`），实时移除跨端列表。
- 适合“快速投递”场景。

## 下载策略（Web）

Web 端提供两种下载模式（本地存储键：`ql_web_download_mode`）：

- `compat`（默认，兼容优先）
  - 优先 URL 交给浏览器下载器接管
  - LAN URL 顺序：`HTTPS URL -> HTTP URL`
- `speed`（速度优先）
  - 优先 WT(JS) 流式下载
  - 失败后回退 URL（`HTTPS -> HTTP`）

说明：
- 浏览器 / WebView 对 WT、证书、下载器接管支持差异较大，因此保留双模式。
- 桌面端优先 Go 原生传输路径，规避 WebView 限制。

## 仓库结构

```text
.
|- src/server            # Go 服务端（信令、API、HTTP/3、WT）
|- src/web               # Vue 3 + TypeScript Web 客户端
|- src/desktop           # Wails Desktop（Go + Vue）
|- src/android           # Android 脚手架（Capacitor + Native plugin + Go 占位）
|- scripts               # 部署脚本
|- docker-compose.yml    # 本地容器运行
|- docker-compose.prod.yml
`- Makefile              # 常用构建/部署命令
```

## 环境要求

- Go `1.24+`（`src/server`、`src/desktop`）
- Node.js `^20.19.0 || >=22.12.0`
- npm `10+`（建议）
- Wails v2（开发桌面端时）

## 快速开始（本地开发）

### 1) 启动服务端

```bash
cd src/server
cp config.example.json config.json
go run .
```

默认行为：
- `use_https=true` 且证书不存在时自动生成自签证书。
- HTTPS 模式下同时启动：
  - `:3100`（HTTPS + HTTP/3 + WT）
  - `:3101`（HTTP -> HTTPS 重定向，便于容器映射 `80:3101`）

### 2) 启动 Web

```bash
cd src/web
npm install
npm run dev
```

可选 `.env`：

```env
VITE_VPS_HOST=localhost:3100
VITE_TURN_URL=
VITE_TURN_USERNAME=
VITE_TURN_CREDENTIAL=
VITE_ICE_SERVERS=
```

### 3) 启动 Desktop

```bash
cd src/desktop
wails dev
```

## 构建

### 手动构建

```bash
# Server
cd src/server && go build ./...

# Web
cd src/web && npm run build

# Desktop
cd src/desktop && wails build
```

### Makefile

```bash
make build-server
make build-web
make build-desktop

# VPS
make deploy-vps VPS_HOST=<ip>
make start-vps VPS_HOST=<ip>
make stop-vps VPS_HOST=<ip>
```

## Docker

### 本地 compose

```bash
docker compose up -d --build
```

默认端口映射（`docker-compose.yml`）：
- `443 -> 3100/tcp + 3100/udp`
- `80 -> 3101`
- `3100 -> 3100`（可保留用于调试）

### 生产 compose

使用 `docker-compose.prod.yml`，镜像默认 `ghcr.io/suir1/quiclink:latest`。

## 关键接口

### 基础

- `GET /api/info`
- `GET /ws`
- `CONNECT /wt`

### 云端文件

- `POST /upload`
- `GET /api/files`
- `DELETE /api/files/:id`

### VPS Relay

- `POST /api/relay/upload/:id`
- `GET /api/relay/meta/:id`
- `GET /api/relay/download/:id`
- `POST /api/relay/ack/:id`

`/api/relay/meta/:id` 用于下载前探测 relay 可用性和剩余有效期。

### LAN Server（Desktop）

- `GET /api/lan/files`
- `POST /api/lan/upload`
- `GET /api/lan/download/:id`
- `POST /api/lan/relay/upload/:id`
- `GET /api/lan/relay/download/:id`
- `CONNECT /wt`

## CI/CD 与发版

GitHub Actions 工作流位于 `.github/workflows`：

- `ci.yml`：分平台构建检查
- `release.yml`：打包 server/web/desktop 并创建 Release
- `docker-publish.yml`：推送 GHCR 镜像

触发条件（release/docker）：
- 推送 tag：`v*` 或纯数字语义版本（如 `2.1.0`）

示例：

```bash
git tag -a 2.1.0 -m "release 2.1.0"
git push origin 2.1.0
```

## 常见问题

### 1) HTTPS 页面访问 HTTP LAN 被拦截（Mixed Content）

浏览器会拦截 `https://` 页面直接 `fetch(http://192.168.x.x...)`。  
系统已提供 URL 导航降级（HTTPS URL 失败后回退 HTTP URL）。

### 2) `QUIC_TLS_CERTIFICATE_UNKNOWN`

LAN WT 使用自签证书时必须匹配 `serverCertificateHashes`。  
不支持该能力的环境会回退 HTTP/WebRTC/VPS。

### 3) `webview_no_webtransport`

常见于 Safari/WebKit 容器。  
建议切 `compat` 模式或使用桌面端原生通道。

### 4) 传输速度低于预期

先看诊断栏中的 `path/route/uploadVia/speed/progress`：
- `LAN HTTP Relay` 通常低于 WT/原生通道。
- 小文件更容易被握手开销影响；大文件更能体现链路差异。

## 许可证

MIT
