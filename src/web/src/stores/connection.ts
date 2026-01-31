import { ElMessage } from 'element-plus'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useConnectionStore = defineStore('connection', () => {
    const isConnected = ref(false)
    const socket = ref<WebSocket | null>(null)

    const currentRoom = ref('')
    const serverMode = ref('public') // 'public' | 'private'
    const hostOnline = ref(false)
    const hostIp = ref('')

    // ⚠️ 请换成你的 VPS IP
    const VPS_HOST = import.meta.env.VITE_VPS_HOST || 'localhost:8080'
    const HTTP_URL = `http://${VPS_HOST}`
    const WS_URL = `ws://${VPS_HOST}`

    // 1. 检查服务器模式
    async function checkMode() {
        try {
            const res = await fetch(`${HTTP_URL}/api/info`)
            const data = await res.json()
            serverMode.value = data.mode
            return data.mode
        } catch (e) {
            console.error("无法连接到服务器 API", e)
            ElMessage.error("服务器无法连接")
            return 'offline'
        }
    }

    // 2. 连接 (支持密码)
    function connect(roomId: string, password?: string) {
        if (socket.value) socket.value.close()

        currentRoom.value = roomId

        // 构建 URL
        let url = `${WS_URL}/ws?room=${roomId}`
        if (password) {
            url += `&token=${password}`
        }

        console.log('Connecting to:', url)
        socket.value = new WebSocket(url)

        socket.value.onopen = () => {
            isConnected.value = true
            ElMessage.success(serverMode.value === 'private' ? '已验证并连接' : `进入房间: ${roomId}`)
        }

        socket.value.onclose = (e) => {
            isConnected.value = false
            hostOnline.value = false
            // 如果是因为密码错误被踢 (Code 1006 或特定关闭码)
            if (!e.wasClean) {
                // 这里简单处理，实际可细分
                console.log("非正常断开", e)
            }
        }

        socket.value.onmessage = (event) => {
            handleMessage(event.data)
        }
    }

    function handleMessage(jsonStr: string) {
        try {
            const msg = JSON.parse(jsonStr)
            if (msg.type === 'register_host' || (msg.type === 'init' && msg.payload.hostInfo)) {
                hostOnline.value = true
                const info = msg.payload.hostInfo || msg.payload
                hostIp.value = info.ip
            }
        } catch (e) { }
    }

    return { isConnected, currentRoom, serverMode, hostOnline, hostIp, checkMode, connect }
})
