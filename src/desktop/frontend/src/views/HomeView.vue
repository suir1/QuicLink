<script setup lang="ts">
import { CopyDocument, InfoFilled, Loading, Moon, Setting, Sunny, SwitchButton } from '@element-plus/icons-vue'
import { useDark, useToggle } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import QrcodeVue from 'qrcode.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useConnectionStore } from '../stores/connection'

// 暗黑模式
const isDark = useDark()
const toggleDark = useToggle(isDark)

// 引入功能组件
import ClipboardCard from '../components/ClipboardCard.vue'
import FilePanel from '../components/FilePanel.vue'
import NotepadPanel from '../components/NotepadPanel.vue'
import P2PFilePanel from '../components/P2PFilePanel.vue'

const route = useRoute()
const router = useRouter()
const conn = useConnectionStore()
// Make currentUrl reactive by depending on route.fullPath
const currentUrl = computed(() => {
  // Access route.fullPath to trigger reactivity
  const _ = route.fullPath
  // Construct the URL manually or use window.location.href (which should stay in sync with router checks)
  // Since we use Hash mode in desktop, window.location.href is correct, but needs the trigger.
  return window.location.href
})

// Server Configuration State
const savedHost = localStorage.getItem('custom_server_host')
const serverHost = ref(savedHost || import.meta.env.VITE_VPS_HOST || (window.location.protocol.startsWith('http') ? window.location.host : 'localhost:3100'))
const showSettings = ref(false)

function saveSettings() {
  if (!serverHost.value) {
    ElMessage.warning('服务器地址不能为空')
    return
  }
  localStorage.setItem('custom_server_host', serverHost.value)
  showSettings.value = false
  ElMessage.success({ message: '设置已保存，正在重连...', duration: 2000 })
  joinRoom()
}

// 子组件引用
const clipboardRef = ref()
const notepadRef = ref()

onMounted(async () => {
  // 0. Initialize Wails Events (Desktop Only)
  if (conn.isDesktop) {
    conn.setupDesktopEventListeners()
  }

  // NOTE: do NOT set conn.onClipboardData here.
  // ClipboardCard.vue sets it effectively. Overwriting it here breaks ID sync.


  // Check mode and join
  try {
    const mode = await conn.checkMode()
    if (mode === 'public') {
      // Public Mode: Join only if roomId is present (e.g. deep link?), otherwise show lobby
      // Note: In Wails, deep links might need extra handling, but for now we rely on user input in Lobby
      if (route.params.roomId) {
        joinRoom()
      } else {
        console.log("📍 Public Lobby: Waiting for user to select room. route.params.roomId is:", route.params.roomId)
        ElMessage.info(`Public Lobby (RoomID: ${route.params.roomId || 'None'})`)
      }
    } else if (mode === 'private') {
      console.log("🔒 Private Mode detected")
      // Private Mode: Join directly (root room)
      promptPassword()
    }
  } catch (e) {
      console.error(e)
      ElMessage.error('无法连接到服务器')
  }
})

// 监听 URL 变化
watch(() => route.params.roomId, (newId) => {
  if (conn.serverMode === 'public' && newId) joinRoom()
})

// 加入房间逻辑
function joinRoom() {
  const roomId = (route.params.roomId as string) || 'public'

  if (conn.isDesktop) {
    conn.connectDesktop(serverHost.value, roomId)
  } else {
    conn.connect(roomId)
  }
}

// Manual Join (Lobby)
const lobbyRoomId = ref('')
function enterLobbyRoom() {
  if (!lobbyRoomId.value) return
  router.push(`/${lobbyRoomId.value}`)
}

function enterRandomRoom() {
  const randomId = Math.random().toString(36).substring(2, 8)
  router.push(`/${randomId}`)
}

// 密码输入弹窗 (私有模式)
function promptPassword() {
  ElMessageBox.prompt('此服务器为私有模式，请输入访问密码', '身份验证', {
    confirmButtonText: '连接',
    cancelButtonText: '取消', // 可以设置为 false 强制输入
    inputType: 'password',
    closeOnClickModal: false,
    closeOnPressEscape: false,
    showCancelButton: false
  })
  .then((data: any) => {
    // Desktop or Web connection handled in connect/connectDesktop
    if (conn.isDesktop) {
        conn.connectDesktop(serverHost.value, 'root', data.value)
    } else {
        conn.connect('root', data.value)
    }
  })
  .catch(() => {
    ElMessage.warning('必须输入密码才能使用')
  })
}

// 退出房间
function leaveRoom() {
  conn.disconnect()
  // conn.currentRoom is cleared by disconnect/closeConnection logic inside store?
  // Actually check stored: closeConnection sets isConnected=false, but currentRoom might persist.
  // Ideally reset it. But store doesn't export setter. 'currentRoom' is ref, so it's mutable if returned.
  // Checking store return... Yes, currentRoom is returned as ref.
  conn.currentRoom = ''
  router.push('/')
}



// 复制当前页面链接
function copyLink() {
  navigator.clipboard.writeText(currentUrl.value)
  ElMessage.success('链接已复制，发给手机即可互联')
}
</script>

