# QuicLink 1.0.1

QuicLink 是一个面向 **Web + Desktop** 的房间式同步与传输系统，目标是让“同局域网更快、跨网络也能成功”。

核心能力：
- 剪切板同步
- 记事板同步
- 文件传输（LAN 直连/中转、WebRTC、VPS Relay、云端临时存储）

## 当前架构（Mode 1 ~ Mode 4）

| Mode | 数据通道 | 适用场景 | 当前状态 |
| --- | --- | --- | --- |
| Mode 1: Desktop LAN Server | HTTP / HTTP3(WebTransport) + Go 原生通道 | 同一局域网，桌面端在线 | 已实现（主路径） |
| Mode 2: WebRTC P2P | WebRTC DataChannel | 无 LAN 主机或 LAN 握手失败 | 已实现（自动降级） |
| Mode 3: VPS Relay | `/api/relay/*` | P2P 不可达、跨网兜底 | 已实现（含 meta/ack） |
| Mode 4: Netdisk/Cloud | `/upload` + `/api/files` | 临时落盘分享/异步下载 | 已实现（基础版） |

## 两个文件面板的职责

### `FilePanel`
- 目标：共享列表 + 主机可落盘（适合“文件管理/留存”）
- Web 端支持“懒共享”：先广播元数据，不立即上传。
- 当接收方点击下载后，才触发发送方向 LAN 主机发起 relay 上传。
- 对 relay 文件会发出 `lan_consumed`，用于消费后从共享列表清理。
- 同时保留“直接上传到主机”入口（显式落盘）。

### `P2PFilePanel`
- 目标：即时中转，不做长期存储（适合“快发快收”）
- 优先走 LAN relay；失败自动切 WebRTC；再失败切 VPS relay。
- 列表项会跟踪 `relayStatus`（`pending/requesting/ready`）。

## 当前传输策略（代码已落地）

### 1) Web 下载策略

Web 有两个下载模式：
- `compat`（默认）
- `speed`

`compat`（兼容优先）：
1. 优先 URL 交给浏览器下载器接管（可进入浏览器下载列表）
2. LAN URL 顺序：`HTTPS URL` -> `HTTP URL`
3. 若 URL 不可用，则本次下载直接报错（不强制切 WT）

`speed`（速度优先）：
1. 优先 WT(JS) 流式下载（LAN WT direct/relay）
2. 失败后回退 URL（HTTPS -> HTTP）

说明：不同浏览器/内嵌 WebView 对 WT、下载器接管、证书策略支持不一致，因此保留双模式。

### 2) `P2PFilePanel` 发送链路

优先级：
1. LAN Relay（WT relay 优先，失败回 HTTP relay）
2. WebRTC
3. VPS Relay

即：**LAN relay 超时/握手失败后会自动切 WebRTC，再切 VPS relay**。

### 3) 桌面端（Desktop）传输链路

- 桌面端优先使用 Go 原生数据面（减少 JS/WebView 限制）。
- LAN relay 上传：`StartNativeRelayUpload`（Go 原生）
- VPS relay 上传：`UploadVpsRelayFile`（返回 `uploadVia`）
- LAN relay 下载：`DownloadLanRelayFile`（Go 原生）
- 桌面端诊断栏显示 `path/route/uploadVia/speed/progress`。

## 关键接口

### 信令与基础
- `GET /ws`（WebSocket）
- `CONNECT /wt`（WebTransport，HTTPS 模式）
- `POST /upload`
- `GET /api/files`
- `GET /api/info`

### VPS Relay
- `POST /api/relay/upload/:id`
- `GET /api/relay/meta/:id`
- `GET /api/relay/download/:id`
- `POST /api/relay/ack/:id`

`/api/relay/meta/:id` 作用：
- 下载前探测 relay 是否可用（`ready/not_found/expired/missing`）
- 返回剩余有效期（`remainingSeconds`）
- 返回大小、下载次数、ack 次数，便于前端做重试与提示

