import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useConnectionStore = defineStore('connection', () => {
    // --- 状态定义 ---
    const isConnected = ref(false)
    const socket = ref<WebSocket | null>(null)

    const currentRoom = ref('')
    const serverMode = ref('public') // 'public' | 'private'
    const hostOnline = ref(false)    // C++ Host 是否在线
    const hostIp = ref('')           // C++ Host 的局域网 IP

    // 环境变量处理 (如果在本地开发且没有 .env，回退到 localhost)
    const VPS_HOST = import.meta.env.VITE_VPS_HOST || 'localhost:8080'
    const HTTP_URL = `http://${VPS_HOST}`
    const WS_URL = `ws://${VPS_HOST}`

    // --- 回调函数钩子 (用于通知 UI 组件更新) ---
    // 组件挂载时会把自己的 update 函数注册到这里
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
            ElMessage.error("连接服务器失败，请检查网络或后端状态")
            return 'offline'
        }
    }

    // --- 2. 建立 WebSocket 连接 ---
    function connect(roomId: string, password?: string) {
        // 防止重复连接
        if (socket.value) {
            socket.value.close()
        }

        currentRoom.value = roomId

        // 构建带参数的 URL
        let url = `${WS_URL}/ws?room=${roomId}`
        if (password) {
            url += `&token=${password}`
        }

        console.log(`🔗 Connecting to [${roomId}]...`)
        socket.value = new WebSocket(url)

        socket.value.onopen = () => {
            isConnected.value = true
            const msg = serverMode.value === 'private'
                ? '🔒 已建立加密连接'
                : `✅ 已加入房间: ${roomId}`
            ElMessage.success(msg)
        }

        socket.value.onclose = (e) => {
            isConnected.value = false
            hostOnline.value = false
            // 如果是非正常关闭 (如密码错误被踢)
            if (!e.wasClean) {
                console.warn("连接非正常断开", e)
                if (e.code === 1006) {
                    // 1006 通常是网络问题或鉴权失败
                    ElMessage.warning('连接断开 (可能是网络问题或密码错误)')
                }
            }
        }

        socket.value.onmessage = (event) => {
            handleMessage(event.data)
        }
    }

    // --- 3. 通用发送消息函数 ---
    function sendMessage(data: any) {
        if (socket.value && socket.value.readyState === WebSocket.OPEN) {
            socket.value.send(JSON.stringify(data))
        } else {
            console.warn('WebSocket not connected, dropping message', data)
        }
    }

    function handleMessage(jsonStr: string) {
        try {
            const msg = JSON.parse(jsonStr)

            switch (msg.type) {
                // 初始化 / Host 上线
                case 'init':
                case 'register_host':
                    // 处理 Host 信息
                    const info = msg.type === 'init' ? msg.payload.hostInfo : msg.payload
                    if (info) {
                        hostOnline.value = true
                        hostIp.value = info.ip
                        if (msg.type === 'register_host') ElMessage.success(`主机 [${info.ip}] 已上线`)
                    }

                    // 处理历史记事本内容 (列表)
                    if (msg.type === 'init' && msg.payload.notes && onNotepadEvent.value) {
                        onNotepadEvent.value('init', msg.payload.notes)
                    }
                    break

                // 记事本事件 (更新/删除)
                case 'notepad_update':
                case 'notepad_delete':
                    if (onNotepadEvent.value) {
                        onNotepadEvent.value(msg.type, msg.payload)
                    }
                    break

                // 剪切板数据回传
                case 'clipboard_data':
                    if (onClipboardData.value) {
                        onClipboardData.value(msg.payload.text)
                    }
                    break
            }
        } catch (e) {
            console.error("消息解析失败", e)
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
