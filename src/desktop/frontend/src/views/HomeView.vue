<script setup lang="ts">
import { CopyDocument, Loading, Moon, Sunny } from '@element-plus/icons-vue'
import { useDark, useToggle } from '@vueuse/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import QrcodeVue from 'qrcode.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useConnectionStore } from '../stores/connection'

// 暗黑模式
const isDark = useDark()
const toggleDark = useToggle(isDark)

// 引入功能组件 (请确保这些文件存在于 components 目录下)
import ClipboardCard from '../components/ClipboardCard.vue'
import FilePanel from '../components/FilePanel.vue'
import NotepadPanel from '../components/NotepadPanel.vue'
import P2PFilePanel from '../components/P2PFilePanel.vue'

const route = useRoute()
const conn = useConnectionStore()
const currentUrl = computed(() => window.location.href)

// 子组件引用 (用于调用子组件的方法)
const clipboardRef = ref()
const notepadRef = ref()

onMounted(async () => {
  // 1. 注册 Store 的回调函数 -> 绑定到子组件的方法上
  // 当 Store 收到消息时，会调用这些函数更新 UI
  conn.onClipboardData = (text) => {
    clipboardRef.value?.updateText(text)
  }

  // Setup desktop event listeners if in Wails
  conn.setupDesktopEventListeners()

  // 2. 检查服务器模式并加入
  try {
    const mode = await conn.checkMode()
    if (mode === 'public') {
      joinRoom()
    } else if (mode === 'private') {
      promptPassword()
    }
  } catch (e) {
    // 桌面端: Go 后端处理 TLS，不需要用户信任证书
    if (conn.isDesktop) {
      ElMessage.error('无法连接到服务器，请检查服务器是否启动')
      return
    }

    // Web 端: 提示用户信任证书
    ElMessageBox.confirm(
      '无法连接到服务器。如果是自签名证书，请点击下方链接并在浏览器中选择 "继续前往" 或 "信任此证书"，然后刷新本页。',
      '连接失败',
      {
        confirmButtonText: '去信任证书',
        cancelButtonText: '重试',
        type: 'warning',
        center: true
      }
    ).then(() => {
      // 在新标签页打开 API 地址
      window.open(`${conn.HTTP_URL}/api/info`, '_blank')
    }).catch(() => {
      location.reload()
    })
  }
})

// 监听 URL 变化 (仅公共模式下允许随意切换房间)
watch(() => route.params.roomId, () => {
  if (conn.serverMode === 'public') joinRoom()
})

// 加入房间逻辑
function joinRoom() {
  const roomId = (route.params.roomId as string) || 'public'

  // Use desktop connect method if in Wails
  if (conn.isDesktop) {
    const host = import.meta.env.VITE_VPS_HOST || 'localhost:8080'
    conn.connectDesktop(host, roomId)
  } else {
    conn.connect(roomId)
  }
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
    // 私有模式下房间名不重要，统一用 'root'
    conn.connect('root', data.value)
  })
  .catch(() => {
    ElMessage.warning('必须输入密码才能使用')
  })
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

    <div v-else class="loading-state">
      <el-icon class="is-loading" :size="40" color="#409eff"><Loading /></el-icon>
      <p>正在尝试连接服务器...</p>
    </div>

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
</style>
