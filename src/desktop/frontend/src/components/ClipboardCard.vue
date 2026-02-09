<script setup lang="ts">
import { Close, Promotion, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { nextTick, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

interface ClipboardItem {
  id: string
  text: string
  time: string
}

const conn = useConnectionStore()
const clipboardList = ref<ClipboardItem[]>([])

// 监听远程历史记录
conn.onClipboardHistory = (history: any[]) => {
  if (history && history.length > 0) {
    clipboardList.value = history.map(item => ({
      id: item.id || Date.now().toString() + Math.random().toString().substr(2, 5),
      text: item.text,
      time: item.time || getTime()
    }))
    scrollToBottom()
    ElMessage.success(`已同步 ${history.length} 条已保存记录`)
  }
}

// 监听单条数据 (实时同步) - Changed to accept Object
conn.onClipboardData = (data: any) => {
  // Check if it's a full item object or just text string (legacy/direct)
  let text = ''
  let id = ''
  let time = ''

  if (typeof data === 'string') {
     text = data
  } else if (typeof data === 'object' && data.text) {
     text = data.text
     id = data.id
     time = data.time
  }

  if (!text) return

  // Check duplicate
  const lastIndex = clipboardList.value.findIndex(item => item.text === text)
  if (lastIndex !== -1) {
      // If we found a match (text same), update its ID to Server ID!
      if (id && clipboardList.value[lastIndex]) {
          clipboardList.value[lastIndex].id = id
          console.log(`🔄 Updated local item ID to Server ID: ${id}`)
      }
      return
  }

  // If new, push it
  clipboardList.value.push({
    id: id || Date.now().toString() + Math.random().toString().substr(2, 5),
    text: text,
    time: time || getTime()
  })

  scrollToBottom()
}

// 监听实时删除
conn.onClipboardDelete = (id: number | string) => {
  console.log(`🗑️ Received delete request for ID: ${id} (Type: ${typeof id})`)

  // 兼容旧版 number ID
  const index = clipboardList.value.findIndex((item, idx) => {
      // String comparison is safest
      const match = item.id.toString() === id.toString()
      if (match) console.log(`✅ Found match at index ${idx}:`, item)
      return match
  })

  if (index !== -1) {
    clipboardList.value.splice(index, 1)
    console.log(`🗑️ Synced delete success: ${id}`)
  } else {
    console.warn(`⚠️ Delete failed: Item ${id} not found in local list.`, clipboardList.value.map(i => i.id))
  }
}

const inputContent = ref('')
const isSending = ref(false)
const listContainer = ref<HTMLElement | null>(null)

// 自动滚动到底部
function scrollToBottom() {
  nextTick(() => {
    if (listContainer.value) {
      listContainer.value.scrollTop = listContainer.value.scrollHeight
    }
  })
}

// 辅助：生成时间戳
function getTime() {
  const now = new Date()
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
}

// 发送给 C++ Host
function sendToHost() {
  if (!inputContent.value) return
  isSending.value = true

  const text = inputContent.value
  const id = Date.now().toString() // Use local timestamp as ID base

  // 发送
  conn.sendMessage({
    type: 'clipboard_push',
    payload: {
      text,
      id
    }
  })

  // 本地也加一条 (Pass ID explicitly)
  addBullet(text, false, id)
  inputContent.value = ''

  setTimeout(() => isSending.value = false, 500)
}

// 核心：添加一条记录
function addBullet(text: string, fromRemote = false, customId?: string) {
  if (!text) return

  // 简单的去重：如果最新的一条跟这个一样，就不添加
  const last = clipboardList.value[clipboardList.value.length - 1]
  if (last && last.text === text) return

  const finalId = customId || Date.now().toString() + Math.random().toString().substr(2, 5)

  clipboardList.value.push({
    id: finalId,
    text: text,
    time: getTime()
  })

  scrollToBottom()
  if (fromRemote) {
    if (text.startsWith('data:image')) {
      ElMessage.success('收到图片消息')
    } else {
      ElMessage.success('收到文本消息')
    }
  }
}

// 处理粘贴事件 (支持图片)
function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return

  for (const item of items) {
    if (item.type.indexOf('image') !== -1) {
      // 这是一个图片
      event.preventDefault() // 阻止默认粘贴 (防止文件名进输入框)

      const blob = item.getAsFile()
      if (!blob) return

      const reader = new FileReader()
      reader.onload = (e) => {
        const base64 = e.target?.result as string
        if (base64) {
          const id = Date.now().toString()
          // 直接发送 Base64 图片
          conn.sendMessage({
            type: 'clipboard_push',
            payload: { text: base64, id }
          })
          addBullet(base64, false, id)
        }
      }
      reader.readAsDataURL(blob)
      return // 只处理第一张图
    }
  }
}

// 读取本机剪切板
async function readLocalClipboard() {
  if (!navigator.clipboard) {
    ElMessage.error('当前浏览器不支持访问剪切板')
    return
  }

  try {
    // 1. 尝试读取富内容 (如图片)
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        if (item.types.includes('image/png') || item.types.includes('image/jpeg')) {
          const blob = await item.getType(item.types.find(t => t.startsWith('image/'))!)
          const reader = new FileReader()
          reader.onload = (e) => {
            const base64 = e.target?.result as string
            if (base64) {
              const id = Date.now().toString()
              conn.sendMessage({ type: 'clipboard_push', payload: { text: base64, id } })
              addBullet(base64, false, id)
            }
          }
          reader.readAsDataURL(blob)
          return
        }
      }
    } catch (e) {
      console.warn('Clipboard read() failed, falling back to readText()', e)
    }

    // 2. 尝试读取纯文本
    const text = await navigator.clipboard.readText()
    if (text) {
      const id = Date.now().toString()
      conn.sendMessage({ type: 'clipboard_push', payload: { text, id } })
      addBullet(text, false, id)
      ElMessage.success('已读取本机剪切板')
    } else {
      ElMessage.info('剪切板为空或无法读取')
    }

  } catch (err) {
    console.error(err)
    ElMessage.error('读取失败，请检查浏览器权限')
  }
}

