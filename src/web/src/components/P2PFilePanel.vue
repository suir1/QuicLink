<script setup lang="ts">
import { Close, Document, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

const conn = useConnectionStore()

interface P2PFile {
  id: string
  name: string
  size: number
  type: string
  fromSelf: boolean
  progress?: number
  isLan?: boolean // Phase 2: LAN Flag
  baseUrl?: string // Phase 5: Multi-Host URL
}

const fileList = ref<P2PFile[]>([])

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

  processFiles(files)
}

function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    processFiles(input.files)
  }
  input.value = '' // reset
}

function triggerUpload() {
  document.getElementById('p2p-file-input')?.click()
}

function processFiles(files: FileList) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file) continue
    if (file.size > 10 * 1024 * 1024) {
      ElMessage.warning(`文件 ${file.name} 过大 (暂限10MB)，建议使用上方文件中转`)
      continue
    }
    // 调用 Store Smart Send
    conn.smartSendFile(file)
    addFileToList({
      id: 'local-' + Date.now(),
      name: file.name,
      size: file.size,
      type: file.type,
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

function handleDownload(file: P2PFile) {
  if (file.fromSelf) return

  // Phase 2: LAN Download
  if (file.isLan) {
      const baseUrl = file.baseUrl || conn.lanServerUrl
      if (baseUrl) {
          window.open(`${baseUrl}/api/lan/download/${file.id}`, '_blank')
          return
      }
  }

  ElMessage.info('开始请求下载...')
  conn.requestFile(file.id)
}

onMounted(() => {
  if (conn.onP2PEvent) console.warn('onP2PEvent already bound?')

  // 绑定 Store 事件
  conn.onP2PEvent = (type, payload) => {
    if (type === 'offer') {
      // 收到别人分享的文件
      addFileToList({
        id: payload.id,
        name: payload.name,
        size: payload.size,
        type: payload.type,
        fromSelf: false,
        isLan: payload.isLan, // Phase 2
        baseUrl: payload.baseUrl // Phase 5
      })
    } else if (type === 'progress') {
      // payload: { id, received, total }
      const item = fileList.value.find(f => f.id === payload.id)
      if (item) {
        item.progress = includePercentage(payload.received, payload.total)
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

    <!-- 列表区域 -->
    <div class="p2p-list" @dragover.prevent @drop="handleDrop">
      <input type="file" id="p2p-file-input" multiple style="display: none" @change="handleFileSelect" />

      <el-empty
        v-if="fileList.length === 0"
        description="点击或拖入文件开启直传 (Max 10MB)"
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
      <span>把小文件拖进来即可分享</span>
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
