import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useConnectionStore = defineStore('connection', () => {
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
    const onLanEvent = ref<((type: string, data: any) => void) | null>(null)

    // P2P State
    const localFiles = ref<Map<string, File>>(new Map())
    const receivingFiles = ref<Map<string, { chunks: string[], total: number, received: number, name: string, type: string }>>(new Map())

    // WebRTC State (Phase 2b)
    // Key: remote peer id (or temporary just "peer" for 1-on-1 simplicity in demo)
    // In multi-user room, we need map<userId, RTCPeerConnection>. For now assuming 1 peer for simplicity or broadcast.
    // Let's use a single peer for the "Partner" model or just loop if needed.
    // For V1, let's keep it simple: We allow *one* P2P connection at a time or handle via map.
    // Given the room structure, let's try to be smart.
    const peerConnection = ref<RTCPeerConnection | null>(null)
    const dataChannel = ref<RTCDataChannel | null>(null)
    const isP2PConnected = ref(false)
    const RELAY_MAX_SIZE_BYTES = 10 * 1024 * 1024

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
        // Close WebRTC
        if (peerConnection.value) {
            peerConnection.value.close()
            peerConnection.value = null
        }
        dataChannel.value = null
        isP2PConnected.value = false
    }

    // --- WebRTC Logic (Phase 2b) ---
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ]
    }

    function setupPeerConnection() {
        if (peerConnection.value) return peerConnection.value

        const pc = new RTCPeerConnection(rtcConfig)

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendMessage({ type: 'candidate', payload: event.candidate })
            }
        }

        pc.onconnectionstatechange = () => {
            console.log('RTC State:', pc.connectionState)
            if (pc.connectionState === 'connected') {
                isP2PConnected.value = true
                ElMessage.success('⚡ P2P 直接连接已建立')
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                isP2PConnected.value = false
            }
        }

        pc.ondatachannel = (event) => {
            setupDataChannel(event.channel)
        }

        peerConnection.value = pc
        return pc
    }

    function setupDataChannel(dc: RTCDataChannel) {
        dc.onopen = () => {
            console.log('RTC DataChannel OPEN')
            dataChannel.value = dc
        }
        dc.onmessage = (e) => {
            // Handle P2P messages (files)
            handleP2PMessage(e.data)
        }
    }

    async function startP2P() {
        // Initiator
        console.log("⚡ Starting P2P Handshake...")
        const pc = setupPeerConnection()!
        const dc = pc.createDataChannel("file-transfer")
        setupDataChannel(dc)

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendMessage({ type: 'offer', payload: offer })
    }

    async function handleOffer(offer: RTCSessionDescriptionInit) {
        console.log("⚡ Received Offer, answering...")
        const pc = setupPeerConnection()!
        await pc.setRemoteDescription(new RTCSessionDescription(offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendMessage({ type: 'answer', payload: answer })
    }

    async function handleAnswer(answer: RTCSessionDescriptionInit) {
        console.log("⚡ Received Answer")
        const pc = peerConnection.value
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(answer))
        }
    }

    async function handleCandidate(candidate: RTCIceCandidateInit) {
        const pc = peerConnection.value
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
        }
    }

    async function waitForP2PReady(timeoutMs = 2500): Promise<boolean> {
        if (isP2PConnected.value) return true
        if (!isConnected.value) return false

        if (!peerConnection.value) {
            try {
                await startP2P()
            } catch (e) {
                console.warn('P2P bootstrap failed', e)
                return false
            }
        }

        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (isP2PConnected.value) return true
            await new Promise(r => setTimeout(r, 100))
        }
        return isP2PConnected.value
    }

    // P2P File Sending (Stream via Chunking over DC)
    async function sendFileP2P(file: File) {
        if (!dataChannel.value || dataChannel.value.readyState !== 'open') throw new Error("No Data Channel")

        // 1. Send Meta
        const id = `${Date.now()}-${file.name}`
        const meta = JSON.stringify({
            type: 'meta',
            id,
            name: file.name,
            size: file.size,
            mime: file.type
        })
        dataChannel.value.send(meta)

        // 2. Send Chunks
        const CHUNK_SIZE = 16 * 1024 // Safe MTU
        const total = Math.ceil(file.size / CHUNK_SIZE)

        let sent = 0
        for (let i = 0; i < total; i++) {
            const start = i * CHUNK_SIZE
            const end = Math.min(start + CHUNK_SIZE, file.size)
            const chunk = file.slice(start, end)
            const buffer = await chunk.arrayBuffer()

            // Check buffer level to avoid flooding
            while (dataChannel.value.bufferedAmount > 10 * 1024 * 1024) {
                await new Promise(r => setTimeout(r, 50))
            }

            dataChannel.value.send(buffer)
            sent++

            // Optional: Send progress event locally or via channel?
            // For now, assume receiver tracks it
        }

        console.log(`✅ P2P Send Complete: ${file.name}`)
    }

    // Handle Incoming P2P Data
    // We need a state machine because messages are ordered on DC
    let incomingFile: {
        id: string, name: string, size: number, received: number, buffer: Blob[]
    } | null = null

    function handleP2PMessage(data: any) {
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data)
                if (msg.type === 'meta') {
                    // Start new file
                    incomingFile = {
                        id: msg.id,
                        name: msg.name,
                        size: msg.size,
                        received: 0,
                        buffer: []
                    }
                    console.log(`📥 P2P Incoming File: ${msg.name}`)

                    if (onP2PEvent.value) {
                        onP2PEvent.value('offer', {
                            id: msg.id,
                            name: msg.name,
                            size: msg.size,
                            type: msg.mime,
                            isLan: false, // It's P2P
                            isP2P: true
                        })
                    }
                }
            } catch (e) { }
        } else if (data instanceof ArrayBuffer) {
            // Binary Chunk
            if (!incomingFile) return

            incomingFile.buffer.push(new Blob([data]))
            incomingFile.received += data.byteLength

            // Update UI Progress
            if (onP2PEvent.value) {
                onP2PEvent.value('progress', {
                    id: incomingFile.id,
                    received: incomingFile.received,
                    total: incomingFile.size
                })
            }

            // Check Complete
            if (incomingFile.received >= incomingFile.size) {
                const blob = new Blob(incomingFile.buffer)
                const url = URL.createObjectURL(blob)
                // Auto download or let UI handle?
                // For now, simple auto download trigger
                const a = document.createElement('a')
                a.href = url
                a.download = incomingFile.name
                a.click()
                URL.revokeObjectURL(url)

                incomingFile = null
                ElMessage.success('WebRTC P2P 传输完成! 🚀')
            }
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
            payload: { id: fileId }
        })
    }

    async function handleP2PRelayRequest(fileId: string) {
        const file = localFiles.value.get(fileId)
        if (!file) return

        const fallbackToWebRTC = async (reason: string) => {
            console.warn(`LAN relay unavailable (${reason}), auto fallback to WebRTC for ${file.name}`)
            if (await waitForP2PReady()) {
                try {
                    await sendFileP2P(file)
                    ElMessage.warning(`LAN中转失败，已自动切换 WebRTC: ${file.name}`)
                    return
                } catch (e) {
                    console.warn('WebRTC direct send failed after LAN relay failure', e)
                }
            }

            // Keep a final fallback for delivery success when WebRTC cannot be established.
            shareFile(file)
            ElMessage.warning(`LAN中转失败，WebRTC不可用，已切换 VPS 中转: ${file.name}`)
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
                        status: 'ready'
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
            payload: { id: fileId }
        })
        console.log(`📥 Requesting LAN file: ${fileId}`)
    }

    // Handle lan_file_request: upload file to desktop LAN server on demand
    async function handleLanFileRequest(fileId: string) {
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
                        isRelay: true
                    }
                })
            }

            if (activeLanServer.h3Port && activeLanServer.certHash) {
                await uploadToLanRelayWT(file, activeLanServer, relayId, sendLanReady)
                // Backward compatibility: if older desktop doesn't return WT ready ack line.
                sendLanReady()
                ElMessage.success(`✅ ${file.name} 就绪 (LAN 中转)`)
                return
            }

            if (activeLanServer.httpPort && window.location.protocol !== 'https:') {
                uploadToLanRelay(file, activeLanServer, relayId).catch(e => {
                    console.error("HTTP Relay Upload Aborted", e)
                })
                // HTTP relay has no explicit ready ack; send ready once upload request starts.
                sendLanReady()
                ElMessage.success(`✅ ${file.name} 就绪 (LAN 中转)`)
                return
            } else {
                if (window.location.protocol === 'https:') {
                    ElMessage.warning('当前为 HTTPS 页面，HTTP 中转被浏览器拦截；请确保 LAN WebTransport 可用')
                } else {
                    ElMessage.error('没有可用的 LAN 中转通道')
                }
                return
            }
        } catch (e) {
            console.error('Failed to upload on demand', e)
            ElMessage.error('上传失败')
        }
    }

    async function uploadToLanRelay(file: File, server: LanServerInfo, relayId: string) {
        // This request will BLOCK until the receiver connects!
        // or until server times out (we rely on server timeout)
        console.log(`🚀 Starting Relay Stream: ${relayId}`)
        const relayUrl = `http://${server.ip}:${server.httpPort}/api/lan/relay/upload/${relayId}?name=${encodeURIComponent(file.name)}`
        const res = await fetch(relayUrl, {
            method: 'POST',
            body: file
        })
        if (!res.ok) throw new Error(`Relay error: ${res.statusText}`)
        console.log(`✅ Relay Stream Complete: ${relayId}`)
    }

    async function uploadToLanRelayWT(
        file: File,
        server: LanServerInfo,
        relayId: string,
        onReady?: () => void,
        readyTimeoutMs = 8000
    ) {
        if (!server.h3Port || !server.certHash) throw new Error('LAN WT unavailable')

        console.log(`🚀 Starting WT Relay Stream: ${relayId}`)
        const wt = await createLanWT(server)
        const stream = await wt.createBidirectionalStream()
        const writer = stream.writable.getWriter()
        const reader = stream.readable.getReader()

        const cmd = JSON.stringify({
            action: 'relay_upload',
            relayId,
            name: file.name,
            size: file.size
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
            throw new Error('WT relay ready response missing')
        }
        if (readyResp?.status === 'ready' && onReady) onReady()

        await streamFileToWriter(file, writer)
        await writer.close()
        wt.close()
    }

    async function uploadToLanWT(file: File, server: LanServerInfo): Promise<string | null> {
        const url = `https://${server.ip}:${server.h3Port}/wt`
        const hashBytes = decodeCertHashBase64(server.certHash!)
        const wt = new WebTransport(url, {
            serverCertificateHashes: [{ algorithm: 'sha-256', value: hashBytes.buffer }]
        })
        await wt.ready
        const stream = await wt.createBidirectionalStream()
        const writer = stream.writable.getWriter()
        const reader = stream.readable.getReader()

        const cmd = JSON.stringify({ action: 'upload', name: file.name, size: file.size }) + '\n'
        await writer.write(new TextEncoder().encode(cmd))
        await streamFileToWriter(file, writer)
        await writer.close()

        const resp = await readJsonResponse(reader)
        wt.close()
        if (resp) {
            if (resp.status === 'ok') return resp.file.id
        }
        return null
    }

    async function uploadToLanHTTP(file: File, server: LanServerInfo): Promise<string | null> {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch(`http://${server.ip}:${server.httpPort}/api/lan/upload`, {
            method: 'POST', body: formData
        })
        if (res.ok) {
            const data = await res.json()
            return data.id
        }
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
            const formData = new FormData()
            formData.append('file', file)
            const res = await fetch(`${HTTP_URL.value}/upload`, {
                method: 'POST',
                body: formData
            })
            if (!res.ok) return null

            const data = await res.json()
            if (!data?.url) return null

            const absoluteUrl = data.url.startsWith('http')
                ? data.url
                : `${HTTP_URL.value}${data.url}`

            return {
                id: `cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: data.name || file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
                url: absoluteUrl,
                mode: 'netdisk'
            }
        } catch (e) {
            console.error('Cloud upload failed', e)
            return null
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
        await wt.ready
        return wt
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
        writer: WritableStreamDefaultWriter<Uint8Array>
    ): Promise<void> {
        const reader = file.stream().getReader()
        try {
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (!value) continue
                await writer.write(toArrayBufferBytes(value))
            }
        } finally {
            reader.releaseLock()
        }
    }

    async function saveWTDownloadToFile(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        fallbackName: string
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
                        if (streamSaver) {
                            await streamSaver.write(rest)
                        } else {
                            chunks.push(rest)
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
                    await streamSaver.write(chunk)
                } else {
                    chunks.push(chunk)
                }
            }
        }

        if (!metaReceived) {
            console.error('WT download ended before metadata was received')
            return false
        }

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
            try {
                const wt = await createLanWT(server)
                const stream = await wt.createBidirectionalStream()
                const writer = stream.writable.getWriter()
                const reader = stream.readable.getReader()

                const cmd = JSON.stringify({ action: 'upload', name: file.name, size: file.size }) + '\n'
                await writer.write(new TextEncoder().encode(cmd))
                await streamFileToWriter(file, writer)
                await writer.close()

                const resp = await readJsonResponse(reader)
                wt.close()
                if (resp && resp.status === 'ok') return resp.file
            } catch (e) {
                console.warn('LAN WT upload failed, falling back to HTTP', e)
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
        const server = getActiveLanServer()
        if (!server?.h3Port || !server?.certHash) return false

        try {
            const wt = await createLanWT(server)
            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            await writer.write(new TextEncoder().encode(
                JSON.stringify({ action: 'download', fileId }) + '\n'
            ))
            await writer.close()
            const ok = await saveWTDownloadToFile(reader, fileName)
            wt.close()
            return ok
        } catch (e) {
            console.error('WT download failed', e)
            return false
        }
    }

    async function downloadLanRelayWT(
        relayId: string,
        fileName: string,
        ip?: string,
        h3Port?: number,
        certHashVal?: string
    ): Promise<boolean> {
        const activeServer = getActiveLanServer()
        const targetIp = ip || activeServer?.ip
        const targetH3Port = h3Port || activeServer?.h3Port
        const targetCertHash = certHashVal || activeServer?.certHash
        if (!targetIp || !targetH3Port || !targetCertHash) return false

        try {
            const wt = await createLanWTByAddress(targetIp, targetH3Port, targetCertHash)
            const stream = await wt.createBidirectionalStream()
            const writer = stream.writable.getWriter()
            const reader = stream.readable.getReader()

            await writer.write(new TextEncoder().encode(
                JSON.stringify({ action: 'relay_download', relayId }) + '\n'
            ))
            await writer.close()

            const ok = await saveWTDownloadToFile(reader, fileName)
            wt.close()
            return ok
        } catch (e) {
            console.error('WT relay download failed', e)
            return false
        }
    }

    // Relay-first send chain for P2PFilePanel (no LAN host disk persistence).
    async function smartRelaySendFile(file: File) {
        const activeLanServer = getActiveLanServer()
        if (activeLanServer) {
            shareP2PRelayFile(file)
            ElMessage.success('📡 已发布 LAN 中转任务，等待对方下载')
            return
        }

        if (await waitForP2PReady()) {
            await sendFileP2P(file)
            ElMessage.success('⚡ 已通过 WebRTC P2P 发送')
            return
        }

        if (file.size <= RELAY_MAX_SIZE_BYTES) {
            shareFile(file)
            ElMessage.info('已切换 VPS Relay 中转')
            return
        }

        ElMessage.error('当前仅支持中转不落盘：请先确保 LAN 主机在线或降低文件大小')
        throw new Error('No relay-only path available')
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
        if (file.size <= RELAY_MAX_SIZE_BYTES) {
            console.log("🔄 Smart Send: Falling back to VPS Relay")
            shareFile(file)
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
        const url = `https://${server.ip}:${server.h3Port}/wt`

        // Decode base64 cert hash to ArrayBuffer
        const hashBytes = decodeCertHashBase64(server.certHash!)

        const wt = new WebTransport(url, {
            serverCertificateHashes: [{
                algorithm: 'sha-256',
                value: hashBytes.buffer
            }]
        })

        await wt.ready
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
        if (response) {
            if (response.status === 'ok') {
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
                wt.close()
                return true
            }
        }

        wt.close()
        return false
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
                    handleOffer(msg.payload)
                    break
                case 'answer':
                    handleAnswer(msg.payload)
                    break
                case 'candidate':
                    handleCandidate(msg.payload)
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

                    // Trigger P2P Handshake if we are "older" or just random?
                    // Simple: Both try, WebRTC handles glare using 'polite' peer pattern, or just let Initiator be the one sending file?
                    // Better: Auto-connect mesh.
                    if (!peerConnection.value) {
                        startP2P()
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
                    handleLanFileRequest(msg.payload.id)
                    break

                case 'lan_file_ready':
                    console.log('LAN File Ready:', msg.payload)
                    // File has been uploaded to desktop, ready to download
                    if (onLanEvent.value) {
                        onLanEvent.value('lan_ready', msg.payload)
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
                    handleP2PRelayRequest(msg.payload.id)
                    break

                case 'p2p_relay_ready':
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
        onP2PEvent,
        onLanEvent, // Export
        shareFile,
        requestFile,
        shareLanFile,
        shareLanFilePersistent,
        requestLanFile,
        requestP2PRelayFile,
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
        getActiveLanServer,
    }
})