<template>
  <div class="app-container">

    <template v-if="conn.isConnected">
      <!-- 统一顶部栏: 状态 + QR码 + 主机状态 + 链接 -->
      <div class="top-toolbar">
        <!-- 房间状态 -->
        <div class="toolbar-item status-section">
          <el-tag v-if="conn.serverMode === 'private'" type="warning" effect="dark" size="large">
            🔒 私有隧道
          </el-tag>
          <el-tag v-else type="success" effect="dark" size="large">
            🌐 {{ conn.currentRoom }}
          </el-tag>
        </div>

        <!-- Setting Button -->
        <div class="toolbar-item settings-section">
           <el-tooltip content="服务器设置" placement="bottom">
             <el-button :icon="Setting" circle size="small" @click="showSettings = true" />
           </el-tooltip>
        </div>

        <!-- QR码 -->
        <div class="toolbar-item qr-section">
          <qrcode-vue :value="currentUrl" :size="60" level="M" background="#ffffff" foreground="#000000"/>
          <span class="qr-label">扫码互传</span>
        </div>

        <!-- 主机状态 -->
        <div class="toolbar-item host-section">
          <span class="host-label">PC:</span>
          <el-tag v-if="conn.hostOnline" type="success" size="small">在线</el-tag>
          <el-tag v-else type="info" size="small">离线</el-tag>
          <span v-if="conn.hostOnline" class="host-ip">{{ conn.hostIp }}</span>
        </div>

        <!-- 链接 -->
        <div class="toolbar-item link-section">
          <el-input v-model="currentUrl" readonly size="small" class="link-input">
            <template #append>
              <el-button :icon="CopyDocument" @click="copyLink" />
            </template>
          </el-input>
        </div>

        <!-- 退出房间 (仅在连接状态且在桌面端或公共模式下显示) -->
        <div class="toolbar-item exit-section" v-if="conn.isConnected">
          <el-button type="danger" :icon="SwitchButton" circle size="small" @click="leaveRoom" title="退出房间/断开连接" />
        </div>



        <!-- 主题切换 -->
        <div class="toolbar-item theme-section">
          <el-button
            :icon="isDark ? Moon : Sunny"
            circle
            size="small"
            @click="toggleDark()"
            :title="isDark ? '切换到亮色模式' : '切换到暗黑模式'"
          />
        </div>
      </div>

      <!-- 主内容区: 记事本 + 剪贴板侧栏 -->
      <div class="main-workspace">
        <div class="notepad-area">
          <NotepadPanel ref="notepadRef" />
        </div>
        <div class="clipboard-sidebar">
          <ClipboardCard ref="clipboardRef" />
        </div>
      </div>

      <!-- 文件面板区域 (仿照上方布局: 左侧中转, 右侧直传) -->
      <div class="file-workspace">
        <div class="file-area">
          <FilePanel />
        </div>
        <div class="p2p-sidebar">
          <P2PFilePanel />
        </div>
      </div>
    </template>

    <!-- Lobby UI (Public Mode, No Room Selected) -->
    <div v-else-if="conn.serverMode === 'public' && !route.params.roomId" class="lobby-state">
      <div class="lobby-header-controls">
           <el-tooltip content="服务器设置" placement="bottom">
             <el-button :icon="Setting" circle size="large" @click="showSettings = true" />
           </el-tooltip>
          <el-button
            :icon="isDark ? Moon : Sunny"
            circle
            size="large"
            @click="toggleDark()"
            :title="isDark ? '切换到亮色模式' : '切换到暗黑模式'"
          />
      </div>
      <h2>🌐 QuicLink Public Server</h2>
      <p>Create or join a temporary room to start sharing.</p>

      <div class="lobby-actions">
        <el-input
          v-model="lobbyRoomId"
          placeholder="Enter Room Name..."
          class="lobby-input"
          @keyup.enter="enterLobbyRoom"
        >
          <template #append>
            <el-button @click="enterLobbyRoom">Enter</el-button>
          </template>
        </el-input>

        <div class="divider">OR</div>

        <el-button type="primary" size="large" round @click="enterRandomRoom">
          🎲 Create Random Room
        </el-button>
      </div>

      <div class="lobby-footer">
        <el-icon><InfoFilled /></el-icon>
        Rooms are ephemeral and will be destroyed after 48h of inactivity.
      </div>
    </div>

    <div v-else class="loading-state">
      <el-icon class="is-loading" :size="40" color="#409eff"><Loading /></el-icon>
      <p>正在尝试连接服务器...</p>
    </div>

    <!-- Settings Dialog -->
    <el-dialog v-model="showSettings" title="服务器设置" width="400px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="服务器地址">
          <el-input v-model="serverHost" placeholder="例如: 192.168.1.100:8080 或 example.com" @keyup.enter="saveSettings">
          </el-input>
          <div style="font-size: 12px; color: #909399; margin-top: 5px;">
             支持 IP:Port 或域名。客户端会自动适配 HTTP/HTTPS。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="showSettings = false">取消</el-button>
          <el-button type="primary" @click="saveSettings">保存并重连</el-button>
        </span>
      </template>
    </el-dialog>

  </div>
