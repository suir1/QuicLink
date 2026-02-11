<script setup lang="ts">
import { Close, Document, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

const conn = useConnectionStore()

interface P2PFile {
  id: string
  relayId?: string
  originalId?: string
  name: string
  size: number
  type: string
  fromSelf: boolean
  progress?: number
  isLan?: boolean
  baseUrl?: string
  isNetdisk?: boolean
  netdiskUrl?: string
  isVpsRelay?: boolean
  vpsRelayUrl?: string
  isRelay?: boolean
  relayStatus?: 'pending' | 'requesting' | 'ready'
  lanFileId?: string
  ip?: string
  httpPort?: number
  h3Port?: number
  certHash?: string
}

const fileList = ref<P2PFile[]>([])
const transfer = computed(() => conn.transferTelemetry)

const transferPathLabel = computed(() => {
  const path = transfer.value?.path
  switch (path) {
    case 'lan-go-relay': return 'LAN Go Relay'
    case 'lan-wt-relay': return 'LAN WT Relay'
    case 'lan-http-relay': return 'LAN HTTP Relay'
    case 'lan-wt-direct': return 'LAN WT Direct'
    case 'lan-http-direct': return 'LAN HTTP Direct'
    case 'webrtc': return 'WebRTC'
    case 'vps-relay': return 'VPS Relay'
    case 'browser-url': return 'Browser URL'
    case 'cloud': return 'Cloud'
    default: return 'N/A'
  }
})

const transferStatusLabel = computed(() => {
  const status = transfer.value?.status || 'idle'
  switch (status) {
    case 'active': return '传输中'
    case 'done': return '完成'
    case 'handoff': return '已交给系统下载'
    case 'error': return '失败'
    default: return '空闲'
  }
})

const transferSpeedText = computed(() => {
  const bps = Number(transfer.value?.speedBps || 0)
  if (bps <= 0) return '--'
  const mbps = bps / (1024 * 1024)
  return `${mbps.toFixed(mbps >= 10 ? 1 : 2)} MB/s`
})

const transferProgressText = computed(() => {
  const bytes = Number(transfer.value?.bytes || 0)
  const total = Number(transfer.value?.total || 0)
  if (!bytes && !total) return '--'
  return `${formatSize(bytes)} / ${total > 0 ? formatSize(total) : '未知'}`
})

const transferUploadViaText = computed(() => {
  const via = String((transfer.value as any)?.uploadVia || '').trim()
  return via ? via.toUpperCase() : '--'
})

const transferNoteText = computed(() => {
  const note = String(transfer.value?.note || '').trim()
  return note || '--'
})

// 格式化文件大小
function formatSize(bytes: number) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return (bytes / Math.pow(k, i)).toPrecision(3) + ' ' + sizes[i]
}

// 监听 Drag & Drop
function handleDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  processFiles(files, 'drop')
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    processFiles(input.files, 'input')
  }
  input.value = '' // reset
}

async function triggerUpload() {
  if (conn.isDesktop && conn.pickNativeRelayFiles) {
    const picked = await conn.pickNativeRelayFiles()
    if (picked.length > 0) {
      processNativeFiles(picked)
      return
    }
  }
  document.getElementById('p2p-file-input')?.click()
}

function processFiles(files: FileList, source: 'drop' | 'input' = 'input') {
  let skippedNoPath = 0
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file) continue

    const nativePath = (file as any)?.path
    if (conn.isDesktop && (!nativePath || typeof nativePath !== 'string')) {
      skippedNoPath++
      continue
    }

    conn.smartRelaySendFile(file, typeof nativePath === 'string' && nativePath ? nativePath : undefined).catch((e: any) => {
      console.error('Relay-only send failed', e)
    })
    addFileToList({
      id: 'local-' + Date.now(),
      name: file.name,
      size: file.size,
      type: file.type,
      fromSelf: true
    })
  }

  if (conn.isDesktop && skippedNoPath > 0) {
    const msg = source === 'drop'
      ? `已跳过 ${skippedNoPath} 个拖拽文件：当前环境无法获取本地路径，请点击下方按钮使用原生文件选择器`
      : `已跳过 ${skippedNoPath} 个文件：当前环境无法获取本地路径`
    ElMessage.warning(msg)
  }
}