// 从 Host 获取
function fetchFromHost() {
  conn.sendMessage({ type: 'clipboard_pull' })
  ElMessage.info('正在请求 Host 剪切板...')
}

// 复制单个 Bullet (支持图片)
async function copyItem(item: ClipboardItem) {
  // 判断是否是 Base64 图片
  const isImage = item.text.startsWith('data:image')

  if (!navigator.clipboard) {
    ElMessage.error('无法访问剪切板')
    return
  }

  try {
    if (isImage) {
      // 复制图片
      const response = await fetch(item.text)
      const blob = await response.blob()

      // ClipboardItem 构造函数需要 Blob
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ])
      ElMessage.success('已复制图片')
    } else {
      // 复制文本
      await navigator.clipboard.writeText(item.text)
      ElMessage.success('已复制文本')
    }
  } catch (e) {
    console.error(e)
    ElMessage.error('复制失败，请重试')
  }
}

// 删除单个 Bullet
function deleteItem(index: number, item: ClipboardItem) {
  console.log(`🗑️ Sending delete request for Item:`, item)

  // 乐观更新 (Local Optimistic Update)
  clipboardList.value.splice(index, 1)

  // Send delete request to server
  conn.sendMessage({
    type: 'clipboard_delete',
    payload: { id: item.id }
  })
}

// 暴露给父组件
defineExpose({
  updateText: (text: string) => {
    addBullet(text, true)
  }
})
</script>

<template>
  <el-card class="clipboard-card" body-style="display: flex; flex-direction: column; height: 100%;" shadow="never">
    <template #header>
      <div class="card-header">
        <span class="record-count">{{ clipboardList.length }} 条</span>
        <el-button :icon="Refresh" size="small" circle @click="readLocalClipboard" title="同步本机剪切板" />
      </div>
    </template>

    <!-- 列表区域: 让它占据剩余空间并滚动 -->
    <div class="list-container" ref="listContainer">
      <el-empty v-if="clipboardList.length === 0" description="暂无记录，尝试输入或从 Host 获取" image-size="60" />

      <div
        v-for="(item, index) in clipboardList"
        :key="item.id"
        class="bullet-item"
        @click="copyItem(item)"
      >
        <div class="bullet-content">
          <!-- 图片渲染 -->
          <div v-if="item.text.startsWith('data:image')" class="bullet-image">
            <img :src="item.text" alt="Clipboard Image" />
          </div>
          <!-- 文本渲染 -->
          <div v-else class="bullet-text">{{ item.text }}</div>

          <div class="bullet-meta">{{ item.time }}</div>
        </div>
        <div class="bullet-action" @click.stop="deleteItem(index, item)">
          <el-icon><Close /></el-icon>
        </div>
      </div>
    </div>

    <!-- 底部输入区 -->
    <div class="footer-input">
      <el-input
        v-model="inputContent"
        placeholder="输入内容发送，或 Ctrl+V 粘贴图片..."
        @keyup.enter="sendToHost"
        @paste="handlePaste"
      >
        <template #append>
          <el-button :loading="isSending" :icon="Promotion" @click="sendToHost" />
        </template>
      </el-input>
    </div>
  </el-card>
</template>

<style scoped>
.clipboard-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: none;
  border-radius: 0 8px 8px 0;
  overflow: hidden;
}

.clipboard-card :deep(.el-card__body) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Header: 暗黑模式适配 */
/* Header: 暗黑模式适配 - Removed manual dark check, use vars */
.clipboard-card :deep(.el-card__header) {
  padding: 0 15px;
  height: 40px;
  display: flex;
  align-items: center;
  background: var(--el-bg-color-overlay);
  border-bottom: 1px solid var(--el-border-color-light);
  border-radius: 0 8px 0 0;
  box-sizing: border-box;
}

/* 暗黑模式强制覆盖背景 - REMOVED, use vars above */
/* html.dark .clipboard-card :deep(.el-card__header) { ... } */

.card-header {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.record-count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.list-container {
  flex: 1;
  overflow-y: auto;
  padding: 10px 5px;
  background-color: var(--el-bg-color);
  margin-bottom: 10px;
}

html.dark .list-container {
  background-color: #262727; /* Grayish background for list area */
}

.bullet-item {
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: var(--el-box-shadow-light);
}

.bullet-item:hover {
  border-color: var(--el-color-primary);
  box-shadow: var(--el-box-shadow);
  transform: translateY(-1px);
}

.bullet-content {
  flex: 1;
  overflow: hidden;
}

.bullet-text {
  font-size: 14px;
  color: var(--el-text-color-primary);
  line-height: 1.4;
  word-break: break-all;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 图片样式 */
.bullet-image img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color);
  object-fit: contain;
  display: block;
}

.bullet-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 4px;
}

.bullet-action {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  padding: 2px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bullet-action:hover {
  background-color: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.footer-input {
  border-top: 1px solid var(--el-border-color-light);
  padding-top: 10px;
}
</style>
