import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useConnectionStore = defineStore('connection', () => {
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

    // 环境变量处理
    const VPS_HOST = import.meta.env.VITE_VPS_HOST || 'localhost:8080'
    // WebTransport 强制使用 HTTPS
    const PROTOCOL = window.location.protocol === 'https:' ? 'https:' : 'https:'
    const HTTP_URL = `${PROTOCOL}//${VPS_HOST}`
    const WT_URL = `${PROTOCOL}//${VPS_HOST}`

    // --- 回调函数钩子 ---
    const onClipboardData = ref<((text: string) => void) | null>(null)
    const onNotepadEvent = ref<((type: string, data: any) => void) | null>(null)

    // --- 1. 检查服务器模式 ---
    async function checkMode() {
        try {
            const res = await fetch(`${HTTP_URL}/api/info`)
            const data = await res.json()
            serverMode.value = data.mode
            return data.mode
        } catch (e) {
            console.error("无法连接到服务器 API", e)
            return 'offline'
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
                let url = `${WT_URL}/wt?room=${roomId}`
                if (password) url += `&token=${password}`

                const wt = new WebTransport(url)
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
                console.warn("❌ WebTransport failed, falling back to WebSocket", e)
                ElMessage.warning("HTTP/3 连接失败，正在尝试降级 WebSocket...")
            }
        }

        // 降级：WebSocket
        connectWebSocket(roomId, password)
    }

    function connectWebSocket(roomId: string, password?: string) {
        let url = `${HTTP_URL.replace('http', 'ws')}/ws?room=${roomId}`
        if (password) url += `&token=${password}`

        console.log(`🔄 Attempting WebSocket to [${roomId}]...`)
        const ws = new WebSocket(url)
        socket.value = ws

        ws.onopen = () => {
            isConnected.value = true
            ElMessage.success(`✅ 已通过 WebSocket 加入房间: ${roomId}`)
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

        // WebSocket 发送
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
            socket.value.send(jsonStr)
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
                    if (msg.type === 'init' && msg.payload.notes && onNotepadEvent.value) {
                        onNotepadEvent.value('init', msg.payload.notes)
                    }
                    break

                case 'notepad_update':
                case 'notepad_delete':
                    if (onNotepadEvent.value) onNotepadEvent.value(msg.type, msg.payload)
                    break

                case 'clipboard_data':
                case 'clipboard_push': // 接收其它端的剪切板推送
                    if (msg.payload && onClipboardData.value) {
                        // 兼容新版：统一从 payload.text 取
                        onClipboardData.value(msg.payload.text)
                    }
                    break

                case 'offer':
                case 'answer':
                case 'candidate':
                    // WebRTC 信令，暂不处理或交给专用的 store
                    break
            }
        } catch (e) {
            console.error("消息解析失败", e, jsonStr)
        }
    }

    return {
        isConnected,
        currentRoom,
        serverMode,
        hostOnline,
        hostIp,
        checkMode,
        connect,
        sendMessage,
        onClipboardData,
        onNotepadEvent
    }
})