function processNativeFiles(files: Array<{ path: string; name: string; size: number; type?: string }>) {
  for (const file of files) {
    conn.smartRelaySendNativeFile(file).catch((e: any) => {
      console.error('Native relay send failed', e)
    })
    addFileToList({
      id: 'local-' + Date.now(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      fromSelf: true
    })
  }
}

function addFileToList(file: P2PFile) {
  fileList.value.push(file)
  // 自动滚动到底部
  setTimeout(() => {
    const container = document.querySelector('.p2p-list')
    if (container) container.scrollTop = container.scrollHeight
  }, 100)
}

async function handleDownload(file: P2PFile) {
  if (file.fromSelf) return

  if (file.isRelay) {
    if (!file.lanFileId || file.relayStatus !== 'ready') {
      file.relayStatus = 'requesting'
      conn.requestP2PRelayFile(file.id)
      ElMessage.info('已请求发送方启动 LAN 中转，请稍候...')
      return
    }

    if (conn.isDesktop) {
      const nativeOk = await conn.downloadLanRelayNative(
        file.lanFileId,
        file.name,
        file.ip,
        file.httpPort
      )
      if (nativeOk) {
        ElMessage.success(`下载完成: ${file.name} (Go Native Relay)`)
        return
      }
    }

    try {
      const ok = await conn.downloadLanRelayWT(
        file.lanFileId,
        file.name,
        file.ip,
        file.h3Port,
        file.certHash
      )
      if (ok) {
        ElMessage.success(`下载完成: ${file.name} (WT Relay)`)
        return
      }
    } catch (e) {
      console.warn('WT relay download failed, fallback to HTTP', e)
    }

    if (conn.downloadLanRelayHTTP(file.lanFileId, file.name, file.ip, file.httpPort)) {
      ElMessage.info(`已切换 HTTP Relay 下载: ${file.name}`)
      return
    }
    ElMessage.error('无法获取中转下载地址')
    return
  }

  if (file.isVpsRelay && file.vpsRelayUrl) {
    window.open(file.vpsRelayUrl, '_blank')
    ElMessage.info(`正在 VPS 中转下载: ${file.name}`)
    return
  }

  if (file.isNetdisk && file.netdiskUrl) {
    window.open(file.netdiskUrl, '_blank')
    ElMessage.info(`正在云端下载: ${file.name}`)
    return
  }

  if (file.isLan) {
    const baseUrl = file.baseUrl || conn.lanServerUrl
    if (baseUrl) {
      window.open(`${baseUrl}/api/lan/download/${file.id}`, '_blank')
      ElMessage.info(`正在 LAN 直连下载: ${file.name}`)
      return
    }
  }

  ElMessage.info('开始请求下载...')
  conn.requestFile(file.id)
}

onMounted(() => {
  if (conn.onP2PEvent) console.warn('onP2PEvent already bound?')

  // 绑定 Store 事件
  conn.onP2PEvent = (type: string, payload: any) => {
    if (type === 'offer') {
      if (payload.isVpsRelay && payload.originalId) {
        const existing = fileList.value.find(f => f.id === payload.originalId)
        if (existing) {
          const autoDownload = existing.relayStatus === 'requesting'
          existing.isRelay = false
          existing.relayStatus = undefined
          existing.isVpsRelay = true
          existing.id = payload.id || existing.id
          existing.relayId = payload.relayId || payload.id || existing.relayId
          existing.originalId = payload.originalId
          existing.vpsRelayUrl = payload.url
          existing.name = payload.name || existing.name
          existing.size = Number(payload.size || existing.size)
          existing.type = payload.type || existing.type
          if (autoDownload) {
            void handleDownload(existing)
          }
          return
        }
      }

      // 收到别人分享的文件
      addFileToList({
        id: payload.id,
        relayId: payload.relayId,
        originalId: payload.originalId,
        name: payload.name,
        size: payload.size,
        type: payload.type,
        fromSelf: false,
        isLan: payload.isLan,
        baseUrl: payload.baseUrl,
        isNetdisk: payload.isNetdisk,
        netdiskUrl: payload.url,
        isVpsRelay: payload.isVpsRelay,
        vpsRelayUrl: payload.url,
        isRelay: payload.isRelay,
        relayStatus: payload.isRelay ? (payload.status || 'pending') : undefined,
        lanFileId: payload.lanFileId,
        ip: payload.ip,
        httpPort: payload.httpPort,
        h3Port: payload.h3Port,
        certHash: payload.certHash
      })
    } else if (type === 'relay_ready') {
      const item = fileList.value.find(f => f.id === payload.originalId)
      if (item) {
        const autoDownload = item.relayStatus === 'requesting'
        item.relayStatus = 'ready'
        item.lanFileId = payload.lanFileId
        item.ip = payload.ip
        item.httpPort = payload.httpPort
        item.h3Port = payload.h3Port
        item.certHash = payload.certHash
        if (autoDownload) {
          void handleDownload(item)
        }
      }
      ElMessage.success(`📥 ${payload.name} 已就绪，可开始下载`)
    } else if (type === 'progress') {
      // payload: { id, received, total }
      const item = fileList.value.find(f => f.id === payload.id)
      if (item) {
        item.progress = includePercentage(payload.received, payload.total)
      }
    } else if (type === 'relay_ack') {
      const relayId = payload?.relayId
      if (!relayId) return
      const item = fileList.value.find(f => f.id === relayId || f.relayId === relayId)
      if (item && item.fromSelf && item.isVpsRelay) {
        item.progress = 100
      }
    }
  }
})

function includePercentage(received: number, total: number) {
  return Math.floor((received / total) * 100)
}

function deleteFile(index: number) {
  fileList.value.splice(index, 1)
}
</script>

<template>
  <el-card class="p2p-card" body-style="display: flex; flex-direction: column; height: 100%; padding: 0;" shadow="never">
    <template #header>
      <div class="card-header">
        <span>⚡ 局域网直传</span>
        <el-tag size="small" type="success" effect="plain">P2P Stream</el-tag>
      </div>
    </template>

    <div class="transfer-diagnostics">
      <span class="diag-item"><strong>通道:</strong> {{ transferPathLabel }}</span>
      <span class="diag-item"><strong>状态:</strong> {{ transferStatusLabel }}</span>
      <span class="diag-item"><strong>上传协议:</strong> {{ transferUploadViaText }}</span>
      <span class="diag-item"><strong>速率:</strong> {{ transferSpeedText }}</span>
      <span class="diag-item"><strong>进度:</strong> {{ transferProgressText }}</span>
      <span class="diag-item diag-note"><strong>说明:</strong> {{ transferNoteText }}</span>
    </div>

    <!-- 列表区域 -->
    <div class="p2p-list" @dragover.prevent @drop="handleDrop">
      <input type="file" id="p2p-file-input" multiple style="display: none" @change="handleFileSelect" />

      <el-empty
        v-if="fileList.length === 0"
        description="点击或拖入文件开始中转传输 (LAN Relay/普通中转)"
        image-size="50"
        @click="triggerUpload"
        class="clickable-empty"
      />

      <div
        v-for="(file, index) in fileList"
        :key="index"
        class="p2p-item"
        :class="{ 'is-self': file.fromSelf }"
        @click="handleDownload(file)"
      >
        <div class="file-icon">
          <el-icon><Document /></el-icon>
        </div>
        <div class="file-info">
          <div class="file-name" :title="file.name">{{ file.name }}</div>
          <div class="file-meta">
            <span>{{ formatSize(file.size) }}</span>
            <span v-if="file.fromSelf" class="tag-me">我发送的</span>
            <span v-else-if="file.isRelay" class="tag-lan">{{ file.relayStatus === 'ready' ? 'LAN中转可下' : 'LAN中转等待' }}</span>
            <span v-else-if="file.isVpsRelay" class="tag-peer">VPS中转</span>
            <span v-else-if="file.isNetdisk" class="tag-peer">云端</span>
            <span v-else-if="file.isLan" class="tag-lan">LAN加速</span>
            <span v-else class="tag-peer">来自伙伴</span>
          </div>
          <el-progress
            v-if="file.progress !== undefined && file.progress < 100"
            :percentage="file.progress"
            :stroke-width="4"
            :show-text="false"
            class="progress-bar"
          />
        </div>
        <!-- 删除/Close 按钮 -->
        <div class="file-action" @click.stop="deleteFile(index)">
          <el-icon><Close /></el-icon>
        </div>
      </div>
    </div>

    <!-- 底部提示 -->
    <div class="p2p-footer" @click="triggerUpload">
      <el-icon><UploadFilled /></el-icon>
      <span>{{ conn.isDesktop ? '点击选择文件（Go原生中转）' : '把小文件拖进来即可分享' }}</span>
    </div>
  </el-card>
</template>

<style scoped>
.p2p-card {
  height: 100%;
  border-left: 1px solid var(--el-border-color-light);
  border-radius: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  width: 100%; /* Ensure it fills the flex container */
}

.p2p-card :deep(.el-card__header) {
  height: 44.5px;
  padding: 0 15px;
  display: flex;
  align-items: center;
  background: var(--el-bg-color-overlay);
  border-bottom: 1px solid var(--el-border-color-light);
}

.transfer-diagnostics {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-blank);
}