</template>

<style scoped>
.app-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 15px;
}

/* 统一顶部工具栏 */
.top-toolbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 12px 20px;
  background: var(--toolbar-bg, linear-gradient(135deg, #f0f9eb 0%, #e8f5e9 100%));
  border-radius: 12px;
  margin-bottom: 20px;
  flex-wrap: wrap;
  border: 1px solid var(--toolbar-border, #c8e6c9);
  transition: all 0.3s;
}

/* 暗黑模式下覆盖变量 */
html.dark .top-toolbar {
  --toolbar-bg: var(--el-bg-color-overlay);
  --toolbar-border: var(--el-border-color-light);
}

.toolbar-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-section {
  flex-shrink: 0;
}

.qr-section {
  flex-shrink: 0;
}

.qr-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.host-section {
  flex-shrink: 0;
}

.host-label {
  font-size: 14px;
  color: var(--el-text-color-regular);
  font-weight: 500;
}

.host-ip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
}

.link-section {
  flex: 1;
  min-width: 200px;
}

.link-input {
  width: 100%;
}

/* 主工作区: 记事本 + 剪贴板侧栏 - 无缝连接 */
.main-workspace {
  display: flex;
  gap: 0; /* 无间距，无缝连接 */
  margin-bottom: 20px;
  height: 500px; /* 固定高度 */
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--el-box-shadow-light);
}

.notepad-area {
  flex: 2;
  min-width: 0;
  position: relative;
}

.clipboard-sidebar {
  flex: 1;
  min-width: 280px;
  max-width: 350px;
  border-left: 1px solid var(--el-border-color-light);
}

/* 底部文件工作区 (复用上方布局逻辑) */
.file-workspace {
  display: flex;
  gap: 0;
  height: 400px; /* 文件区域高度 */
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--el-box-shadow-light);
  margin-top: 20px;
  background-color: var(--el-bg-color-overlay);
}

.file-area {
  flex: 2;
  min-width: 0;
  position: relative;
  /* FilePanel 内部可能有 card，需要去边框以融合 */
}

/* 强制覆盖 FilePanel 的 Card 样式以适应组合布局 */
.file-area :deep(.el-card) {
  border: none;
  border-radius: 0;
  box-shadow: none;
  height: 100%;
}

.p2p-sidebar {
  flex: 1;
  min-width: 280px;
  max-width: 350px;
  border-left: 1px solid var(--el-border-color-light);
}

/* 强制覆盖 P2PFilePanel 的 Card 样式 */
.p2p-sidebar :deep(.el-card) {
  border: none;
  border-left: none; /* remove internal border if any */
  border-radius: 0;
  box-shadow: none;
  height: 100%;
}

/* 暗黑模式适配 */
html.dark .file-workspace {
  background-color: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-dark);
}

html.dark .p2p-sidebar {
  border-left-color: var(--el-border-color-light);
}

html.dark .clipboard-sidebar {
  border-left-color: var(--el-border-color-light);
}

/* 加载状态 */
.loading-state {
  text-align: center;
  margin-top: 100px;
}

.loading-state p {
  color: #606266;
  margin-top: 15px;
}

/* 响应式: 小屏幕堆叠布局 */
@media (max-width: 768px) {
  .top-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 15px;
  }

  .toolbar-item {
    justify-content: center;
  }

  .main-workspace {
    flex-direction: column;
  }

  .clipboard-sidebar, .p2p-sidebar {
    max-width: none;
    border-left: none;
    border-top: 1px solid #ebeef5;
  }

  .file-workspace {
    flex-direction: column;
    height: auto;
  }

  .file-area {
    height: 400px; /* 小屏幕固定高度 */
  }

  .p2p-sidebar {
    height: 400px;
  }
}
/* Dark Mode QR Code Inversion */
html.dark .qr-section :deep(canvas) { /* qrcode-vue renders canvas */
  filter: invert(1) hue-rotate(180deg);
  border: 4px solid #fff; /* Ensure it has a white border for scanning contrast */
  border-radius: 4px;
}

html.dark .qr-label {
  color: var(--el-text-color-secondary);
}

/* Lobby Styles */
.lobby-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 80vh;
  text-align: center;
  position: relative;
}

.lobby-header-controls {
  position: absolute;
  top: 20px;
  right: 20px;
  display: flex;
  gap: 10px;
}

.lobby-state h2 {
  font-size: 2rem;
  margin-bottom: 10px;
  background: linear-gradient(120deg, #409eff, #00c6ff);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.lobby-state p {
  color: var(--el-text-color-secondary);
  margin-bottom: 40px;
}

.lobby-actions {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.lobby-input .el-input__wrapper {
  padding: 5px 15px;
  border-radius: 20px 0 0 20px;
}

.divider {
  color: var(--el-text-color-placeholder);
  font-size: 14px;
  position: relative;
  margin: 10px 0;
}
.divider::before, .divider::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 45%;
  height: 1px;
  background: var(--el-border-color-light);
}
.divider::before { left: 0; }
.divider::after { right: 0; }

.lobby-footer {
  margin-top: 60px;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  opacity: 0.8;
}
</style>