### Desktop LAN Server（本地）
- `GET /api/lan/files`
- `POST /api/lan/upload`
- `GET /api/lan/download/:id`
- `POST /api/lan/relay/upload/:id`
- `GET /api/lan/relay/download/:id`
- `CONNECT /wt`（LAN WebTransport）

## 配置

服务端配置文件：`/Users/sui/Code/projects/QuicLink/src/server/config.json`

示例：

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

关键项说明：
- `use_https`: 开启后启用 HTTP/3 + WebTransport（并对外提供证书 hash）
- `force_cert_hash`: 自签证书场景下用于 WT certificate hash 校验
- `limits.max_upload_size_mb`: 限制云端/VPS relay 上传大小
- `limits.file_retention_minutes`: relay 文件有效期
- `app_mode=private`: 需要 `admin_password`

Web 环境变量：`/Users/sui/Code/projects/QuicLink/src/web/.env`

```env
VITE_VPS_HOST=localhost:3100
VITE_TURN_URL=
VITE_TURN_USERNAME=
VITE_TURN_CREDENTIAL=
VITE_ICE_SERVERS=
```

## 本地开发

前置：
- Go 1.24+
- Node.js 18+
- Wails v2

### 1) 启动服务端

```bash
cd /Users/sui/Code/projects/QuicLink/src/server
go run .
```

说明：
- `use_https=true` 且证书不存在时会自动生成自签证书。
- 服务端静态目录是 `./dist`（生产部署时需把 web 构建产物放到与服务进程工作目录匹配的位置）。

### 2) 启动 Web

```bash
cd /Users/sui/Code/projects/QuicLink/src/web
npm install
npm run dev
```

### 3) 启动 Desktop

```bash
cd /Users/sui/Code/projects/QuicLink/src/desktop
wails dev
```

## 构建与部署

### 构建

```bash
cd /Users/sui/Code/projects/QuicLink/src/server && go build .
cd /Users/sui/Code/projects/QuicLink/src/web && npm run build
cd /Users/sui/Code/projects/QuicLink/src/desktop && go build ./...
cd /Users/sui/Code/projects/QuicLink/src/desktop && wails build
```

### Makefile 常用命令

```bash
cd /Users/sui/Code/projects/QuicLink
make build-server
make build-web
make deploy-vps VPS_HOST=<ip>
make start-vps VPS_HOST=<ip>
make stop-vps VPS_HOST=<ip>
```

## 常见问题（当前实现相关）

### 1) Mixed Content（HTTPS 页面请求 HTTP LAN）
- 浏览器会拦截 `https://...` 页面直接 `fetch(http://192.168.x.x...)`
- 已采用 URL 导航/新窗口接管的降级策略规避

### 2) `QUIC_TLS_CERTIFICATE_UNKNOWN`
- LAN WT 使用自签证书时，必须提供正确 `certificateHashes`
- 若浏览器/WebView 不支持该能力，会自动回退 HTTP/WebRTC/VPS relay

### 3) `webview_no_webtransport`
- 常见于部分嵌入式 WebView（尤其 Safari/WebKit 容器）
- 建议使用 `compat` 下载模式或桌面端 Go 原生路径

### 4) 速度低于预期
- 先看诊断栏 `通道/链路/uploadVia/速率/进度`
- 若显示 `LAN HTTP Relay`，通常受 WebView/浏览器能力限制
- 大文件更能体现 WT/原生通道优势，小文件容易被握手与调度开销掩盖

## 仓库结构

- `/Users/sui/Code/projects/QuicLink/src/server`：Go 服务端（信令 + API + HTTP/3 + WT）
- `/Users/sui/Code/projects/QuicLink/src/web`：Vue 3 + TS Web 客户端
- `/Users/sui/Code/projects/QuicLink/src/desktop`：Wails Desktop（Go + Vue）
- `/Users/sui/Code/projects/QuicLink/src/android`：Android Scaffold（Capacitor + Kotlin bridge + Go lanhost 占位）
- `/Users/sui/Code/projects/QuicLink/scripts`：部署脚本
- `/Users/sui/Code/projects/QuicLink/Makefile`：构建与部署快捷命令

## License

MIT