.diag-item {
  white-space: nowrap;
}

.diag-note {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.p2p-list {
  flex: 1;
  overflow-y: auto;
  padding: 15px;
  background-color: var(--el-bg-color); /* Matches ClipboardCard white/dark aware bg */
}

html.dark .p2p-list {
  background-color: #262727; /* Grayish background for list area */
}

.p2p-item {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: all 0.2s;
  cursor: pointer;
}

.p2p-item:hover {
  border-color: var(--el-color-primary-light-5);
  transform: translateY(-1px);
  box-shadow: var(--el-box-shadow-light);
}

.file-icon {
  width: 36px;
  height: 36px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-regular);
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 14px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 4px;
}

.file-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.tag-me {
  background: var(--el-color-info-light-9);
  color: var(--el-color-info);
  padding: 1px 4px;
  border-radius: 4px;
}

.tag-peer {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
  padding: 1px 4px;
  border-radius: 4px;
}

.tag-lan {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
  padding: 1px 4px;
  border-radius: 4px;
}

/* Mimic ClipboardCard delete action style */
.file-action {
  color: var(--el-text-color-secondary);
  padding: 2px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.file-action:hover {
  background-color: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

/* 暗黑模式适配 - removed hardcoded overrides, vars handle it now */

.p2p-footer {
  padding: 10px;
  border-top: 1px solid var(--el-border-color-light);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--el-bg-color);
  cursor: pointer;
  transition: background 0.2s;
}

.p2p-footer:hover {
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
}

.clickable-empty {
  cursor: pointer;
}
</style>
