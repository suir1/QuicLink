import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { isWails } from '../utils/wails'

export const useConnectionStore = defineStore('connection', () => {
    type TransferPath =
        | 'unknown'
        | 'lan-go-relay'
        | 'lan-wt-relay'
        | 'lan-http-relay'
        | 'lan-wt-direct'
        | 'lan-http-direct'
        | 'webrtc'
        | 'vps-relay'
        | 'browser-url'
        | 'cloud'
    type TransferStatus = 'idle' | 'active' | 'handoff' | 'done' | 'error'
    type TransferDirection = 'upload' | 'download'
    const LAN_WT_READY_TIMEOUT_MS = 8000
    const TRANSFER_UI_UPDATE_INTERVAL_MS = 80

    // --- 状态定义 ---
    const isConnected = ref(false)
    const transport = ref<any>(null) // WebTransport instance
    const streamWriter = ref<WritableStreamDefaultWriter | null>(null)

    // WebSocket Fallback (保留以防环境不支持 WT)
    const socket = ref<WebSocket | null>(null)

    const currentRoom = ref('')
    const serverMode = ref('public') // 'public' | 'private'
    const hostOnline = ref(false)    // C++ Host 是否在线
    const hostIp = ref('')           // C++ Host 的局域网 IP
    const certHash = ref('')         // 服务器证书指纹
    const isDesktop = ref(false)     // Is running in Wails Desktop environment
    const lanServerUrl = ref('')
    interface LanServerInfo {
        id: string
        name: string
        ip: string
        httpPort: number
        h3Port?: number
        certHash?: string
    }
    const lanServers = ref<Map<string, LanServerInfo>>(new Map())

    // 环境变量处理
    // 环境变量处理
    // 优先使用环境变量，否则使用当前浏览器地址栏的 Host (自动适配域名/IP)
    const VPS_HOST = import.meta.env.VITE_VPS_HOST || window.location.host

    // 协议判定 (Reactive Auto-Detection)
    const protocol = ref(window.location.protocol) // Default to current
    const PROTOCOL = computed(() => protocol.value)

    // Computed URLs based on detected protocol
    const HTTP_URL = computed(() => `${protocol.value}//${VPS_HOST}`)
    const WT_URL = computed(() => `https://${VPS_HOST}`) // WebTransport always requires HTTPS/QUIC

    // --- 回调函数钩子 ---
    const onClipboardData = ref<((data: any) => void) | null>(null)
    const onClipboardHistory = ref<((items: any[]) => void) | null>(null)
    const onClipboardDelete = ref<((id: number | string) => void) | null>(null) // New Callback
    const onNotepadEvent = ref<((type: string, data: any) => void) | null>(null)
    const onP2PEvent = ref<((type: string, data: any) => void) | null>(null)

    // P2P State
    const selfPeerId = `peer-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
    const localFiles = ref<Map<string, File>>(new Map())
    const relaySources = ref<Map<string, {
        name: string
        size: number
        type: string
        file?: File
        nativePath?: string
    }>>(new Map())
    const vpsRelayOffers = ref<Map<string, {
        relayId: string
        name: string
        size: number
        type: string
        url: string
        expiresAt?: number
    }>>(new Map())
    const receivingFiles = ref<Map<string, { chunks: string[], total: number, received: number, name: string, type: string }>>(new Map())
    const transferTelemetry = ref<{
        path: TransferPath
        status: TransferStatus
        direction: TransferDirection
        fileName: string
        uploadVia: string
        bytes: number
        total: number
        speedBps: number
        startedAt: number
        updatedAt: number
        note: string
    }>({
        path: 'unknown',
        status: 'idle',
        direction: 'download',
        fileName: '',
        uploadVia: '',
        bytes: 0,
        total: 0,
        speedBps: 0,
        startedAt: 0,
        updatedAt: 0,
        note: ''
    })
    const transferSession = ref<{
        id: string
        startedAt: number
        bytes: number
    } | null>(null)

    function startTransferTelemetry(
        path: TransferPath,
        direction: TransferDirection,
        fileName: string,
        total = 0,
        note = ''
    ): string {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const now = Date.now()
        transferSession.value = { id, startedAt: now, bytes: 0 }
        transferTelemetry.value = {
            path,
            status: 'active',
            direction,
            fileName,
            uploadVia: '',
            bytes: 0,
            total: total > 0 ? total : 0,
            speedBps: 0,
            startedAt: now,
            updatedAt: now,
            note
        }
        return id
    }

    function bumpTransferTelemetry(deltaBytes: number, total?: number) {
        const session = transferSession.value
        if (!session || deltaBytes <= 0) return

        session.bytes += deltaBytes
        const now = Date.now()
        const prev = transferTelemetry.value
        const reachedTotal = typeof total === 'number' && total > 0 && session.bytes >= total
        if (!reachedTotal && now - prev.updatedAt < TRANSFER_UI_UPDATE_INTERVAL_MS) {
            return
        }
        const elapsedSec = Math.max(0.001, (now - session.startedAt) / 1000)
        transferTelemetry.value = {
            ...prev,
            bytes: session.bytes,
            total: typeof total === 'number' && total > 0 ? total : prev.total,
            speedBps: session.bytes / elapsedSec,
            updatedAt: now
        }
    }

    function finishTransferTelemetry(status: Exclude<TransferStatus, 'idle' | 'active'>, note = '') {
        transferTelemetry.value = {
            ...transferTelemetry.value,
            status,
            updatedAt: Date.now(),
            note: note || transferTelemetry.value.note
        }
        transferSession.value = null
    }

    function setTransferUploadVia(via: string) {
        const normalized = String(via || '').trim().toLowerCase()
        transferTelemetry.value = {
            ...transferTelemetry.value,
            uploadVia: normalized,
            updatedAt: Date.now()
        }
    }

    function resetTransferTelemetry() {
        transferTelemetry.value = {
            path: transferTelemetry.value.path,
            status: 'idle',
            direction: transferTelemetry.value.direction,
            fileName: '',
            uploadVia: '',
            bytes: 0,
            total: 0,
            speedBps: 0,
            startedAt: 0,
            updatedAt: Date.now(),
            note: ''
        }
        transferSession.value = null
    }

    // --- Auto-Detect Protocol ---
    async function detectProtocol() {
        const testHosts = [
            { proto: 'https:', url: `https://${VPS_HOST}/api/info` },
            { proto: 'http:', url: `http://${VPS_HOST}/api/info` }
        ]

        console.log("🕵️ Probing server protocol...")
        for (const test of testHosts) {
            try {
                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), 2000)

                const res = await fetch(test.url, { method: 'HEAD', signal: controller.signal })
                clearTimeout(timeoutId)

                if (res.ok || res.status === 405) { // 405 Method Not Allowed is fine (server is reachable)
                    console.log(`✅ Detected Server Protocol: ${test.proto}`)
                    protocol.value = test.proto
                    return
                }
            } catch (e) {
                // Ignore and try next
            }
        }
        console.warn("⚠️ Protocol detection failed, keeping default:", protocol.value)
    }

    // --- 1. 检查服务器模式 ---
    async function checkMode() {
        // Desktop check: Skip frontend network probe which is unreliable in WebView
        if (isDesktop.value) {
            console.log('🖥️ Desktop mode: skipping protocol detection')
            serverMode.value = 'public'
            return 'public'
        }

        await detectProtocol() // Probe first

        try {
            const res = await fetch(`${HTTP_URL.value}/api/info`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)

            const data = await res.json()
            serverMode.value = data.mode
            if (data.certHash) {
                certHash.value = data.certHash
                console.log("🔒 Server Cert Hash:", data.certHash)
            }
            return data.mode
        } catch (e) {
            console.error("无法连接到服务器 API", e)
            throw e // 抛出异常供 UI 处理 (显示信任链接)
        }
    }

    // --- 2. 建立连接 (WebTransport 优先 -> WebSocket 降级) ---
    async function connect(roomId: string, password?: string) {
        closeConnection()
        currentRoom.value = roomId

        // 尝试 WebTransport
        if ('WebTransport' in window) {
            try {
                console.log(`🚀 Attempting WebTransport to [${roomId}]...`)
                let url = `${WT_URL.value}/wt?room=${roomId}`
                if (password) url += `&token=${password}`

                const options: any = {}
                if (certHash.value) {
                    // Base64 -> Uint8Array
                    const binaryString = atob(certHash.value)
                    const bytes = new Uint8Array(binaryString.length)
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i)
                    }

                    options.serverCertificateHashes = [{
                        algorithm: 'sha-256',
                        value: bytes
                    }]
                }

                const wt = new WebTransport(url, options)
                await wt.ready

                // 成功连接 WT
                transport.value = wt
                isConnected.value = true
                console.log('✅ WebTransport Ready')

                // 建立主控流
                const stream = await wt.createBidirectionalStream()
                streamWriter.value = stream.writable.getWriter()

                // 开始读取循环
                readLoop(stream.readable)

                // Send Hello only after control stream is ready
                sendMessage({ type: 'p2p_hello' })

                // 监听连接关闭
                wt.closed.then(() => {
                    console.log('WT Closed')
                    handleClose()
                }).catch((e: any) => {
                    console.error('WT Error:', e)
                    handleClose()
                })

                ElMessage.success(`✅ 已通过 HTTP/3 加入房间: ${roomId}`)
                return

            } catch (e) {
                console.warn("❌ WebTransport failed, falling back to WebSocket")
                console.error("WebTransport Error Details:", e)
                if (e instanceof Error) {
                    console.error("Error Name:", e.name, "| Message:", e.message)
                }
                ElMessage.warning("HTTP/3 连接失败，正在尝试降级 WebSocket...")
            }
        }

        // 降级：WebSocket
        connectWebSocket(roomId, password)
    }

    function connectWebSocket(roomId: string, password?: string) {
        let url = `${HTTP_URL.value.replace('http', 'ws')}/ws?room=${roomId}`
        if (password) url += `&token=${password}`

        console.log(`🔄 Attempting WebSocket to [${roomId}]...`)
        const ws = new WebSocket(url)
        socket.value = ws

        ws.onopen = () => {
            isConnected.value = true
            ElMessage.success(`✅ 已通过 WebSocket 加入房间: ${roomId}`)
            // Send Hello
            sendMessage({ type: 'p2p_hello' })
        }
        ws.onclose = () => handleClose()
        ws.onmessage = (e) => handleMessage(e.data)
    }

    function closeConnection() {
        if (transport.value) {
            transport.value.close()
            transport.value = null
            streamWriter.value = null
        }
        if (socket.value) {
            socket.value.close()
            socket.value = null
        }
        isConnected.value = false
    }

    function handleClose() {
        isConnected.value = false
        hostOnline.value = false
        resetTransferTelemetry()
    }

    // --- 3. 读取循环 (处理粘包/分包) ---
    async function readLoop(readable: ReadableStream) {
        const reader = readable.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break

                const chunk = decoder.decode(value, { stream: true })
                buffer += chunk

                // 处理换行符分隔的 JSON
                const lines = buffer.split('\n')
                // 只有最后一部分可能是不完整的，留给下次
                buffer = lines.pop() || ''

                for (const line of lines) {
                    if (line.trim()) handleMessage(line)
                }
            }
        } catch (e) {
            console.error("Reader Error", e)
        } finally {
            reader.releaseLock()
        }
    }

    // --- 4. 发送消息 ---
    async function sendMessage(data: any) {
        // Desktop Mode: Use Wails Bridge
        if (isDesktop.value) {
            // @ts-ignore
            if (window.go && window.go.main && window.go.main.App && window.go.main.App.SendGenericMessage) {
                // @ts-ignore
                window.go.main.App.SendGenericMessage(data.type, data.payload || {})
                return
            } else {
                console.warn('⚠️ Desktop mode detected but Wails SendGenericMessage not available')
            }
        }

        const jsonStr = JSON.stringify(data)

        // WebTransport 发送
        if (streamWriter.value) {
            try {
                const encoder = new TextEncoder()
                // Go 的 Decoder 需要换行符或者是完整的 JSON 对象流
                // 为了保险，我们加个换行符，虽然 Go 的 ReadJSON 可能不需要
                // 但如果是 Stream 模式，明确的分界符是好的
                // Go json.Decoder 能自动识别对象边界，但两个对象粘在一起可能需要空格/换行
                await streamWriter.value.write(encoder.encode(jsonStr + '\n'))
            } catch (e) {
                console.error("WT Send Failed", e)
            }
            return
        }

        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
            socket.value.send(jsonStr)
        }
    }

    // --- P2P Files Logic ---
    function shareFile(file: File) {
        const fileId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        localFiles.value.set(fileId, file)

        // Broadcast Offer
        sendMessage({
            type: 'file_offer',
            payload: {
                id: fileId,
                name: file.name,
                size: file.size,
                type: file.type
            }
        })
    }

    function getActiveLanServer(): LanServerInfo | null {
        if (lanServerUrl.value) {
            for (const s of lanServers.value.values()) {
                const url = `http://${s.ip}:${s.httpPort}`
                if (url === lanServerUrl.value) return s
            }
        }
        return Array.from(lanServers.value.values())[0] || null
    }

    async function getLocalServerPortNative(): Promise<number> {
        const w = window as any
        if (w.go && w.go.main && w.go.main.App && w.go.main.App.GetLocalServerPort) {
            return await w.go.main.App.GetLocalServerPort()
        }
        return 0
    }

    async function getLocalLanInfoNative(): Promise<{
        ip: string
        httpPort: number
        h3Port: number
        certHash: string
    } | null> {
        const w = window as any
        if (w.go && w.go.main && w.go.main.App && w.go.main.App.GetLocalLanInfo) {
            try {
                const info = await w.go.main.App.GetLocalLanInfo()
                return {
                    ip: info?.ip || '',
                    httpPort: Number(info?.httpPort || 0),
                    h3Port: Number(info?.h3Port || 0),
                    certHash: info?.certHash || ''
                }
            } catch (e) {
                console.error('GetLocalLanInfo failed', e)
            }
        }
        return null
    }

    function shareP2PRelayFile(file: File, nativePath?: string): string {
        const fileId = `p2p-relay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        relaySources.value.set(fileId, {
            name: file.name,
            size: file.size,
            type: file.type,
            file,
            nativePath: nativePath || undefined
        })
        sendMessage({
            type: 'p2p_relay_offer',
            payload: {
                id: fileId,
                name: file.name,
                size: file.size,
                type: file.type,
                isRelay: true,
                status: 'pending'
            }
        })
        return fileId
    }

    async function smartRelaySendFile(file: File, nativePath?: string) {
        shareP2PRelayFile(file, nativePath)
        ElMessage.success(`📡 已发布 LAN 中转任务: ${file.name}`)
    }

    async function smartRelaySendNativeFile(meta: {
        path: string
        name: string
        size: number
        type?: string
    }) {
        const fileId = `p2p-relay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        relaySources.value.set(fileId, {
            name: meta.name,
            size: Number(meta.size || 0),
            type: meta.type || 'application/octet-stream',
            nativePath: meta.path
        })
        sendMessage({
            type: 'p2p_relay_offer',
            payload: {
                id: fileId,
                name: meta.name,
                size: Number(meta.size || 0),
                type: meta.type || 'application/octet-stream',
                isRelay: true,
                status: 'pending'
            }
        })
        ElMessage.success(`📡 已发布 Go 原生中转任务: ${meta.name}`)
    }

    async function pickNativeRelayFiles(): Promise<Array<{
        path: string
        name: string
        size: number
        type?: string
    }>> {
        const w = window as any
        if (!(w.go && w.go.main && w.go.main.App && w.go.main.App.SelectRelayFiles)) {
            return []
        }
        try {
            const selected = await w.go.main.App.SelectRelayFiles()
            if (!Array.isArray(selected)) return []
            return selected
                .map((item: any) => ({
                    path: String(item?.path || ''),
                    name: String(item?.name || ''),
                    size: Number(item?.size || 0),
                    type: String(item?.type || 'application/octet-stream')
                }))
                .filter((item: any) => item.path && item.name && item.size >= 0)
        } catch (e) {
            console.error('SelectRelayFiles failed', e)
            return []
        }
    }

    async function startNativeRelayUpload(
        relayId: string,
        nativePath: string,
        fileName: string,
        fileSize: number
    ): Promise<void> {
        const w = window as any
        if (!(w.go && w.go.main && w.go.main.App && w.go.main.App.StartNativeRelayUpload)) {
            throw new Error('native relay api unavailable')
        }

        startTransferTelemetry('lan-go-relay', 'upload', fileName, fileSize, 'LAN Go native relay')
        await w.go.main.App.StartNativeRelayUpload(relayId, nativePath, fileName, false)
        finishTransferTelemetry('handoff', 'Go native relay started')
    }

    async function shareViaVpsRelayNative(
        nativePath: string,
        fileName: string,
        fileSize: number,
        fileType: string,
        originalId?: string
    ): Promise<string> {
        const w = window as any
        if (!(w.go && w.go.main && w.go.main.App && w.go.main.App.UploadVpsRelayFile)) {
            throw new Error('native vps relay api unavailable')
        }

        startTransferTelemetry('vps-relay', 'upload', fileName, fileSize, 'VPS Go native relay')
        try {
            const data = await w.go.main.App.UploadVpsRelayFile(nativePath)
            const relayId = String(data?.relayId || data?.id || '').trim()
            if (!relayId) {
                throw new Error('missing relay id')
            }
            const uploadVia = String(data?.uploadVia || '').trim().toLowerCase()
            if (uploadVia) {
                setTransferUploadVia(uploadVia)
            }
            const rawUrl = String(data?.url || data?.downloadUrl || '').trim()
            const absoluteUrl = rawUrl.startsWith('/')
                ? `${HTTP_URL.value}${rawUrl}`
                : rawUrl
            if (!absoluteUrl) {
                throw new Error('missing relay download url')
            }
            const expiresAt = Number(data?.expiresAt || 0) || undefined

            vpsRelayOffers.value.set(relayId, {
                relayId,
                name: fileName,
                size: fileSize,
                type: fileType || 'application/octet-stream',
                url: absoluteUrl,
                expiresAt
            })

            sendMessage({
                type: 'vps_relay_offer',
                payload: {
                    id: relayId,
                    relayId,
                    originalId,
                    name: fileName,
                    size: fileSize,
                    type: fileType || 'application/octet-stream',
                    url: absoluteUrl,
                    isVpsRelay: true,
                    expiresAt
                }
            })

            const viaNote = uploadVia ? ` (via ${uploadVia.toUpperCase()})` : ''
            finishTransferTelemetry('done', `VPS Go native relay${viaNote}`)
            return relayId
        } catch (e) {
            finishTransferTelemetry('error', 'VPS relay upload failed')
            throw e
        }
    }

    function requestP2PRelayFile(fileId: string) {
        sendMessage({
            type: 'p2p_relay_request',
            payload: { id: fileId, requesterId: selfPeerId }
        })
    }

    function removeSharedOffer(fileId: string) {
        const id = String(fileId || '').trim()
        if (!id) return
        localFiles.value.delete(id)
        relaySources.value.delete(id)
        vpsRelayOffers.value.delete(id)
    }

    async function uploadToLocalRelay(file: File, port: number, relayId: string, fallbackNote = '') {
        const note = fallbackNote
            ? `LAN HTTP relay (fallback: ${fallbackNote})`
            : 'LAN HTTP relay'
        startTransferTelemetry('lan-http-relay', 'upload', file.name, file.size, note)
        try {
            const url = `http://localhost:${port}/api/lan/relay/upload/${relayId}?name=${encodeURIComponent(file.name)}&persist=0`
            const res = await fetch(url, {
                method: 'POST',
                body: file
            })
            if (!res.ok) {
                finishTransferTelemetry('error', `HTTP ${res.status}`)
                throw new Error(`relay upload failed: ${res.status}`)
            }
            // Browser fetch upload has no per-chunk progress callback.
            bumpTransferTelemetry(file.size, file.size)
            finishTransferTelemetry('done')
        } catch (e) {
            finishTransferTelemetry('error', 'LAN HTTP relay upload failed')
            throw e
        }
    }

    async function readJsonResponse(
        reader: ReadableStreamDefaultReader<Uint8Array>
    ): Promise<any | null> {
        const decoder = new TextDecoder()
        let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))

        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value) continue

            buffer = appendBytes(buffer, toArrayBufferBytes(value))
            const nlIdx = buffer.indexOf(10) // '\n'
            if (nlIdx >= 0) {
                const line = decoder.decode(buffer.slice(0, nlIdx))
                return JSON.parse(line)
            }
        }

        if (buffer.length > 0) {
            return JSON.parse(decoder.decode(buffer))
        }
        return null
    }

    async function streamFileToWriter(
        file: File,
        writer: WritableStreamDefaultWriter<Uint8Array>,
        onChunk?: (deltaBytes: number) => void
    ): Promise<void> {
        const reader = file.stream().getReader()
        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (!value) continue
                const chunk = toArrayBufferBytes(value)
                await writer.write(chunk)
                if (onChunk) onChunk(chunk.byteLength)
            }
        } finally {
            reader.releaseLock()
        }
    }

    async function uploadToLocalRelayWT(
        file: File,
        hostIp: string | undefined,
        h3Port: number,
        certHashValue: string,
        relayId: string,
        onReady?: () => void,
        readyTimeoutMs = 8000
    ) {
        startTransferTelemetry('lan-wt-relay', 'upload', file.name, file.size, 'LAN WT relay')
        let wt: any = null
        try {
            const targets = Array.from(new Set(
                ['localhost', hostIp || '', '127.0.0.1']
                    .map(v => (v || '').trim())
                    .filter(Boolean)
            ))
            let connectedTarget = ''
            let lastErr: any = null
            for (const target of targets) {
                try {
                    wt = await createLanWTByAddress(target, h3Port, certHashValue)
                    connectedTarget = target
                    break
                } catch (e) {
                    lastErr = e
                }
            }
            if (!wt) {
                const reason = lastErr instanceof Error ? lastErr.message : String(lastErr || 'wt_connect_failed')
                throw new Error(`WT connect failed (${targets.join(',')}): ${reason}`)
            }
            console.log(`✅ Local WT relay connected via ${connectedTarget}:${h3Port}`)

            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            const cmd = JSON.stringify({
                action: 'relay_upload',
                relayId,
                name: file.name,
                size: file.size,
                persist: false
            }) + '\n'
            await writer.write(new TextEncoder().encode(cmd))

            let readyTimer: any = null
            const readyResp = await Promise.race([
                readJsonResponse(reader),
                new Promise((_, reject) => {
                    readyTimer = setTimeout(() => reject(new Error('WT relay ready timeout')), readyTimeoutMs)
                })
            ]).finally(() => {
                if (readyTimer) clearTimeout(readyTimer)
            }) as any

            if (readyResp?.error) {
                finishTransferTelemetry('error', readyResp.error || 'WT relay ready failed')
                throw new Error(readyResp.error)
            }
            if (!readyResp || readyResp.status !== 'ready') {
                finishTransferTelemetry('error', 'WT relay ready missing')
                throw new Error('WT relay ready response missing')
            }
            if (onReady) onReady()

            await streamFileToWriter(file, writer, (bytes) => bumpTransferTelemetry(bytes, file.size))
            await writer.close()
            finishTransferTelemetry('done')
        } catch (e) {
            finishTransferTelemetry('error', 'LAN WT relay upload failed')
            throw e
        } finally {
            try {
                wt?.close?.()
            } catch {
                // ignore close errors
            }
        }
    }

    async function handleP2PRelayRequest(fileId: string, requesterId?: string) {
        const source = relaySources.value.get(fileId)
        if (!source) return

        const localInfo = await getLocalLanInfoNative()
        const port = localInfo?.httpPort || await getLocalServerPortNative()
        if (!port) {
            if (source.nativePath) {
                try {
                    await shareViaVpsRelayNative(
                        source.nativePath,
                        source.name,
                        source.size,
                        source.type,
                        fileId
                    )
                    ElMessage.warning(`LAN 中转不可用，已切换 VPS 中转: ${source.name}`)
                    return
                } catch (e) {
                    console.error('VPS relay fallback failed', e)
                }
            }
            if (source.file) {
                // Fallback to existing signaling relay when local LAN server is unavailable.
                shareFile(source.file)
                ElMessage.warning(`LAN 中转不可用，已切换普通中转: ${source.name}`)
                return
            }
            ElMessage.error(`LAN 中转不可用，且当前文件仅支持原生中转: ${source.name}`)
            return
        }

        const relayId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        let readySent = false
        const sendRelayReady = () => {
            if (readySent) return
            readySent = true
            sendMessage({
                type: 'p2p_relay_ready',
                payload: {
                    originalId: fileId,
                    lanFileId: relayId,
                    name: source.name,
                    size: source.size,
                    ip: localInfo?.ip || getActiveLanServer()?.ip,
                    httpPort: port,
                    h3Port: localInfo?.h3Port,
                    certHash: localInfo?.certHash,
                    isRelay: true,
                    status: 'ready',
                    from: selfPeerId,
                    to: requesterId
                }
            })
        }

        if (source.nativePath) {
            try {
                await startNativeRelayUpload(relayId, source.nativePath, source.name, source.size)
                sendRelayReady()
                return
            } catch (e) {
                console.warn('Go native relay upload failed, fallback to JS relay', e)
                if (!source.file) {
                    try {
                        await shareViaVpsRelayNative(
                            source.nativePath,
                            source.name,
                            source.size,
                            source.type,
                            fileId
                        )
                        ElMessage.warning(`LAN 中转失败，已切换 VPS 中转: ${source.name}`)
                        return
                    } catch (vpsErr) {
                        console.error('VPS relay fallback failed', vpsErr)
                    }
                }
            }
        }

        const file = source.file
        if (!file) {
            ElMessage.error(`无法读取文件数据: ${source.name}`)
            return
        }

        let wtFallbackReason = ''
        if (localInfo?.h3Port && localInfo?.certHash && 'WebTransport' in window) {
            try {
                await uploadToLocalRelayWT(file, localInfo.ip, localInfo.h3Port, localInfo.certHash, relayId, sendRelayReady, 8000)
                sendRelayReady()
                return
            } catch (e) {
                console.warn('Local WT relay upload failed, fallback to localhost HTTP relay', e)
                wtFallbackReason = e instanceof Error ? e.message : String(e || 'wt_failed')
            }
        } else if (!('WebTransport' in window)) {
            console.warn('Local WT relay skipped: window.WebTransport unavailable in desktop webview')
            wtFallbackReason = 'webview_no_webtransport'
        }

        uploadToLocalRelay(file, port, relayId, wtFallbackReason).catch((e) => {
            console.error('Local relay upload aborted', e)
            shareFile(file)
            ElMessage.warning(`LAN 中转失败，已切换普通中转: ${source.name}`)
        })
        sendRelayReady()
    }

    async function requestFile(fileId: string) {
        // Send Request
        sendMessage({
            type: 'file_request',
            payload: { id: fileId }
        })
    }

    // Send chunks when requested
    async function handleFileRequest(fileId: string) {
        const file = localFiles.value.get(fileId)
        if (!file) return

        const CHUNK_SIZE = 16 * 1024 // 16KB chunks to be safe with WebSocket frames
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

        // Read and send
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE
            const end = Math.min(start + CHUNK_SIZE, file.size)
            const slice = file.slice(start, end)

            const buffer = await slice.arrayBuffer()
            // Convert to Base64
            const base64 = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''))

            sendMessage({
                type: 'file_chunk',
                payload: {
                    id: fileId,
                    index: i,
                    total: totalChunks,
                    data: base64
                }
            })

            // Tiny delay to prevent flooding
            if (i % 10 === 0) await new Promise(r => setTimeout(r, 5))
        }

        console.log(`✅ File [${file.name}] sent complete.`)
    }

    function handleFileChunk(payload: any) {
        const { id, index, total, data } = payload

        if (!receivingFiles.value.has(id)) {
            // New download
            receivingFiles.value.set(id, {
                chunks: new Array(total),
                total: total,
                received: 0,
                name: 'downloading', // info should come from offer context ideally, but we might miss it
                type: 'application/octet-stream'
            })
        }

        const transfer = receivingFiles.value.get(id)!
        transfer.chunks[index] = data
        transfer.received++

        // Check complete
        if (transfer.received === transfer.total) {
            // Reconstruct
            const byteCharacters = transfer.chunks.map(chunk => atob(chunk)).join('')
            const byteNumbers = new Array(byteCharacters.length)
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i)
            }
            const byteArray = new Uint8Array(byteNumbers)
            const blob = new Blob([byteArray]) // Mime type lost here if not passed, but browser handles it

            // Trigger download
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = transfer.name || `file-${id}`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)

            receivingFiles.value.delete(id)
            ElMessage.success('文件接收完成')
        }
    }

    // --- 5. 消息处理 (复用逻辑) ---
    function handleMessage(jsonStr: string) {
        try {
            const msg = JSON.parse(jsonStr)

            switch (msg.type) {
                case 'init':
                case 'register_host':
                    const info = msg.type === 'init' ? msg.payload.hostInfo : msg.payload
                    if (info) {
                        hostOnline.value = true
                        hostIp.value = info.ip
                        if (msg.type === 'register_host') ElMessage.success(`主机 [${info.ip}] 上线`)
                    }
                    if (msg.type === 'init') {
                        if (msg.payload.notes && onNotepadEvent.value) {
                            onNotepadEvent.value('init', msg.payload.notes)
                        }
                        if (msg.payload.clipboardHistory && onClipboardHistory.value) {
                            console.log('📜 Init: History received', msg.payload.clipboardHistory)
                            onClipboardHistory.value(msg.payload.clipboardHistory)
                        } else {
                            console.log('📜 Init: No history in payload', msg.payload)
                        }
                    }
                    break

                case 'notepad_update':
                case 'notepad_delete':
                    console.log(`📝 Store handling ${msg.type}`, msg.payload)
                    if (onNotepadEvent.value) {
                        onNotepadEvent.value(msg.type, msg.payload)
                    } else {
                        console.warn('⚠️ No notepad event handler registered!')
                    }
                    break

                case 'clipboard_data':
                case 'clipboard_push': // 接收其它端的剪切板推送
                    if (msg.payload && onClipboardData.value) {
                        // Keep full payload so UI can preserve id/time/type.
                        onClipboardData.value(msg.payload)
                    }
                    break

                case 'clipboard_delete':
                    console.log('🔄 Store: Received clipboard_delete message', msg.payload)
                    if (msg.payload && msg.payload.id && onClipboardDelete.value) {
                        onClipboardDelete.value(msg.payload.id)
                    } else {
                        console.warn('⚠️ Store: clipboard_delete missing ID or handler not set', {
                            payload: msg.payload,
                            handlerSet: !!onClipboardDelete.value
                        })
                    }
                    break

                case 'offer':
                case 'answer':
                case 'candidate':
                    // WebRTC 信令，暂不处理或交给专用的 store
                    break

                // --- P2P File Handling ---
                case 'file_offer':
                    if (onP2PEvent.value) onP2PEvent.value('offer', msg.payload)
                    break

                case 'netdisk_file':
                    if (onP2PEvent.value) onP2PEvent.value('offer', {
                        ...msg.payload,
                        isNetdisk: true
                    })
                    break

                case 'p2p_hello':
                    console.log('👋 Received p2p_hello from new peer')
                    // A new peer joined. Re-broadcast my files.
                    // Loop localFiles and send offer
                    if (localFiles.value.size > 0) {
                        console.log(`📡 Re-broadcasting ${localFiles.value.size} file offers...`)
                        for (const [id, file] of localFiles.value) {
                            sendMessage({
                                type: 'file_offer',
                                payload: {
                                    id: id,
                                    name: file.name,
                                    size: file.size,
                                    type: file.type
                                }
                            })
                        }
                    } else {
                        console.log('No local files to share.')
                    }

                    if (relaySources.value.size > 0) {
                        console.log(`📡 Re-broadcasting ${relaySources.value.size} relay offers...`)
                        for (const [id, relay] of relaySources.value) {
                            sendMessage({
                                type: 'p2p_relay_offer',
                                payload: {
                                    id,
                                    name: relay.name,
                                    size: relay.size,
                                    type: relay.type,
                                    isRelay: true,
                                    status: 'pending'
                                }
                            })
                        }
                    }
                    if (vpsRelayOffers.value.size > 0) {
                        console.log(`📡 Re-broadcasting ${vpsRelayOffers.value.size} VPS relay offers...`)
                        for (const offer of vpsRelayOffers.value.values()) {
                            sendMessage({
                                type: 'vps_relay_offer',
                                payload: {
                                    id: offer.relayId,
                                    relayId: offer.relayId,
                                    name: offer.name,
                                    size: offer.size,
                                    type: offer.type,
                                    url: offer.url,
                                    isVpsRelay: true,
                                    expiresAt: offer.expiresAt
                                }
                            })
                        }
                    }
                    break

                case 'file_request':
                    handleFileRequest(msg.payload.id)
                    break

                case 'file_chunk':
                    handleFileChunk(msg.payload)
                    // Update progress UI if needed via onP2PEvent
                    if (onP2PEvent.value) onP2PEvent.value('progress', {
                        id: msg.payload.id,
                        received: receivingFiles.value.get(msg.payload.id)?.received || 0,
                        total: msg.payload.total
                    })
                    break

                // --- LAN Signaling (Desktop acts as LAN server) ---
                case 'lan_info':
                    if (msg.payload && msg.payload.ip && (msg.payload.httpPort || msg.payload.port)) {
                        const id = msg.payload.id || `${msg.payload.ip}`
                        const name = msg.payload.name || msg.payload.host || msg.payload.ip
                        const httpPort = msg.payload.httpPort || msg.payload.port
                        const h3Port = msg.payload.h3Port
                        const certHashVal = msg.payload.certHash
                        const lanInfo: LanServerInfo = {
                            id,
                            name,
                            ip: msg.payload.ip,
                            httpPort,
                            h3Port,
                            certHash: certHashVal
                        }
                        lanServers.value.set(id, lanInfo)
                        if (!lanServerUrl.value) {
                            lanServerUrl.value = `http://${msg.payload.ip}:${httpPort}`
                        }
                    }
                    break

                case 'lan_list_request':
                    // Web client wants our file list - fetch from localhost and relay back
                    handleLanListRequest()
                    break

                case 'lan_file_offer':
                    // Another client shared a file (lazy, metadata only)
                    if (onP2PEvent.value) onP2PEvent.value('lan_offer', msg.payload)
                    break

                case 'lan_file_request':
                    // Another client wants a file we shared - handled if we have it
                    break

                case 'lan_file_ready':
                    // File uploaded to our LAN server, ready for download
                    if (onP2PEvent.value) onP2PEvent.value('lan_ready', msg.payload)
                    break

                case 'p2p_relay_offer':
                    if (onP2PEvent.value) {
                        onP2PEvent.value('offer', {
                            ...msg.payload,
                            isRelay: true,
                            isLan: true,
                            status: msg.payload?.status || 'pending'
                        })
                    }
                    break

                case 'vps_relay_offer':
                    if (onP2PEvent.value) {
                        onP2PEvent.value('offer', {
                            ...msg.payload,
                            isVpsRelay: true
                        })
                    }
                    break

                case 'vps_relay_ack':
                    if (msg.payload?.relayId) {
                        vpsRelayOffers.value.delete(msg.payload.relayId)
                        if (onP2PEvent.value) {
                            onP2PEvent.value('relay_ack', msg.payload)
                        }
                    }
                    break

                case 'p2p_relay_request':
                    handleP2PRelayRequest(msg.payload.id, msg.payload.requesterId || msg.payload.from)
                    break

                case 'p2p_relay_ready':
                    if (msg.payload?.to && msg.payload.to !== selfPeerId) break
                    if (onP2PEvent.value) onP2PEvent.value('relay_ready', msg.payload)
                    break
            }
        } catch (e) {
            console.error("消息解析失败", e, jsonStr)
        }
    }

    // --- LAN List Relay (Desktop fetches from its own localhost and relays via VPS) ---
    async function handleLanListRequest() {
        try {
            const w = window as any
            let port = 0
            if (w.go && w.go.main && w.go.main.App) {
                port = await w.go.main.App.GetLocalServerPort()
            }
            if (!port) {
                console.warn('LAN server port not available')
                return
            }

            const res = await fetch(`http://localhost:${port}/api/lan/files`)
            if (res.ok) {
                const files = await res.json()
                sendMessage({
                    type: 'lan_list_response',
                    payload: { files }
                })
                console.log(`📂 Relayed ${files.length} files to room`)
            }
        } catch (e) {
            console.error('Failed to handle lan_list_request', e)
        }
    }

    function decodeCertHashBase64(certHashValue: string): Uint8Array<ArrayBuffer> {
        const raw = atob(certHashValue)
        const temp = Uint8Array.from(raw, c => c.charCodeAt(0))
        if (temp.byteLength !== 32) {
            throw new Error(`invalid cert hash length: ${temp.byteLength}`)
        }
        const bytes = new Uint8Array(new ArrayBuffer(temp.byteLength))
        bytes.set(temp)
        return bytes
    }

    function appendBytes(
        a: Uint8Array<ArrayBuffer>,
        b: Uint8Array<ArrayBuffer>
    ): Uint8Array<ArrayBuffer> {
        const out = new Uint8Array(new ArrayBuffer(a.length + b.length))
        out.set(a, 0)
        out.set(b, a.length)
        return out
    }

    function toArrayBufferBytes(input: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
        const out = new Uint8Array(new ArrayBuffer(input.byteLength))
        out.set(input)
        return out
    }

    async function createLanWTByAddress(ip: string, h3Port: number, certHashValue: string): Promise<any> {
        const hashBytes = decodeCertHashBase64(certHashValue)
        const wt = new WebTransport(`https://${ip}:${h3Port}/wt`, {
            serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes.buffer }]
        })
        await waitWTReady(wt, `https://${ip}:${h3Port}/wt`)
        return wt
    }

    async function waitWTReady(wt: any, url: string, timeoutMs = LAN_WT_READY_TIMEOUT_MS): Promise<void> {
        let timer: number | undefined
        try {
            await Promise.race([
                wt.ready,
                new Promise((_, reject) => {
                    timer = window.setTimeout(() => reject(new Error(`WT ready timeout (${timeoutMs}ms): ${url}`)), timeoutMs)
                })
            ])
        } catch (e) {
            try {
                wt.close?.()
            } catch {
                // ignore close errors
            }
            throw e
        } finally {
            if (timer) window.clearTimeout(timer)
        }
    }

    async function saveWTDownloadToFile(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        fallbackName: string,
        onChunk?: (deltaBytes: number) => void
    ): Promise<boolean> {
        const chunks: BlobPart[] = []
        let metaReceived = false
        let name = fallbackName
        let metaBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))
        let streamSaver: any = null

        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value) continue
            const chunk = toArrayBufferBytes(value)

            if (!metaReceived) {
                metaBuffer = appendBytes(metaBuffer, chunk)
                const nlIdx = metaBuffer.indexOf(10) // '\n'
                if (nlIdx < 0) continue

                try {
                    const metaLine = new TextDecoder().decode(metaBuffer.slice(0, nlIdx))
                    const meta = JSON.parse(metaLine)
                    if (meta.error) return false
                    name = meta.name || name

                    const anyWindow = window as any
                    if (typeof anyWindow.showSaveFilePicker === 'function') {
                        try {
                            const handle = await anyWindow.showSaveFilePicker({
                                suggestedName: name
                            })
                            streamSaver = await handle.createWritable()
                        } catch (e) {
                            console.warn('WT save picker unavailable/canceled, fallback to blob', e)
                        }
                    }

                    const rest = metaBuffer.slice(nlIdx + 1)
                    if (rest.length > 0) {
                        if (streamSaver) await streamSaver.write(rest)
                        else chunks.push(rest)
                        if (onChunk) onChunk(rest.byteLength)
                    }

                    metaReceived = true
                    metaBuffer = new Uint8Array(new ArrayBuffer(0))
                } catch (e) {
                    console.error('WT download metadata parse failed', e)
                    return false
                }
            } else {
                if (streamSaver) await streamSaver.write(chunk)
                else chunks.push(chunk)
                if (onChunk) onChunk(chunk.byteLength)
            }
        }

        if (!metaReceived) return false

        if (streamSaver) {
            await streamSaver.close()
            return true
        }

        const blob = new Blob(chunks)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = name
        a.click()
        URL.revokeObjectURL(a.href)
        return true
    }

    async function downloadLanRelayWT(
        relayId: string,
        fileName: string,
        ip?: string,
        h3Port?: number,
        certHashValue?: string
    ): Promise<boolean> {
        const server = getActiveLanServer()
        const targetIp = ip || server?.ip
        const targetH3Port = h3Port || server?.h3Port
        const targetCertHash = certHashValue || server?.certHash
        if (!targetIp || !targetH3Port || !targetCertHash) return false

        let wt: any = null
        try {
            startTransferTelemetry('lan-wt-relay', 'download', fileName, 0, 'LAN WT relay')
            wt = await createLanWTByAddress(targetIp, targetH3Port, targetCertHash)
            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            await writer.write(new TextEncoder().encode(
                JSON.stringify({ action: 'relay_download', relayId }) + '\n'
            ))
            await writer.close()

            const ok = await saveWTDownloadToFile(reader, fileName, (bytes) => bumpTransferTelemetry(bytes))
            finishTransferTelemetry(ok ? 'done' : 'error', ok ? '' : 'WT relay download failed')
            return ok
        } catch (e) {
            console.error('WT relay download failed', e)
            finishTransferTelemetry('error', 'WT relay download failed')
            return false
        } finally {
            try {
                wt?.close?.()
            } catch {
                // ignore close errors
            }
        }
    }

    async function downloadLanRelayNative(
        relayId: string,
        fileName: string,
        ip?: string,
        httpPort?: number
    ): Promise<boolean> {
        const w = window as any
        if (!(w.go && w.go.main && w.go.main.App && w.go.main.App.DownloadLanRelayFile)) return false

        const server = getActiveLanServer()
        const targetIp = ip || server?.ip
        const targetPort = httpPort || server?.httpPort
        if (!targetIp || !targetPort) return false

        try {
            startTransferTelemetry('lan-go-relay', 'download', fileName, 0, 'LAN Go native relay')
            const savePath = await w.go.main.App.DownloadLanRelayFile(relayId, fileName, targetIp, targetPort)
            finishTransferTelemetry('done', savePath ? `saved: ${savePath}` : 'saved')
            return true
        } catch (e) {
            console.error('Go native relay download failed', e)
            finishTransferTelemetry('error', 'Go native relay download failed')
            return false
        }
    }

    function downloadLanRelayHTTP(
        relayId: string,
        fileName: string,
        ip?: string,
        httpPort?: number
    ): boolean {
        const server = getActiveLanServer()
        const targetIp = ip || server?.ip
        const targetPort = httpPort || server?.httpPort
        if (!targetIp || !targetPort) return false
        startTransferTelemetry('browser-url', 'download', fileName, 0, 'Browser download manager')
        finishTransferTelemetry('handoff', 'URL handoff: LAN HTTP relay')
        window.open(`http://${targetIp}:${targetPort}/api/lan/relay/download/${relayId}`, '_blank')
        return true
    }

    // --- Desktop Specific Methods ---
    function setupDesktopEventListeners() {
        if (!isDesktop.value) return

        // @ts-ignore
        if (window.runtime) {
            // @ts-ignore
            window.runtime.EventsOn('clipboard:history', (history: any[]) => {
                console.log('🖥️ Desktop: Clipboard history received', history)
                if (onClipboardHistory.value) onClipboardHistory.value(history)
            })

            // @ts-ignore
            window.runtime.EventsOn('clipboard:remote', (payload: any) => {
                // console.log('🖥️ Desktop: Remote clipboard received', payload)
                if (onClipboardData.value) onClipboardData.value(payload)
            })

            // @ts-ignore
            window.runtime.EventsOn('p2p:message', (msg: any) => {
                // console.log('🖥️ Desktop: Message received', msg)
                // Forward to handleMessage
                if (msg && msg.type) {
                    // Wails might pass object directly, handleMessage expects JSON string usually?
                    // Let's check handleMessage. It parses JSON. So we might need to stringify or adjust handleMessage.
                    // The Web handleMessage expects string.
                    // But let's check if we can reuse handleMessage logic.
                    // Actually, if msg is object, we can just call the logic directly or stringify.
                    handleMessage(JSON.stringify(msg))
                }
            })
        }
    }

    async function connectDesktop(host: string, roomId: string, password?: string) {
        currentRoom.value = roomId
        isDesktop.value = true
        // isConnected.value = true // Don't set true immediately

        // @ts-ignore
        if (window.go && window.go.main && window.go.main.App) {
            try {
                // Sanitize host: remove http:// or https://
                const cleanHost = host.replace(/^https?:\/\//, '')
                ElMessage.info(`Connecting to ${cleanHost}...`)

                // @ts-ignore
                await window.go.main.App.Connect(cleanHost, roomId, password || "")
                isConnected.value = true
                ElMessage.success(`✅ Connected to ${roomId}`)
            } catch (e) {
                console.error("Desktop Connect Failed:", e)
                ElMessage.error(`连接失败: ${e}`)
                isConnected.value = false
            }
        }
    }

    // Initialize isDesktop
    if (isWails()) {
        isDesktop.value = true
    }

    return {
        isConnected,
        isDesktop,
        transport, // Export for UI state check
        currentRoom,
        serverMode,
        hostOnline,
        hostIp,
        checkMode,
        connect,
        sendMessage,
        onClipboardData,
        onClipboardHistory,
        onClipboardDelete, // Export new callback
        onNotepadEvent,
        onP2PEvent,
        shareFile,
        smartRelaySendFile,
        smartRelaySendNativeFile,
        pickNativeRelayFiles,
        requestP2PRelayFile,
        removeSharedOffer,
        requestFile,
        lanServerUrl,
        lanServers,
        getActiveLanServer,
        downloadLanRelayWT,
        downloadLanRelayNative,
        downloadLanRelayHTTP,
        HTTP_URL,
        transferTelemetry,
        // Desktop Exports
        setupDesktopEventListeners,
        connectDesktop,
        disconnect: closeConnection
    }
})
