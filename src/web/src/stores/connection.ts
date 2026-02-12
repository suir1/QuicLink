import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useConnectionStore = defineStore('connection', () => {
    type DownloadMode = 'compat' | 'speed'
    type TransferPath =
        | 'unknown'
        | 'webrtc'
        | 'lan-wt-relay'
        | 'lan-http-relay'
        | 'lan-wt-direct'
        | 'lan-http-direct'
        | 'vps-relay'
        | 'browser-url'
        | 'cloud'
    type TransferStatus = 'idle' | 'active' | 'handoff' | 'done' | 'error'
    type TransferDirection = 'upload' | 'download'
    const DOWNLOAD_MODE_KEY = 'ql_web_download_mode'

    // --- 状态定义 ---
    const isConnected = ref(false)
    const isDesktop = ref(!!(window as any).runtime) // Detect Wails
    const transport = ref<any>(null) // WebTransport instance
    const streamWriter = ref<WritableStreamDefaultWriter | null>(null)

    // WebSocket Fallback (保留以防环境不支持 WT)
    const socket = ref<WebSocket | null>(null)

    const currentRoom = ref('')
    const serverMode = ref('public') // 'public' | 'private'
    const hostOnline = ref(false)    // C++ Host 是否在线
    const hostIp = ref('')           // C++ Host 的局域网 IP
    const certHash = ref('')         // 服务器证书指纹
    const lanServerUrl = ref('')     // Active Desktop LAN Server URL (HTTP fallback)
    // Map<id, LanServerInfo>
    interface LanServerInfo {
        id: string
        name: string
        ip: string
        httpPort: number
        h3Port?: number
        certHash?: string
    }
    const lanServers = ref<Map<string, LanServerInfo>>(new Map())
    const downloadMode = ref<DownloadMode>(
        (localStorage.getItem(DOWNLOAD_MODE_KEY) === 'speed' ? 'speed' : 'compat')
    )

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
    const pendingNotepadInit = ref<any[] | null>(null)
    const pendingNotepadEvents = ref<Array<{ type: string, payload: any }>>([])
    const MAX_PENDING_NOTEPAD_EVENTS = 100
    const onP2PEvent = ref<((type: string, data: any) => void) | null>(null)
    const onLanEvent = ref<((type: string, data: any) => void) | null>(null)

    function dispatchNotepadEvent(type: string, payload: any) {
        if (onNotepadEvent.value) {
            onNotepadEvent.value(type, payload)
            return
        }

        if (type === 'init') {
            pendingNotepadInit.value = Array.isArray(payload) ? payload : []
            pendingNotepadEvents.value = []
            return
        }

        pendingNotepadEvents.value.push({ type, payload })
        if (pendingNotepadEvents.value.length > MAX_PENDING_NOTEPAD_EVENTS) {
            pendingNotepadEvents.value.shift()
        }
    }

    function replayPendingNotepadEvents() {
        if (!onNotepadEvent.value) return

        if (pendingNotepadInit.value) {
            onNotepadEvent.value('init', pendingNotepadInit.value)
            pendingNotepadInit.value = null
        }

        if (pendingNotepadEvents.value.length === 0) return

        const buffered = [...pendingNotepadEvents.value]
        pendingNotepadEvents.value = []
        for (const evt of buffered) {
            onNotepadEvent.value(evt.type, evt.payload)
        }
    }

    // P2P State
    const localFiles = ref<Map<string, File>>(new Map())
    const vpsRelayOffers = ref<Map<string, {
        relayId: string
        name: string
        size: number
        type: string
        url: string
        expiresAt?: number
    }>>(new Map())
    const receivingFiles = ref<Map<string, { chunks: string[], total: number, received: number, name: string, type: string }>>(new Map())

    // WebRTC State
    const selfPeerId = `peer-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
    const knownPeers = ref<Set<string>>(new Set())
    const peerConnections = ref<Map<string, RTCPeerConnection>>(new Map())
    const dataChannels = ref<Map<string, RTCDataChannel>>(new Map())
    const isP2PConnected = ref(false)
    const pendingIceCandidates = ref<Map<string, RTCIceCandidateInit[]>>(new Map())
    const incomingFilesById = ref<Map<string, {
        id: string
        name: string
        size: number
        received: number
        buffer: BlobPart[]
    }>>(new Map())
    const activeIncomingFileByPeer = ref<Map<string, string>>(new Map())
    const DEFAULT_RELAY_MAX_SIZE_BYTES = 10 * 1024 * 1024
    const relayMaxSizeBytes = ref(DEFAULT_RELAY_MAX_SIZE_BYTES)
    const applyingAnswers = ref<Set<string>>(new Set())
    const makingOffers = ref<Set<string>>(new Set())
    const forceRelayPeers = ref<Set<string>>(new Set())
    const peerRetryAttempts = ref<Map<string, number>>(new Map())
    const peerLastRetryAt = ref<Map<string, number>>(new Map())
    const peerRetryTimers = ref<Map<string, number>>(new Map())
    const P2P_CHUNK_SIZE = 64 * 1024
    const P2P_MAX_BUFFERED_BYTES = 4 * 1024 * 1024
    const P2P_BUFFER_POLL_MS = 8
    const P2P_BUFFER_LOW_THRESHOLD = 1 * 1024 * 1024
    const P2P_MAX_RETRY_ATTEMPTS = 2
    const P2P_RETRY_DEBOUNCE_MS = 1500
    const P2P_DISCONNECTED_GRACE_MS = 1200
    const LAN_WT_READY_TIMEOUT_MS = 8000
    const WT_WRITE_BATCH_BYTES = 512 * 1024
    const TRANSFER_UI_UPDATE_INTERVAL_MS = 80
    const transferTelemetry = ref<{
        path: TransferPath
        status: TransferStatus
        direction: TransferDirection
        fileName: string
        route: string
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
        route: '',
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
            route: '',
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
        if (!reachedTotal && now-prev.updatedAt < TRANSFER_UI_UPDATE_INTERVAL_MS) {
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

    function setTransferRoute(route: string) {
        transferTelemetry.value = {
            ...transferTelemetry.value,
            route: String(route || '').trim(),
            updatedAt: Date.now()
        }
    }

    function resetTransferTelemetry() {
        transferTelemetry.value = {
            path: transferTelemetry.value.path,
            status: 'idle',
            direction: transferTelemetry.value.direction,
            fileName: '',
            route: '',
            bytes: 0,
            total: 0,
            speedBps: 0,
            startedAt: 0,
            updatedAt: Date.now(),
            note: ''
        }
        transferSession.value = null
    }

    function getRelayMaxSizeMb(): number {
        return Math.max(1, Math.floor(relayMaxSizeBytes.value / 1024 / 1024))
    }

    function isRelaySizeAllowed(size: number): boolean {
        return Number.isFinite(size) && size <= relayMaxSizeBytes.value
    }

    function parseIceServersFromEnv(): RTCIceServer[] {
        const defaults: RTCIceServer[] = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ]

        const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined
        const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined
        const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined
        if (turnUrl && turnUsername && turnCredential) {
            defaults.push({
                urls: turnUrl,
                username: turnUsername,
                credential: turnCredential
            })
        }

        const rawIceServers = import.meta.env.VITE_ICE_SERVERS as string | undefined
        if (!rawIceServers) {
            return defaults
        }

        try {
            const parsed = JSON.parse(rawIceServers)
            if (Array.isArray(parsed)) {
                return [...defaults, ...parsed]
            }
            if (parsed && typeof parsed === 'object') {
                return [...defaults, parsed]
            }
        } catch (e) {
            console.warn('Invalid VITE_ICE_SERVERS, using defaults only', e)
        }

        return defaults
    }

    function getIceServerUrls(server: RTCIceServer): string[] {
        const urls = server.urls
        if (Array.isArray(urls)) return urls.map((v) => String(v || ''))
        return [String(urls || '')]
    }

    function hasTurnServer(iceServers: RTCIceServer[]): boolean {
        return iceServers.some((server) =>
            getIceServerUrls(server).some((url) => {
                const normalized = url.trim().toLowerCase()
                return normalized.startsWith('turn:') || normalized.startsWith('turns:')
            })
        )
    }

    function shouldPreferRelayByNetwork(): boolean {
        const nav = navigator as any
        const net = nav?.connection || nav?.mozConnection || nav?.webkitConnection
        if (!net) return false

        const effectiveType = String(net.effectiveType || '').toLowerCase()
        const connectionType = String(net.type || '').toLowerCase()
        const saveData = !!net.saveData

        return (
            saveData ||
            connectionType === 'cellular' ||
            effectiveType === 'slow-2g' ||
            effectiveType === '2g' ||
            effectiveType === '3g'
        )
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
            if (Number.isFinite(data?.maxUploadSizeBytes) && data.maxUploadSizeBytes > 0) {
                relayMaxSizeBytes.value = Number(data.maxUploadSizeBytes)
            } else if (Number.isFinite(data?.maxUploadSizeMB) && data.maxUploadSizeMB > 0) {
                relayMaxSizeBytes.value = Number(data.maxUploadSizeMB) * 1024 * 1024
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
                sendMessage({ type: 'p2p_hello', payload: { peerId: selfPeerId } })

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
            sendMessage({ type: 'p2p_hello', payload: { peerId: selfPeerId } })
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
        for (const timerId of peerRetryTimers.value.values()) {
            window.clearTimeout(timerId)
        }
        for (const pc of peerConnections.value.values()) {
            pc.close()
        }
        peerConnections.value.clear()
        dataChannels.value.clear()
        knownPeers.value.clear()
        vpsRelayOffers.value.clear()
        pendingIceCandidates.value.clear()
        incomingFilesById.value.clear()
        activeIncomingFileByPeer.value.clear()
        applyingAnswers.value.clear()
        makingOffers.value.clear()
        forceRelayPeers.value.clear()
        peerRetryAttempts.value.clear()
        peerLastRetryAt.value.clear()
        peerRetryTimers.value.clear()
        resetTransferTelemetry()
        isP2PConnected.value = false
    }

    // --- WebRTC Logic ---
    const rtcIceServers = parseIceServersFromEnv()
    const supportsTurnRelay = hasTurnServer(rtcIceServers)

    function updateP2PConnectedState() {
        isP2PConnected.value = Array.from(dataChannels.value.values())
            .some(dc => dc.readyState === 'open')
    }

    function shouldInitiateToPeer(peerId: string): boolean {
        return selfPeerId < peerId
    }

    function getPeerRTCConfig(peerId: string): RTCConfiguration {
        const forceRelay = supportsTurnRelay && (forceRelayPeers.value.has(peerId) || shouldPreferRelayByNetwork())
        return {
            iceServers: rtcIceServers,
            iceCandidatePoolSize: 8,
            iceTransportPolicy: forceRelay ? 'relay' : 'all'
        }
    }

    function clearPeerRetryTimer(peerId: string) {
        const timerId = peerRetryTimers.value.get(peerId)
        if (timerId) {
            window.clearTimeout(timerId)
            peerRetryTimers.value.delete(peerId)
        }
    }

    function cleanupPeerConnection(peerId: string, closePc = false) {
        clearPeerRetryTimer(peerId)
        if (closePc) {
            const pc = peerConnections.value.get(peerId)
            if (pc && pc.connectionState !== 'closed') {
                try {
                    pc.close()
                } catch (e) {
                    console.warn(`RTC[${peerId}] close failed`, e)
                }
            }
        }
        dataChannels.value.delete(peerId)
        peerConnections.value.delete(peerId)
        pendingIceCandidates.value.delete(peerId)
        updateP2PConnectedState()
    }

    function resetPeerRetryState(peerId: string) {
        clearPeerRetryTimer(peerId)
        peerRetryAttempts.value.delete(peerId)
        peerLastRetryAt.value.delete(peerId)
    }

    function schedulePeerRetry(peerId: string, reason: string, delayMs: number) {
        clearPeerRetryTimer(peerId)
        const timer = window.setTimeout(() => {
            peerRetryTimers.value.delete(peerId)
            void retryPeerConnection(peerId, reason)
        }, Math.max(0, delayMs))
        peerRetryTimers.value.set(peerId, timer)
    }

    async function retryPeerConnection(peerId: string, reason: string) {
        const now = Date.now()
        const lastRetryAt = peerLastRetryAt.value.get(peerId) || 0
        if (now-lastRetryAt < P2P_RETRY_DEBOUNCE_MS) return
        peerLastRetryAt.value.set(peerId, now)

        const currentAttempt = peerRetryAttempts.value.get(peerId) || 0
        if (currentAttempt >= P2P_MAX_RETRY_ATTEMPTS) {
            console.warn(`RTC[${peerId}] retries exhausted (${reason})`)
            cleanupPeerConnection(peerId, true)
            return
        }
        peerRetryAttempts.value.set(peerId, currentAttempt + 1)

        const useRelay = supportsTurnRelay && (currentAttempt >= 1 || shouldPreferRelayByNetwork())
        if (useRelay) {
            forceRelayPeers.value.add(peerId)
        }

        console.warn(
            `RTC[${peerId}] retry #${currentAttempt + 1} (${reason}) policy=${forceRelayPeers.value.has(peerId) ? 'relay' : 'all'}`
        )

        cleanupPeerConnection(peerId, true)
        if (shouldInitiateToPeer(peerId)) {
            try {
                await startP2P(peerId)
            } catch (e) {
                console.warn(`RTC[${peerId}] restart failed`, e)
            }
            return
        }

        // Prompt remote initiator to negotiate again.
        sendMessage({ type: 'p2p_hello', payload: { peerId: selfPeerId } })
    }

    function setupPeerConnection(peerId: string): RTCPeerConnection {
        const existing = peerConnections.value.get(peerId)
        if (existing) return existing

        const pc = new RTCPeerConnection(getPeerRTCConfig(peerId))

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendMessage({
                    type: 'candidate',
                    payload: {
                        from: selfPeerId,
                        to: peerId,
                        candidate: event.candidate
                    }
                })
            }
        }

        pc.onconnectionstatechange = () => {
            console.log(`RTC[${peerId}] State:`, pc.connectionState)
            if (pc.connectionState === 'connected') {
                resetPeerRetryState(peerId)
                ElMessage.success(`⚡ P2P 连接已建立: ${peerId.slice(0, 8)}`)
            }
            if (pc.connectionState === 'disconnected') {
                schedulePeerRetry(peerId, 'connection_disconnected', P2P_DISCONNECTED_GRACE_MS)
            }
            if (pc.connectionState === 'failed') {
                void retryPeerConnection(peerId, 'connection_failed')
            }
            if (pc.connectionState === 'closed') {
                cleanupPeerConnection(peerId, false)
                resetPeerRetryState(peerId)
            }
        }

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState
            console.log(`RTC[${peerId}] ICE State:`, state)
            if (state === 'connected' || state === 'completed') {
                resetPeerRetryState(peerId)
                return
            }
            if (state === 'disconnected') {
                schedulePeerRetry(peerId, 'ice_disconnected', P2P_DISCONNECTED_GRACE_MS)
                return
            }
            if (state === 'failed') {
                void retryPeerConnection(peerId, 'ice_failed')
            }
        }

        pc.ondatachannel = (event) => {
            setupDataChannel(event.channel, peerId)
        }

        peerConnections.value.set(peerId, pc)
        return pc
    }

    function setupDataChannel(dc: RTCDataChannel, peerId: string) {
        dc.binaryType = 'arraybuffer'
        dc.bufferedAmountLowThreshold = P2P_BUFFER_LOW_THRESHOLD

        dc.onopen = () => {
            console.log(`RTC DataChannel OPEN -> ${peerId}`)
            dataChannels.value.set(peerId, dc)
            updateP2PConnectedState()
        }
        dc.onclose = () => {
            dataChannels.value.delete(peerId)
            updateP2PConnectedState()
        }
        dc.onerror = (e) => {
            console.warn(`RTC DataChannel Error -> ${peerId}`, e)
        }
        dc.onmessage = (e) => {
            void handleP2PMessage(e.data, peerId)
        }
    }

    async function startP2P(peerId: string) {
        if (peerId === selfPeerId) return
        if (makingOffers.value.has(peerId)) {
            console.warn(`Skip startP2P for ${peerId}: offer already in progress`)
            return
        }

        console.log(`⚡ Starting P2P Handshake -> ${peerId}`)
        const pc = setupPeerConnection(peerId)
        if (pc.signalingState !== 'stable') {
            // Avoid creating nested offers; wait for current negotiation to settle.
            console.warn(`Skip startP2P for ${peerId}: signalingState=${pc.signalingState}`)
            return
        }
        makingOffers.value.add(peerId)
        try {
            let dc = dataChannels.value.get(peerId)
            if (!dc || dc.readyState === 'closed') {
                dc = pc.createDataChannel("file-transfer", { ordered: true })
                setupDataChannel(dc, peerId)
            }

            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            sendMessage({
                type: 'offer',
                payload: {
                    from: selfPeerId,
                    to: peerId,
                    sdp: offer
                }
            })
        } finally {
            makingOffers.value.delete(peerId)
        }
    }

    async function flushPendingCandidates(peerId: string) {
        const pending = pendingIceCandidates.value.get(peerId)
        if (!pending || pending.length === 0) return

        const pc = peerConnections.value.get(peerId)
        if (!pc || !pc.remoteDescription) return

        while (pending.length > 0) {
            const next = pending.shift()
            if (!next) continue
            try {
                await pc.addIceCandidate(new RTCIceCandidate(next))
            } catch (e) {
                console.warn(`Failed to add pending ICE candidate from ${peerId}`, e)
            }
        }
    }

    async function handleOffer(payload: any) {
        let fromPeerId = payload?.from
        const targetPeerId = payload?.to
        const offer = payload?.sdp || payload
        if (!fromPeerId) {
            fromPeerId = Array.from(knownPeers.value)[0]
        }
        if (!fromPeerId || !offer) return
        if (targetPeerId && targetPeerId !== selfPeerId) return
        if (fromPeerId === selfPeerId) return

        knownPeers.value.add(fromPeerId)

        const pc = setupPeerConnection(fromPeerId)
        if (pc.signalingState !== 'stable') {
            try {
                await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit)
            } catch (e) {
                console.warn(`Rollback failed for ${fromPeerId}`, e)
            }
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer))
        } catch (e) {
            console.warn(`setRemoteDescription(offer) failed for ${fromPeerId}`, e)
            return
        }
        await flushPendingCandidates(fromPeerId)

        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendMessage({
            type: 'answer',
            payload: {
                from: selfPeerId,
                to: fromPeerId,
                sdp: answer
            }
        })
    }

    async function handleAnswer(payload: any) {
        let fromPeerId = payload?.from
        const targetPeerId = payload?.to
        const answer = payload?.sdp || payload
        if (!fromPeerId) {
            fromPeerId = Array.from(peerConnections.value.keys())[0]
        }
        if (!fromPeerId || !answer) return
        if (targetPeerId && targetPeerId !== selfPeerId) return

        const pc = peerConnections.value.get(fromPeerId)
        if (!pc) return
        if (applyingAnswers.value.has(fromPeerId)) {
            console.warn(`Ignore concurrent answer from ${fromPeerId}`)
            return
        }
        applyingAnswers.value.add(fromPeerId)
        try {
            if (pc.signalingState !== 'have-local-offer') {
                // Duplicate / stale answer can arrive after state returned to stable.
                console.warn(`Ignore unexpected answer from ${fromPeerId}: signalingState=${pc.signalingState}`)
                return
            }
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answer))
            } catch (e) {
                console.warn(`setRemoteDescription(answer) failed for ${fromPeerId}`, e)
                return
            }
            await flushPendingCandidates(fromPeerId)
        } finally {
            applyingAnswers.value.delete(fromPeerId)
        }
    }

    async function handleCandidate(payload: any) {
        let fromPeerId = payload?.from
        const targetPeerId = payload?.to
        const candidate = payload?.candidate || payload
        if (!fromPeerId) {
            fromPeerId = Array.from(peerConnections.value.keys())[0] || Array.from(knownPeers.value)[0]
        }
        if (!fromPeerId || !candidate) return
        if (targetPeerId && targetPeerId !== selfPeerId) return

        const pc = setupPeerConnection(fromPeerId)
        if (!pc.remoteDescription) {
            const queue = pendingIceCandidates.value.get(fromPeerId) || []
            queue.push(candidate)
            pendingIceCandidates.value.set(fromPeerId, queue)
            return
        }

        await pc.addIceCandidate(new RTCIceCandidate(candidate))
    }

    async function waitForP2PReady(timeoutMs = 3000, preferredPeerId?: string): Promise<boolean> {
        if (!isConnected.value) return false

        if (preferredPeerId && preferredPeerId !== selfPeerId) {
            const preferredDc = dataChannels.value.get(preferredPeerId)
            if (preferredDc?.readyState === 'open') return true

            try {
                await startP2P(preferredPeerId)
            } catch (e) {
                console.warn('P2P preferred bootstrap failed', e)
            }
        } else if (!isP2PConnected.value) {
            for (const peerId of knownPeers.value) {
                if (shouldInitiateToPeer(peerId)) {
                    try {
                        await startP2P(peerId)
                    } catch (e) {
                        console.warn(`P2P bootstrap failed for ${peerId}`, e)
                    }
                }
            }
        }

        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (preferredPeerId) {
                const dc = dataChannels.value.get(preferredPeerId)
                if (dc?.readyState === 'open') return true
            } else if (isP2PConnected.value) {
                return true
            }
            await new Promise(r => setTimeout(r, 100))
        }

        if (preferredPeerId) {
            return dataChannels.value.get(preferredPeerId)?.readyState === 'open'
        }
        return isP2PConnected.value
    }

    // P2P File Sending (Stream via Chunking over DC)
    async function sendFileP2P(file: File, targetPeerId?: string) {
        const channels = targetPeerId
            ? [dataChannels.value.get(targetPeerId)].filter((dc): dc is RTCDataChannel => !!dc && dc.readyState === 'open')
            : Array.from(dataChannels.value.values()).filter(dc => dc.readyState === 'open')

        if (channels.length === 0) throw new Error("No open Data Channel")
        startTransferTelemetry('webrtc', 'upload', file.name, file.size, 'WebRTC DataChannel')

        try {
            const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name}`
            const meta = JSON.stringify({
                type: 'meta',
                id,
                name: file.name,
                size: file.size,
                mime: file.type,
                from: selfPeerId
            })

            for (const channel of channels) {
                channel.send(meta)
            }

            const reader = file.stream().getReader()
            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    if (!value || value.byteLength === 0) continue
                    if (!channels.some((ch) => ch.readyState === 'open')) {
                        throw new Error('No open Data Channel')
                    }

                    while (channels.some((ch) => ch.readyState === 'open' && ch.bufferedAmount > P2P_MAX_BUFFERED_BYTES)) {
                        await new Promise((r) => setTimeout(r, P2P_BUFFER_POLL_MS))
                    }

                    const payload = value.byteLength <= P2P_CHUNK_SIZE ? value : value.slice(0, P2P_CHUNK_SIZE)
                    for (const channel of channels) {
                        if (channel.readyState === 'open') {
                            channel.send(payload)
                        }
                    }
                    bumpTransferTelemetry(payload.byteLength, file.size)

                    if (value.byteLength > P2P_CHUNK_SIZE) {
                        let offset = P2P_CHUNK_SIZE
                        while (offset < value.byteLength) {
                            while (channels.some((ch) => ch.readyState === 'open' && ch.bufferedAmount > P2P_MAX_BUFFERED_BYTES)) {
                                await new Promise((r) => setTimeout(r, P2P_BUFFER_POLL_MS))
                            }
                            const next = value.slice(offset, Math.min(offset + P2P_CHUNK_SIZE, value.byteLength))
                            for (const channel of channels) {
                                if (channel.readyState === 'open') {
                                    channel.send(next)
                                }
                            }
                            bumpTransferTelemetry(next.byteLength, file.size)
                            offset += P2P_CHUNK_SIZE
                        }
                    }
                }
            } finally {
                reader.releaseLock()
            }

            finishTransferTelemetry('done')
            console.log(`✅ P2P Send Complete: ${file.name} -> ${targetPeerId || 'all-open-peers'}`)
        } catch (e) {
            finishTransferTelemetry('error', 'WebRTC send failed')
            throw e
        }
    }

    async function handleIncomingBinaryChunk(peerId: string, data: ArrayBuffer) {
        const activeFileId = activeIncomingFileByPeer.value.get(peerId)
        if (!activeFileId) return

        const incomingFile = incomingFilesById.value.get(activeFileId)
        if (!incomingFile) return

        incomingFile.buffer.push(data)
        incomingFile.received += data.byteLength
        bumpTransferTelemetry(data.byteLength, incomingFile.size)

        if (onP2PEvent.value) {
            onP2PEvent.value('progress', {
                id: incomingFile.id,
                received: incomingFile.received,
                total: incomingFile.size
            })
        }

        if (incomingFile.received >= incomingFile.size) {
            const blob = new Blob(incomingFile.buffer)
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = incomingFile.name
            a.click()
            URL.revokeObjectURL(url)

            incomingFilesById.value.delete(activeFileId)
            activeIncomingFileByPeer.value.delete(peerId)
            finishTransferTelemetry('done')
            ElMessage.success('WebRTC P2P 传输完成! 🚀')
        }
    }

    async function handleP2PMessage(data: any, peerId: string) {
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data)
                if (msg.type === 'meta') {
                    const incoming = {
                        id: msg.id,
                        name: msg.name,
                        size: msg.size,
                        received: 0,
                        buffer: [] as BlobPart[]
                    }
                    incomingFilesById.value.set(msg.id, incoming)
                    activeIncomingFileByPeer.value.set(peerId, msg.id)
                    startTransferTelemetry('webrtc', 'download', msg.name, Number(msg.size) || 0, 'WebRTC DataChannel')
                    console.log(`📥 P2P Incoming File: ${msg.name} from ${peerId}`)

                    if (onP2PEvent.value) {
                        onP2PEvent.value('offer', {
                            id: msg.id,
                            name: msg.name,
                            size: msg.size,
                            type: msg.mime,
                            isLan: false,
                            isP2P: true
                        })
                    }
                }
            } catch (e) {
                console.warn('Invalid P2P message payload', e)
            }
            return
        }

        if (data instanceof Blob) {
            const buffer = await data.arrayBuffer()
            await handleIncomingBinaryChunk(peerId, buffer)
            return
        }

        if (data instanceof ArrayBuffer) {
            await handleIncomingBinaryChunk(peerId, data)
        }
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

    // --- LAN Lazy File Sharing ---
    // Share file to LAN: only broadcast metadata, file stays in browser memory
    function shareLanFile(file: File): string {
        const fileId = `lan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        localFiles.value.set(fileId, file)

        // Broadcast metadata only (no upload!)
        sendMessage({
            type: 'lan_file_offer',
            payload: {
                id: fileId,
                name: file.name,
                size: file.size,
                type: file.type
            }
        })
        ElMessage.success(`📋 已共享: ${file.name} (等待下载)`)
        return fileId
    }

    // FilePanel mode: upload to LAN host disk first, then broadcast as ready.
    async function shareLanFilePersistent(file: File): Promise<any> {
        const activeLanServer = getActiveLanServer()
        if (!activeLanServer) throw new Error('No LAN server available')

        const uploaded = await uploadLanFileWT(file)
        const lanFileId = uploaded?.id
        if (!lanFileId) throw new Error('LAN persistent upload failed')

        const shareId = `lan-shared-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        const payload = {
            id: shareId,
            lanFileId,
            name: uploaded.name || file.name,
            size: uploaded.size || file.size,
            ip: activeLanServer.ip,
            httpPort: activeLanServer.httpPort,
            h3Port: activeLanServer.h3Port,
            certHash: activeLanServer.certHash,
            isRelay: false,
            status: 'ready'
        }

        sendMessage({
            type: 'lan_file_shared',
            payload
        })
        return payload
    }

    // P2P panel mode: relay-only offer, no disk write on LAN host.
    function shareP2PRelayFile(file: File): string {
        const fileId = `p2p-relay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
        localFiles.value.set(fileId, file)
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
        vpsRelayOffers.value.delete(id)
    }

    async function handleP2PRelayRequest(fileId: string, requesterId?: string) {
        const file = localFiles.value.get(fileId)
        if (!file) return

        const fallbackToWebRTC = async (reason: string) => {
            console.warn(`LAN relay unavailable (${reason}), auto fallback to WebRTC for ${file.name}`)
            if (await waitForP2PReady(4000, requesterId)) {
                try {
                    await sendFileP2P(file, requesterId)
                    ElMessage.warning(`LAN中转失败，已自动切换 WebRTC: ${file.name}`)
                    return
                } catch (e) {
                    console.warn('WebRTC direct send failed after LAN relay failure', e)
                }
            }

            // Final fallback to VPS stream relay.
            if (!isRelaySizeAllowed(file.size)) {
                const maxMb = getRelayMaxSizeMb()
                ElMessage.error(`LAN/WebRTC 均失败，且文件超过 VPS 中转限制(${maxMb}MB): ${file.name}`)
                return
            }
            try {
                await shareViaVpsRelay(file)
                ElMessage.warning(`LAN中转失败，WebRTC不可用，已切换 VPS 中转: ${file.name}`)
            } catch (err) {
                console.error('VPS relay fallback failed', err)
                ElMessage.error(`LAN/WebRTC 均失败，且 VPS 中转不可用: ${file.name}`)
            }
        }

        const activeLanServer = getActiveLanServer()
        if (!activeLanServer) {
            await fallbackToWebRTC('no_lan_server')
            return
        }

        try {
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
                        name: file.name,
                        size: file.size,
                        ip: activeLanServer.ip,
                        httpPort: activeLanServer.httpPort,
                        h3Port: activeLanServer.h3Port,
                        certHash: activeLanServer.certHash,
                        isRelay: true,
                        status: 'ready',
                        from: selfPeerId,
                        to: requesterId
                    }
                })
            }

            if (activeLanServer.h3Port && activeLanServer.certHash) {
                try {
                    await uploadToLanRelayWT(file, activeLanServer, relayId, sendRelayReady, 8000)
                    // Backward compatibility: if older desktop doesn't return WT ready ack line.
                    sendRelayReady()
                    return
                } catch (e) {
                    console.warn('WT relay failed, fallback to WebRTC', e)
                    await fallbackToWebRTC('wt_handshake_or_timeout')
                    return
                }
            }

            if (activeLanServer.httpPort && window.location.protocol !== 'https:') {
                uploadToLanRelay(file, activeLanServer, relayId).catch(async e => {
                    console.error("HTTP Relay Upload Aborted", e)
                    await fallbackToWebRTC('http_relay_failed')
                })
                // HTTP relay has no explicit ready ack; send ready once upload request starts.
                sendRelayReady()
                return
            } else {
                await fallbackToWebRTC('no_lan_transport')
                return
            }
        } catch (e) {
            console.error('P2P relay start failed', e)
            await fallbackToWebRTC('relay_start_exception')
        }
    }

    // Request a LAN shared file (triggers sender to upload to desktop)
    function requestLanFile(fileId: string) {
        sendMessage({
            type: 'lan_file_request',
            payload: { id: fileId, requesterId: selfPeerId }
        })
        console.log(`📥 Requesting LAN file: ${fileId}`)
    }

    function notifyLanFileConsumed(originalId: string, lanFileId?: string) {
        if (!originalId) return
        sendMessage({
            type: 'lan_file_consumed',
            payload: {
                originalId,
                lanFileId,
                by: selfPeerId,
                at: Date.now()
            }
        })
    }

    function notifyLanFileFailed(originalId: string, reason: string, requesterId?: string) {
        if (!originalId) return
        sendMessage({
            type: 'lan_file_failed',
            payload: {
                originalId,
                reason,
                from: selfPeerId,
                to: requesterId
            }
        })
    }

    // Handle lan_file_request: start relay on demand (LAN host forwards stream and persists copy).
    async function handleLanFileRequest(fileId: string, requesterId?: string) {
        const file = localFiles.value.get(fileId)
        if (!file) {
            console.warn(`File ${fileId} not found locally`)
            return
        }

        const activeLanServer = getActiveLanServer()
        if (!activeLanServer) {
            console.error('No LAN server available for upload')
            return
        }

        console.log(`📤 Uploading ${file.name} to Desktop LAN server on demand...`)
        ElMessage.info(`📤 正在上传 ${file.name} 到主机...`)

        try {
            const relayId = `relay-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            let readySent = false
            const sendLanReady = () => {
                if (readySent) return
                readySent = true
                sendMessage({
                    type: 'lan_file_ready',
                    payload: {
                        originalId: fileId,
                        lanFileId: relayId,
                        name: file.name,
                        size: file.size,
                        ip: activeLanServer.ip,
                        httpPort: activeLanServer.httpPort,
                        h3Port: activeLanServer.h3Port,
                        certHash: activeLanServer.certHash,
                        isRelay: true,
                        from: selfPeerId,
                        to: requesterId
                    }
                })
            }

            if (activeLanServer.h3Port && activeLanServer.certHash) {
                await uploadToLanRelayWT(file, activeLanServer, relayId, sendLanReady, 8000, true)
                // Backward compatibility: if older desktop doesn't return WT ready ack line.
                sendLanReady()
                ElMessage.success(`✅ ${file.name} 就绪 (LAN 中转)`)
                return
            }

            if (activeLanServer.httpPort && window.location.protocol !== 'https:') {
                uploadToLanRelay(file, activeLanServer, relayId, true).catch(e => {
                    console.error("HTTP Relay Upload Aborted", e)
                    notifyLanFileFailed(fileId, 'http_relay_upload_failed', requesterId)
                })
                // HTTP relay has no explicit ready ack; send ready once upload request starts.
                sendLanReady()
                ElMessage.success(`✅ ${file.name} 就绪 (LAN 中转)`)
                return
            }

            if (window.location.protocol === 'https:') {
                notifyLanFileFailed(fileId, 'https_http_relay_blocked', requesterId)
                ElMessage.warning('当前为 HTTPS 页面，HTTP 中转被浏览器拦截；请确保 LAN WebTransport 可用')
            } else {
                notifyLanFileFailed(fileId, 'no_lan_transport', requesterId)
                ElMessage.error('没有可用的 LAN 中转通道')
            }
            return
        } catch (e) {
            console.error('Failed to upload on demand', e)
            notifyLanFileFailed(fileId, 'relay_start_failed', requesterId)
            ElMessage.error('上传失败')
        }
    }

    async function uploadToLanRelay(file: File, server: LanServerInfo, relayId: string, persistToHost = false) {
        // This request will BLOCK until the receiver connects!
        // or until server times out (we rely on server timeout)
        console.log(`🚀 Starting Relay Stream: ${relayId}`)
        startTransferTelemetry('lan-http-relay', 'upload', file.name, file.size, 'LAN HTTP relay')
        const relayUrl = `http://${server.ip}:${server.httpPort}/api/lan/relay/upload/${relayId}?name=${encodeURIComponent(file.name)}&persist=${persistToHost ? '1' : '0'}`
        const res = await fetch(relayUrl, { method: 'POST', body: file })
        if (!res.ok) {
            finishTransferTelemetry('error', `HTTP ${res.status}`)
            throw new Error(`Relay error: ${res.statusText}`)
        }
        // Browser fetch upload doesn't expose byte progress; set at completion.
        bumpTransferTelemetry(file.size, file.size)
        finishTransferTelemetry('done')
        console.log(`✅ Relay Stream Complete: ${relayId}`)
    }

    async function uploadToLanRelayWT(
        file: File,
        server: LanServerInfo,
        relayId: string,
        onReady?: () => void,
        readyTimeoutMs = 8000,
        persistToHost = false
    ) {
        if (!server.h3Port || !server.certHash) throw new Error('LAN WT unavailable')

        console.log(`🚀 Starting WT Relay Stream: ${relayId}`)
        startTransferTelemetry('lan-wt-relay', 'upload', file.name, file.size, 'LAN WT relay')
        try {
            const wt = await createLanWT(server)
            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            const cmd = JSON.stringify({
                action: 'relay_upload',
                relayId,
                name: file.name,
                size: file.size,
                persist: persistToHost
            }) + '\n'
            await writer.write(new TextEncoder().encode(cmd))

            // Desktop returns {"status":"ready"} before it starts reading stream body.
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
                wt.close()
                throw new Error(readyResp.error)
            }
            if (!readyResp || readyResp.status !== 'ready') {
                wt.close()
                finishTransferTelemetry('error', 'WT relay ready missing')
                throw new Error('WT relay ready response missing')
            }
            if (readyResp?.status === 'ready' && onReady) onReady()

            await streamFileToWriter(file, writer, (bytes) => bumpTransferTelemetry(bytes, file.size))
            await writer.close()
            finishTransferTelemetry('done')
            wt.close()
        } catch (e) {
            finishTransferTelemetry('error', 'WT relay upload failed')
            throw e
        }
    }

    async function uploadToLanWT(file: File, server: LanServerInfo): Promise<string | null> {
        const url = `https://${server.ip}:${server.h3Port}/wt`
        const hashBytes = decodeCertHashBase64(server.certHash!)
        startTransferTelemetry('lan-wt-direct', 'upload', file.name, file.size, 'LAN WT direct')
        try {
            const wt = new WebTransport(url, {
                serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes.buffer }]
            })
            await wt.ready
            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            const cmd = JSON.stringify({ action: 'upload', name: file.name, size: file.size }) + '\n'
            await writer.write(new TextEncoder().encode(cmd))
            await streamFileToWriter(file, writer, (bytes) => bumpTransferTelemetry(bytes, file.size))
            await writer.close()

            const resp = await readJsonResponse(reader)
            wt.close()
            if (resp && resp.status === 'ok') {
                finishTransferTelemetry('done')
                return resp.file.id
            }
            finishTransferTelemetry('error', 'LAN WT upload failed')
            return null
        } catch (e) {
            finishTransferTelemetry('error', 'LAN WT upload failed')
            throw e
        }
    }

    async function uploadToLanHTTP(file: File, server: LanServerInfo): Promise<string | null> {
        const formData = new FormData()
        formData.append('file', file)
        startTransferTelemetry('lan-http-direct', 'upload', file.name, file.size, 'LAN HTTP direct')
        const res = await fetch(`http://${server.ip}:${server.httpPort}/api/lan/upload`, {
            method: 'POST', body: formData
        })
        if (res.ok) {
            const data = await res.json()
            bumpTransferTelemetry(file.size, file.size)
            finishTransferTelemetry('done')
            return data.id
        }
        finishTransferTelemetry('error', `HTTP ${res.status}`)
        return null
    }

    async function uploadToCloudStorage(file: File): Promise<{
        id: string
        name: string
        size: number
        type: string
        url: string
        mode: 'netdisk'
    } | null> {
        try {
            startTransferTelemetry('cloud', 'upload', file.name, file.size, 'Cloud upload')
            const formData = new FormData()
            formData.append('file', file)
            const res = await fetch(`${HTTP_URL.value}/upload`, {
                method: 'POST',
                body: formData
            })
            if (!res.ok) {
                finishTransferTelemetry('error', `HTTP ${res.status}`)
                return null
            }

            const data = await res.json()
            if (!data?.url) {
                finishTransferTelemetry('error', 'Cloud upload response invalid')
                return null
            }

            const absoluteUrl = data.url.startsWith('http')
                ? data.url
                : `${HTTP_URL.value}${data.url}`

            const result = {
                id: `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: data.name || file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
                url: absoluteUrl,
                mode: 'netdisk' as const
            }
            bumpTransferTelemetry(file.size, file.size)
            finishTransferTelemetry('done')
            return result
        } catch (e) {
            console.error('Cloud upload failed', e)
            finishTransferTelemetry('error', 'Cloud upload failed')
            return null
        }
    }

    function shouldPreferBrowserDownloadManager(): boolean {
        // In web browsers (especially Android), native URL download is more reliable
        // than fetch+blob streaming and shows up in browser download list.
        return !isDesktop.value && downloadMode.value === 'compat'
    }

    function setDownloadMode(mode: DownloadMode) {
        downloadMode.value = mode
        localStorage.setItem(DOWNLOAD_MODE_KEY, mode)
    }

    function isSpeedDownloadMode(): boolean {
        return !isDesktop.value && downloadMode.value === 'speed'
    }

    function openLanDownloadURL(
        fileId: string,
        fileName: string,
        ip?: string,
        httpPort?: number,
        h3Port?: number,
        isRelay = false
    ): Promise<'https' | 'http' | null> {
        if (!ip) return Promise.resolve(null)
        startTransferTelemetry('browser-url', 'download', fileName, 0, 'Browser download manager')
        const path = isRelay
            ? `/api/lan/relay/download/${fileId}`
            : `/api/lan/download/${fileId}`

        const openUrl = (url: string) => {
            // Prefer window.open so we can detect popup blocking.
            const opened = window.open(url, '_blank', 'noopener')
            if (!opened) return false
            try {
                opened.opener = null
            } catch {
                // ignore cross-origin access errors
            }
            return true
        }

        const probeLanHttps = async (): Promise<boolean> => {
            if (!h3Port) return false
            const controller = new AbortController()
            const timer = window.setTimeout(() => controller.abort(), 1800)
            try {
                const probeUrl = `https://${ip}:${h3Port}/api/lan/files`
                const res = await fetch(probeUrl, {
                    method: 'GET',
                    cache: 'no-store',
                    signal: controller.signal
                })
                return res.ok
            } catch {
                return false
            } finally {
                window.clearTimeout(timer)
            }
        }

        const pushHttp = () => {
            if (!httpPort) return
            return {
                kind: 'http' as const,
                url: `http://${ip}:${httpPort}${path}`
            }
        }
        const pushHttps = () => {
            if (!h3Port) return
            return {
                kind: 'https' as const,
                url: `https://${ip}:${h3Port}${path}`
            }
        }

        return (async () => {
            const candidates: Array<{ kind: 'http' | 'https'; url: string }> = []
            const httpsReachable = await probeLanHttps()
            if (httpsReachable) {
                const https = pushHttps()
                if (https) candidates.push(https)
                const http = pushHttp()
                if (http) candidates.push(http)
            } else {
                const http = pushHttp()
                if (http) candidates.push(http)
                // If only H3 exists, keep a best-effort HTTPS handoff.
                if (!http) {
                    const https = pushHttps()
                    if (https) candidates.push(https)
                }
            }

            for (const candidate of candidates) {
                if (!openUrl(candidate.url)) continue
                if (candidate.kind === 'https') {
                    setTransferRoute('lan-url-https')
                    console.info(`📥 Download route: lan-url-https -> ${candidate.url}`)
                    finishTransferTelemetry('handoff', `URL handoff: HTTPS${isRelay ? ' relay' : ''}`)
                    return 'https'
                }
                setTransferRoute('lan-url-http')
                console.info(`📥 Download route: lan-url-http -> ${candidate.url}`)
                finishTransferTelemetry('handoff', `URL handoff: HTTP${isRelay ? ' relay' : ''}`)
                return 'http'
            }

            finishTransferTelemetry('error', 'No LAN URL available')
            return null
        })()
    }

    function sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    function parseFileNameFromContentDisposition(headerValue: string | null): string | null {
        if (!headerValue) return null

        const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/i)
        if (utf8Match?.[1]) {
            try {
                return decodeURIComponent(utf8Match[1])
            } catch {
                return utf8Match[1]
            }
        }

        const plainMatch = headerValue.match(/filename=\"?([^\";]+)\"?/i)
        if (plainMatch?.[1]) {
            return plainMatch[1]
        }

        return null
    }

    async function ackVpsRelay(relayId: string, cleanup = false): Promise<void> {
        const url = `${HTTP_URL.value}/api/relay/ack/${relayId}`
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cleanup })
            })
        } catch (e) {
            console.warn(`VPS relay ack failed: ${relayId}`, e)
        }
    }

    async function downloadVpsRelayFile(
        relayId: string,
        downloadUrl: string,
        fallbackName: string,
        totalSizeHint = 0
    ): Promise<boolean> {
        if (shouldPreferBrowserDownloadManager()) {
            startTransferTelemetry('browser-url', 'download', fallbackName, totalSizeHint || 0, 'Browser download manager')
            setTransferRoute('vps-url')
            console.info(`📥 Download route: vps-url -> ${downloadUrl}`)
            const opened = window.open(downloadUrl, '_blank', 'noopener')
            if (!opened) {
                finishTransferTelemetry('error', 'Browser blocked download popup')
                return false
            }
            try {
                opened.opener = null
            } catch {
                // ignore cross-origin access errors
            }
            finishTransferTelemetry('handoff', 'URL handoff: VPS relay')
            return true
        }

        startTransferTelemetry('vps-relay', 'download', fallbackName, totalSizeHint || 0, 'VPS relay')
        setTransferRoute('vps-stream')
        const chunks: BlobPart[] = []
        let downloaded = 0
        let expectedTotal = totalSizeHint
        let finalName = fallbackName

        const maxRetries = 3
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const headers: HeadersInit = {}
            if (downloaded > 0) {
                headers.Range = `bytes=${downloaded}-`
            }

            try {
                const res = await fetch(downloadUrl, { method: 'GET', headers })
                if (!res.ok && res.status !== 206) {
                    throw new Error(`HTTP ${res.status}`)
                }

                if (downloaded > 0 && res.status === 200) {
                    // Server ignored range, restart from beginning.
                    downloaded = 0
                    chunks.length = 0
                }

                const fileNameFromHeader = parseFileNameFromContentDisposition(
                    res.headers.get('content-disposition')
                )
                if (fileNameFromHeader) finalName = fileNameFromHeader

                const contentRange = res.headers.get('content-range')
                if (contentRange) {
                    const totalFromRange = Number(contentRange.split('/')[1])
                    if (!Number.isNaN(totalFromRange) && totalFromRange > 0) {
                        expectedTotal = totalFromRange
                    }
                } else if (!expectedTotal) {
                    const len = Number(res.headers.get('content-length') || '0')
                    if (!Number.isNaN(len) && len > 0) {
                        expectedTotal = downloaded + len
                    }
                }

                const reader = res.body?.getReader()
                if (!reader) throw new Error('ReadableStream unavailable')

                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    if (!value) continue

                    chunks.push(value)
                    downloaded += value.byteLength
                    bumpTransferTelemetry(value.byteLength, expectedTotal || totalSizeHint || 0)
                    if (onP2PEvent.value) {
                        onP2PEvent.value('progress', {
                            id: relayId,
                            received: downloaded,
                            total: expectedTotal || totalSizeHint || downloaded
                        })
                    }
                }

                if (!expectedTotal || downloaded >= expectedTotal) {
                    break
                }
            } catch (e) {
                if (attempt >= maxRetries) {
                    console.error('VPS relay download failed after retries', e)
                    finishTransferTelemetry('error', 'VPS relay download failed')
                    return false
                }
                await sleep(300 * (attempt + 1))
                continue
            }
        }

        const blob = new Blob(chunks)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = finalName
        a.click()
        URL.revokeObjectURL(a.href)

        await ackVpsRelay(relayId, false)
        sendMessage({
            type: 'vps_relay_ack',
            payload: {
                relayId,
                from: selfPeerId
            }
        })
        finishTransferTelemetry('done')
        return true
    }

    async function shareViaVpsRelay(file: File): Promise<{
        relayId: string
        url: string
        expiresAt?: number
    }> {
        if (!isRelaySizeAllowed(file.size)) {
            const maxMb = getRelayMaxSizeMb()
            throw new Error(`VPS relay size limit exceeded (${maxMb}MB)`)
        }
        startTransferTelemetry('vps-relay', 'upload', file.name, file.size, 'VPS relay')

        const maxUploadRetries = 2
        let lastError: any = null
        let relayId = ''
        let data: any = null

        for (let attempt = 0; attempt <= maxUploadRetries; attempt++) {
            try {
                relayId = `vps-relay-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
                const uploadUrl = `${HTTP_URL.value}/api/relay/upload/${relayId}?name=${encodeURIComponent(file.name)}`
                const res = await fetch(uploadUrl, {
                    method: 'POST',
                    body: file
                })
                if (!res.ok) {
                    const errText = await res.text().catch(() => '')
                    const message = `VPS relay upload failed: ${res.status}${errText ? ` ${errText}` : ''}`
                    const err: any = new Error(message)
                    // 4xx are usually non-transient (size limits, validation errors).
                    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
                        err.nonRetryable = true
                    }
                    throw err
                }
                data = await res.json()
                bumpTransferTelemetry(file.size, file.size)
                lastError = null
                break
            } catch (e: any) {
                lastError = e
                if (e?.nonRetryable) {
                    break
                }
                if (attempt >= maxUploadRetries) {
                    break
                }
                await sleep(250 * (attempt + 1))
            }
        }

        if (lastError || !relayId || !data) {
            finishTransferTelemetry('error', 'VPS relay upload failed')
            throw lastError || new Error('VPS relay upload failed')
        }

        const rawDownloadUrl = data?.downloadUrl || `/api/relay/download/${relayId}`
        const absoluteDownloadUrl = rawDownloadUrl.startsWith('http')
            ? rawDownloadUrl
            : `${HTTP_URL.value}${rawDownloadUrl}`

        vpsRelayOffers.value.set(relayId, {
            relayId,
            name: file.name,
            size: file.size,
            type: file.type,
            url: absoluteDownloadUrl,
            expiresAt: data?.expiresAt
        })

        sendMessage({
            type: 'vps_relay_offer',
            payload: {
                id: relayId,
                relayId,
                name: file.name,
                size: file.size,
                type: file.type,
                url: absoluteDownloadUrl,
                isVpsRelay: true,
                expiresAt: data?.expiresAt
            }
        })

        finishTransferTelemetry('done')

        return {
            relayId,
            url: absoluteDownloadUrl,
            expiresAt: data?.expiresAt
        }
    }

    // --- WebTransport LAN Helpers (bypass Mixed Content) ---
    function getActiveLanServer(): LanServerInfo | null {
        if (lanServerUrl.value) {
            for (const server of lanServers.value.values()) {
                const url = `http://${server.ip}:${server.httpPort}`
                if (url === lanServerUrl.value) return server
            }
        }
        return Array.from(lanServers.value.values())[0] || null
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

    async function createLanWTByAddress(ip: string, h3Port: number, certHash: string): Promise<any> {
        const url = `https://${ip}:${h3Port}/wt`
        const hashBytes = decodeCertHashBase64(certHash)
        console.log(
            `🔐 LAN WT connect -> ${url} certHashLen=${certHash.length} hashBytes=${hashBytes.byteLength} prefix=${certHash.slice(0, 12)}...`
        )
        const wt = new WebTransport(url, {
            serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes.buffer }]
        })
        await waitWTReady(wt, url)
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

    async function readJsonResponse(
        reader: ReadableStreamDefaultReader<Uint8Array>
    ): Promise<any | null> {
        const decoder = new TextDecoder()
        let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))

        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value) continue

            const chunk = toArrayBufferBytes(value)
            buffer = appendBytes(buffer, chunk)
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
        onChunk?: (bytes: number) => void
    ): Promise<void> {
        const reader = file.stream().getReader()
        let bufferedChunks: Uint8Array<ArrayBuffer>[] = []
        let bufferedBytes = 0

        const flushBuffered = async () => {
            if (bufferedBytes <= 0) return
            let payload: Uint8Array<ArrayBuffer>
            if (bufferedChunks.length === 1 && bufferedChunks[0]) {
                payload = bufferedChunks[0]
            } else {
                payload = new Uint8Array(new ArrayBuffer(bufferedBytes))
                let offset = 0
                for (const part of bufferedChunks) {
                    payload.set(part, offset)
                    offset += part.byteLength
                }
            }
            await writer.write(payload)
            if (onChunk) onChunk(bufferedBytes)
            bufferedChunks = []
            bufferedBytes = 0
        }

        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (!value) continue
                const chunk = toArrayBufferBytes(value)
                bufferedChunks.push(chunk)
                bufferedBytes += chunk.byteLength
                if (bufferedBytes >= WT_WRITE_BATCH_BYTES) {
                    await flushBuffered()
                }
            }
            await flushBuffered()
        } finally {
            reader.releaseLock()
        }
    }

    async function saveWTDownloadToFile(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        fallbackName: string,
        onChunk?: (bytes: number) => void
    ): Promise<boolean> {
        const chunks: BlobPart[] = []
        let metaReceived = false
        let name = fallbackName
        let metaBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0))
        let streamSaver: any = null
        let saverChunks: Uint8Array<ArrayBuffer>[] = []
        let saverBytes = 0

        const flushSaverChunks = async (force = false) => {
            if (!streamSaver || saverBytes <= 0) return
            if (!force && saverBytes < WT_WRITE_BATCH_BYTES) return
            let payload: Uint8Array<ArrayBuffer>
            if (saverChunks.length === 1 && saverChunks[0]) {
                payload = saverChunks[0]
            } else {
                payload = new Uint8Array(new ArrayBuffer(saverBytes))
                let offset = 0
                for (const part of saverChunks) {
                    payload.set(part, offset)
                    offset += part.byteLength
                }
            }
            await streamSaver.write(payload)
            if (onChunk) onChunk(saverBytes)
            saverChunks = []
            saverBytes = 0
        }

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
                        if (streamSaver) {
                            saverChunks.push(rest)
                            saverBytes += rest.byteLength
                            await flushSaverChunks()
                        } else {
                            chunks.push(rest)
                            if (onChunk) onChunk(rest.byteLength)
                        }
                    }

                    metaReceived = true
                    metaBuffer = new Uint8Array(new ArrayBuffer(0))
                } catch (e) {
                    console.error('WT download metadata parse failed', e)
                    return false
                }
            } else {
                if (streamSaver) {
                    saverChunks.push(chunk)
                    saverBytes += chunk.byteLength
                    await flushSaverChunks()
                } else {
                    chunks.push(chunk)
                    if (onChunk) onChunk(chunk.byteLength)
                }
            }
        }

        if (!metaReceived) {
            console.error('WT download ended before metadata was received')
            return false
        }

        if (streamSaver) {
            await flushSaverChunks(true)
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

    async function createLanWT(server: LanServerInfo): Promise<any> {
        if (!server.h3Port || !server.certHash) {
            throw new Error('LAN WT unavailable')
        }
        return createLanWTByAddress(server.ip, server.h3Port, server.certHash)
    }

    // List files via VPS signaling relay (Web -> VPS -> Desktop -> VPS -> Web)
    // Falls back from WebTransport since direct WT to desktop has cert issues
    const _lanListResolvers: Array<(files: any[]) => void> = []

    async function listLanFilesWT(): Promise<any[]> {
        if (!lanServerUrl.value) return []

        return new Promise<any[]>((resolve) => {
            // Set timeout in case desktop doesn't respond
            const timeout = setTimeout(() => resolve([]), 5000)

            _lanListResolvers.push((files: any[]) => {
                clearTimeout(timeout)
                resolve(files)
            })

            // Request file list via VPS signaling
            sendMessage({ type: 'lan_list_request', payload: {} })
        })
    }

    function handleLanListResponse(files: any[]): boolean {
        // Resolve all pending list requests
        if (_lanListResolvers.length > 0) {
            while (_lanListResolvers.length > 0) {
                const resolver = _lanListResolvers.shift()
                if (resolver) resolver(files)
            }
            return true
        }
        return false
    }

    // Upload file via WebTransport
    async function uploadLanFileWT(file: File): Promise<any> {
        const server = getActiveLanServer()
        if (!server?.httpPort) throw new Error('No LAN server')

        if (server.h3Port && server.certHash) {
            let wt: any = null
            try {
                wt = await createLanWT(server)
                const stream = await wt.createBidirectionalStream()
                const writer = stream.writable.getWriter()
                const reader = stream.readable.getReader()

                const cmd = JSON.stringify({ action: 'upload', name: file.name, size: file.size }) + '\n'
                await writer.write(new TextEncoder().encode(cmd))
                await streamFileToWriter(file, writer)
                await writer.close()

                const resp = await readJsonResponse(reader)
                if (resp && resp.status === 'ok') return resp.file
            } catch (e) {
                console.warn('LAN WT upload failed, falling back to HTTP', e)
            } finally {
                try {
                    wt?.close?.()
                } catch {
                    // ignore close errors
                }
            }
        } else {
            console.warn('LAN WT unavailable, falling back to HTTP upload')
        }

        const fallbackId = await uploadToLanHTTP(file, server)
        if (fallbackId) {
            return {
                id: fallbackId,
                name: file.name,
                size: file.size,
                mode: 'http-fallback'
            }
        }
        throw new Error('Upload failed on WT and HTTP fallback')
    }

    // Download file via WebTransport
    async function downloadLanFileWT(fileId: string, fileName: string): Promise<boolean> {
        if (shouldPreferBrowserDownloadManager()) return false

        const server = getActiveLanServer()
        if (!server?.h3Port || !server?.certHash) return false

        let wt: any = null
        try {
            startTransferTelemetry('lan-wt-direct', 'download', fileName, 0, 'LAN WT direct')
            setTransferRoute('lan-wt-direct')
            wt = await createLanWT(server)
            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            await writer.write(new TextEncoder().encode(
                JSON.stringify({ action: 'download', fileId }) + '\n'
            ))
            await writer.close()
            const ok = await saveWTDownloadToFile(reader, fileName, (bytes) => bumpTransferTelemetry(bytes))
            finishTransferTelemetry(ok ? 'done' : 'error', ok ? '' : 'WT download failed')
            return ok
        } catch (e) {
            console.error('WT download failed', e)
            finishTransferTelemetry('error', 'WT download failed')
            return false
        } finally {
            try {
                wt?.close?.()
            } catch {
                // ignore close errors
            }
        }
    }

    async function downloadLanRelayWT(
        relayId: string,
        fileName: string,
        ip?: string,
        h3Port?: number,
        certHashVal?: string
    ): Promise<boolean> {
        if (shouldPreferBrowserDownloadManager()) return false

        const activeServer = getActiveLanServer()
        const targetIp = ip || activeServer?.ip
        const targetH3Port = h3Port || activeServer?.h3Port
        const targetCertHash = certHashVal || activeServer?.certHash
        if (!targetIp || !targetH3Port || !targetCertHash) return false

        let wt: any = null
        try {
            startTransferTelemetry('lan-wt-relay', 'download', fileName, 0, 'LAN WT relay')
            setTransferRoute('lan-wt-relay')
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

    // Relay-first send chain for P2PFilePanel (no LAN host disk persistence).
    async function smartRelaySendFile(file: File): Promise<string> {
        const activeLanServer = getActiveLanServer()
        const offerId = shareP2PRelayFile(file)
        if (activeLanServer) {
            ElMessage.success('📡 已发布 LAN 中转任务，等待对方下载')
            return offerId
        }

        // No desktop LAN host: keep relay offer pending.
        // Actual transfer starts only after receiver clicks download and sends p2p_relay_request.
        ElMessage.info('📡 已发布待下载任务（无桌面端）；对方点击下载后将自动切 WebRTC/VPS')
        return offerId
    }

    // Phase 2: Smart Send (LAN WebTransport -> HTTP -> P2P -> VPS)
    async function smartSendFile(file: File) {
        // Find active LAN server with full info
        const activeLanServer = getActiveLanServer()

        // Priority 1: LAN WebTransport (HTTP/3)
        if (activeLanServer?.h3Port && activeLanServer?.certHash) {
            console.log("🚀 Smart Send: Trying LAN WebTransport (HTTP/3)...")
            try {
                const result = await sendViaLanWebTransport(file, activeLanServer)
                if (result) {
                    ElMessage.success('⚡ 已通过 LAN HTTP/3 极速分享')
                    return
                }
            } catch (e) {
                console.warn("LAN WebTransport failed, falling back to HTTP", e)
            }
        }

        // Priority 2: LAN HTTP Fallback
        if (activeLanServer?.httpPort) {
            console.log("🔄 Smart Send: Trying LAN HTTP fallback...")
            try {
                const httpUrl = `http://${activeLanServer.ip}:${activeLanServer.httpPort}`
                const formData = new FormData()
                formData.append('file', file)

                const res = await fetch(`${httpUrl}/api/lan/upload`, {
                    method: 'POST',
                    body: formData
                })

                if (res.ok) {
                    const data = await res.json()
                    sendMessage({
                        type: 'lan_file_shared',
                        payload: {
                            id: data.id,
                            name: data.name,
                            size: data.size,
                            ip: activeLanServer.ip,
                            baseUrl: httpUrl
                        }
                    })
                    ElMessage.success('⚡ 已通过局域网 HTTP 分享')
                    return
                }
            } catch (e) {
                console.warn("LAN HTTP failed, falling back to P2P/VPS", e)
            }
        }

        // Priority 3: WebRTC P2P
        if (await waitForP2PReady()) {
            console.log("🚀 Smart Send: Using WebRTC P2P...")
            try {
                await sendFileP2P(file)
                ElMessage.success('⚡ 已通过 WebRTC P2P 发送')
                return
            } catch (e) {
                console.warn("P2P Send failed", e)
            }
        }

        // Priority 4: VPS Relay (small files only)
        if (isRelaySizeAllowed(file.size)) {
            console.log("🔄 Smart Send: Falling back to VPS Relay")
            await shareViaVpsRelay(file)
            ElMessage.info('已切换 VPS Relay 中转')
            return
        }

        // Final fallback: Netdisk storage
        console.log("☁️ Smart Send: Falling back to Netdisk storage")
        const cloudFile = await uploadToCloudStorage(file)
        if (!cloudFile) {
            ElMessage.error('云端兜底上传失败')
            throw new Error('All transfer modes failed')
        }

        // Broadcast cloud file metadata to peers in room when signaling is alive.
        if (isConnected.value) {
            sendMessage({
                type: 'netdisk_file',
                payload: cloudFile
            })
        }
        ElMessage.success('☁️ 已上传到云端，可跨网络下载')
    }

    // Send file via LAN WebTransport (HTTP/3)
    async function sendViaLanWebTransport(file: File, server: LanServerInfo): Promise<boolean> {
        let wt: any = null
        try {
            wt = await createLanWT(server)
            console.log("✅ LAN WebTransport connected")

            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            // Send command
            const cmd = JSON.stringify({
                action: 'upload',
                name: file.name,
                size: file.size
            }) + '\n'
            await writer.write(new TextEncoder().encode(cmd))

            // Send file content
            await streamFileToWriter(file, writer)
            await writer.close()

            // Read response
            const response = await readJsonResponse(reader)
            if (response?.status === 'ok') {
                // Broadcast to room
                sendMessage({
                    type: 'lan_file_shared',
                    payload: {
                        id: response.file.id,
                        name: response.file.name,
                        size: response.file.size,
                        ip: server.ip,
                        baseUrl: `http://${server.ip}:${server.httpPort}` // HTTP download fallback
                    }
                })
                return true
            }
            return false
        } finally {
            try {
                wt?.close?.()
            } catch {
                // ignore close errors
            }
        }
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
                        if (msg.payload.notes) {
                            dispatchNotepadEvent('init', msg.payload.notes)
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
                case 'notepad_ack':
                case 'notepad_conflict':
                case 'notepad_delete':
                    console.log(`📝 Store handling ${msg.type}`, msg.payload)
                    dispatchNotepadEvent(msg.type, msg.payload)
                    break

                case 'clipboard_data':
                case 'clipboard_push': // 接收其它端的剪切板推送
                    // Unified: Pass full payload (with ID) to UI
                    if (msg.payload && onClipboardData.value) {
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
                    void handleOffer(msg.payload).catch((e) => {
                        console.warn('handleOffer failed', e)
                    })
                    break
                case 'answer':
                    void handleAnswer(msg.payload).catch((e) => {
                        console.warn('handleAnswer failed', e)
                    })
                    break
                case 'candidate':
                    void handleCandidate(msg.payload).catch((e) => {
                        console.warn('handleCandidate failed', e)
                    })
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

                case 'vps_relay_offer':
                    if (onP2PEvent.value) onP2PEvent.value('offer', {
                        ...msg.payload,
                        isVpsRelay: true
                    })
                    break

                case 'vps_relay_ack':
                    if (msg.payload?.relayId) {
                        vpsRelayOffers.value.delete(msg.payload.relayId)
                        if (onP2PEvent.value) {
                            onP2PEvent.value('relay_ack', msg.payload)
                        }
                    }
                    break

                case 'p2p_hello':
                    if (msg.payload?.peerId && msg.payload.peerId !== selfPeerId) {
                        const remotePeerId = msg.payload.peerId as string
                        const isNewPeer = !knownPeers.value.has(remotePeerId)
                        knownPeers.value.add(remotePeerId)
                        console.log(`👋 Received p2p_hello from ${remotePeerId}`)

                        if (isNewPeer) {
                            sendMessage({ type: 'p2p_hello', payload: { peerId: selfPeerId } })
                        }

                        if (shouldInitiateToPeer(remotePeerId)) {
                            void startP2P(remotePeerId).catch((e) => {
                                console.warn(`Auto startP2P failed for ${remotePeerId}`, e)
                            })
                        }
                    }

                    // A new peer joined. Re-broadcast my files.
                    // Loop localFiles and send offer
                    if (localFiles.value.size > 0) {
                        console.log(`📡 Re-broadcasting ${localFiles.value.size} file offers...`)
                        for (const [id, file] of localFiles.value) {
                            if (id.startsWith('lan-')) {
                                sendMessage({
                                    type: 'lan_file_offer',
                                    payload: {
                                        id,
                                        name: file.name,
                                        size: file.size,
                                        type: file.type
                                    }
                                })
                                continue
                            }
                            if (id.startsWith('p2p-relay-')) {
                                sendMessage({
                                    type: 'p2p_relay_offer',
                                    payload: {
                                        id,
                                        name: file.name,
                                        size: file.size,
                                        type: file.type,
                                        isRelay: true,
                                        status: 'pending'
                                    }
                                })
                                continue
                            }
                            sendMessage({
                                type: 'file_offer',
                                payload: {
                                    id,
                                    name: file.name,
                                    size: file.size,
                                    type: file.type
                                }
                            })
                        }
                    } else {
                        console.log('No local files to share.')
                    }

                    if (vpsRelayOffers.value.size > 0) {
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

                // --- LAN Discovery ---
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

                        // Desktop restart may create a new id with new cert/ports on same IP.
                        // Remove stale entries for this IP to avoid using outdated cert hash.
                        for (const [sid, existing] of lanServers.value.entries()) {
                            if (sid !== id && existing.ip === lanInfo.ip) {
                                lanServers.value.delete(sid)
                            }
                        }

                        // Update Map
                        if (!lanServers.value.has(id)) {
                            ElMessage.success(`⚡ 已发现局域网主机: ${name}`)
                        }
                        lanServers.value.set(id, lanInfo)

                        const incomingUrl = `http://${msg.payload.ip}:${httpPort}`
                        const active = getActiveLanServer()

                        // Auto-select if none active, or refresh active URL when same host gets new ports/cert.
                        if (!lanServerUrl.value || !active || active.ip === lanInfo.ip) {
                            lanServerUrl.value = incomingUrl
                        }
                        console.log(
                            `📡 LAN Server: HTTP=${httpPort}, H3=${h3Port || 'N/A'}, certHashLen=${(certHashVal || '').length}, certPrefix=${(certHashVal || '').slice(0, 12)}...`
                        )
                    }
                    break

                // --- LAN Lazy File Sharing ---
                case 'lan_file_offer':
                    // Someone shared file metadata (file not uploaded yet)
                    if (onLanEvent.value) {
                        onLanEvent.value('lan_offer', {
                            ...msg.payload,
                            isLan: true,
                            status: 'pending' // not yet on desktop
                        })
                    }
                    break

                case 'lan_file_request':
                    // Someone wants our file - upload to desktop on demand
                    handleLanFileRequest(msg.payload.id, msg.payload.requesterId || msg.payload.from)
                    break

                case 'lan_file_ready':
                    if (msg.payload?.to && msg.payload.to !== selfPeerId) {
                        break
                    }
                    console.log('LAN File Ready:', msg.payload)
                    // File has been uploaded to desktop, ready to download
                    if (onLanEvent.value) {
                        onLanEvent.value('lan_ready', msg.payload)
                    }
                    break

                case 'lan_file_failed':
                    if (msg.payload?.to && msg.payload.to !== selfPeerId) {
                        break
                    }
                    if (onLanEvent.value) {
                        onLanEvent.value('lan_failed', msg.payload)
                    }
                    break

                case 'lan_file_consumed':
                    if (onLanEvent.value) {
                        onLanEvent.value('lan_consumed', msg.payload)
                    }
                    break

                case 'lan_file_shared':
                    // Persistent LAN share should be managed by FilePanel.
                    if (onLanEvent.value) {
                        onLanEvent.value('lan_offer', {
                            ...msg.payload,
                            isLan: true,
                            status: 'ready',
                            lanFileId: msg.payload?.lanFileId || msg.payload?.id
                        })
                    }
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

                case 'p2p_relay_request':
                    void handleP2PRelayRequest(msg.payload.id, msg.payload.requesterId || msg.payload.from)
                    break

                case 'p2p_relay_ready':
                    if (msg.payload?.to && msg.payload.to !== selfPeerId) {
                        break
                    }
                    if (onP2PEvent.value) {
                        onP2PEvent.value('relay_ready', msg.payload)
                    }
                    break

                case 'lan_list_response':
                    // Desktop responded with file list
                    if (handleLanListResponse(msg.payload?.files || [])) {
                        // already handled by promise
                    } else if (onLanEvent.value) {
                        // fallback event
                        onLanEvent.value('lan_list', msg.payload?.files || [])
                    }
                    break
            }
        } catch (e) {
            console.error("消息解析失败", e, jsonStr)
        }
    }

    return {
        isConnected,
        isDesktop, // Export detected flag
        transport, // Export for UI state check
        currentRoom,
        serverMode,
        hostOnline,
        hostIp,
        lanServerUrl, // Export
        checkMode,
        connect,
        sendMessage,
        onClipboardData,
        onClipboardHistory,
        onClipboardDelete, // Export new callback
        onNotepadEvent,
        replayPendingNotepadEvents,
        onP2PEvent,
        onLanEvent, // Export
        shareFile,
        requestFile,
        shareLanFile,
        shareLanFilePersistent,
        requestLanFile,
        notifyLanFileConsumed,
        requestP2PRelayFile,
        removeSharedOffer,
        HTTP_URL,
        disconnect: closeConnection,
        lanServers, // Export
        switchLanHost: (id: string) => {
            const s = lanServers.value.get(id)
            if (s) {
                lanServerUrl.value = `http://${s.ip}:${s.httpPort}`
                ElMessage.info(`已切换到主机: ${s.name}`)
            }
        },
        smartSendFile, // Export
        smartRelaySendFile,
        // WebTransport LAN operations (bypass Mixed Content)
        listLanFilesWT,
        uploadLanFileWT,
        downloadLanFileWT,
        downloadLanRelayWT,
        downloadVpsRelayFile,
        openLanDownloadURL,
        downloadMode,
        setDownloadMode,
        isSpeedDownloadMode,
        getActiveLanServer,
        transferTelemetry,
        clearTransferTelemetry: resetTransferTelemetry,
    }
})
