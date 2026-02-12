<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

interface Note {
  id: string
  title: string
  content: string
  updatedAt?: number
  version?: number
}

const conn = useConnectionStore()
const activeTab = ref('default')
const notes = ref<Note[]>([])
const saveStatus = ref('已同步')
const NOTE_ACK_TIMEOUT_MS = 10_000
const NOTE_RETRY_DELAY_MS = 1_500
const NOTE_MAX_RETRIES = 3
const NOTE_DELETE_ACK_TIMEOUT_MS = 8_000

// 防抖定时器映射 (id -> timer)
const timers: Record<string, number> = {}
let notepadHandler: ((type: string, payload: any) => void) | null = null
type NoteSyncState = {
  inFlight: boolean
  pending: boolean
  timer?: number
  retryCount: number
  retryTimer?: number
}
type PendingDeleteState = {
  note: Note
  index: number
  activeBeforeDelete: boolean
  timer: number
}
const noteSyncState = new Map<string, NoteSyncState>()
const pendingDeleteState = new Map<string, PendingDeleteState>()

function normalizeUpdatedAt(input: unknown): number {
  const n = Number(input)
  return Number.isFinite(n) ? n : 0
}

function normalizeNote(payload: any): Note | null {
  const id = String(payload?.id || '').trim()
  if (!id) return null
  return {
    id,
    title: String(payload?.title ?? ''),
    content: String(payload?.content ?? ''),
    updatedAt: normalizeUpdatedAt(payload?.updatedAt),
    version: 0
  }
}

function hasLocalPendingChanges(noteId: string): boolean {
  if (!noteId) return false
  if (timers[noteId]) return true
  const state = noteSyncState.get(noteId)
  return !!state?.inFlight || !!state?.pending
}

function applyRemoteNote(payload: any, preserveLocalIfDirty = true) {
  const incoming = normalizeNote(payload)
  if (!incoming) return
  if (pendingDeleteState.has(incoming.id)) return

  const idx = notes.value.findIndex(n => n.id === incoming.id)
  if (idx === -1) {
    notes.value.push(incoming)
    return
  }

  const current = notes.value[idx]
  if (!current) return
  const currentTs = normalizeUpdatedAt(current.updatedAt)
  const incomingTs = normalizeUpdatedAt(incoming.updatedAt)

  if (incomingTs > 0 && currentTs > 0 && incomingTs < currentTs) {
    return
  }

  if (
    preserveLocalIfDirty &&
    hasLocalPendingChanges(incoming.id) &&
    (current.content !== incoming.content || current.title !== incoming.title)
  ) {
    if (incomingTs > currentTs) {
      current.updatedAt = incomingTs
    }
    return
  }

  if (current.content !== incoming.content) {
    current.content = incoming.content
    current.version = (current.version || 0) + 1
  }
  if (current.title !== incoming.title) current.title = incoming.title
  current.updatedAt = incomingTs
}

function clearNoteTimer(noteId: string) {
  if (!noteId) return
  if (timers[noteId]) {
    clearTimeout(timers[noteId])
    delete timers[noteId]
  }
}

function getNoteSyncState(noteId: string) {
  const existing = noteSyncState.get(noteId)
  if (existing) return existing
  const created: NoteSyncState = {
    inFlight: false,
    pending: false,
    timer: undefined,
    retryCount: 0,
    retryTimer: undefined
  }
  noteSyncState.set(noteId, created)
  return created
}

function clearNoteSyncTimer(noteId: string) {
  const state = noteSyncState.get(noteId)
  if (!state?.timer) return
  window.clearTimeout(state.timer)
  state.timer = undefined
}

function clearNoteRetryTimer(noteId: string) {
  const state = noteSyncState.get(noteId)
  if (!state?.retryTimer) return
  window.clearTimeout(state.retryTimer)
  state.retryTimer = undefined
}

function clearNoteSyncState(noteId: string) {
  clearNoteSyncTimer(noteId)
  clearNoteRetryTimer(noteId)
  noteSyncState.delete(noteId)
}

function queueSend(note: Note) {
  const noteId = String(note.id || '')
  if (!noteId) return
  const state = getNoteSyncState(noteId)
  if (state.inFlight) {
    state.pending = true
    return
  }
  sendUpdate(note)
}

function onNoteSyncSettled(noteId: string) {
  const state = noteSyncState.get(noteId)
  if (!state) return
  clearNoteSyncTimer(noteId)
  clearNoteRetryTimer(noteId)
  state.inFlight = false
  state.retryCount = 0
  if (!state.pending) return
  state.pending = false
  const latest = notes.value.find(n => n.id === noteId)
  if (!latest) return
  sendUpdate(latest)
}

function clearPendingDeleteState(noteId: string) {
  const state = pendingDeleteState.get(noteId)
  if (!state) return
  window.clearTimeout(state.timer)
  pendingDeleteState.delete(noteId)
}

function restorePendingDelete(noteId: string) {
  const state = pendingDeleteState.get(noteId)
  if (!state) return

  const exists = notes.value.some(n => n.id === noteId)
  if (!exists) {
    const insertAt = Math.max(0, Math.min(state.index, notes.value.length))
    notes.value.splice(insertAt, 0, state.note)
  }
  if (state.activeBeforeDelete) {
    activeTab.value = noteId
  }
  clearPendingDeleteState(noteId)
}

// 初始化
onMounted(() => {
  // 注册事件监听
  notepadHandler = (type, payload) => {
    console.log(`📝 NotepadPanel received: ${type}`, payload)
    if (type === 'init') {
      for (const key of Object.keys(timers)) {
        clearNoteTimer(key)
      }
      for (const [id] of noteSyncState) {
        clearNoteSyncState(id)
      }
      for (const [id] of pendingDeleteState) {
        clearPendingDeleteState(id)
      }
      const initNotes = Array.isArray(payload)
        ? payload.map(normalizeNote).filter((n): n is Note => !!n)
        : []
      notes.value = initNotes
      // 如果当前没有选中的或者选中的不存在了，默认选第一个
      if (!notes.value.some(n => n.id === activeTab.value)) {
        const first = notes.value[0]
        if (first) activeTab.value = first.id
      }
    } else if (type === 'notepad_update') {
      applyRemoteNote(payload)
      saveStatus.value = '收到更新'
    } else if (type === 'notepad_ack') {
      applyRemoteNote(payload)
      saveStatus.value = '已同步至云端'
      const ackId = String(payload?.id || '')
      if (ackId) onNoteSyncSettled(ackId)
    } else if (type === 'notepad_delete_ack') {
      const ackId = String(payload?.id || '')
      if (ackId) {
        clearPendingDeleteState(ackId)
      }
      saveStatus.value = '已同步至云端'
    } else if (type === 'notepad_conflict') {
      applyRemoteNote(payload, false)
      saveStatus.value = '检测到并发修改，已回滚到远端版本'
      ElMessage.warning('记事本发生并发编辑，已同步为最新远端版本')
      const conflictId = String(payload?.id || '')
      if (conflictId) onNoteSyncSettled(conflictId)
    } else if (type === 'notepad_delete') {
      // payload: { id }
      clearNoteTimer(payload.id)
      const noteId = String(payload?.id || '')
      clearNoteSyncState(noteId)
      clearPendingDeleteState(noteId)
      const idx = notes.value.findIndex(n => n.id === noteId)
      if (idx !== -1) {
        notes.value.splice(idx, 1)
        if (activeTab.value === noteId) {
          activeTab.value = notes.value[0]?.id || ''
        }
      }
    }
  }

  conn.onNotepadEvent = notepadHandler
  conn.replayPendingNotepadEvents()
})

onBeforeUnmount(() => {
  for (const key of Object.keys(timers)) {
    clearNoteTimer(key)
  }
  for (const [id] of noteSyncState) {
    clearNoteSyncState(id)
  }
  for (const [id] of pendingDeleteState) {
    clearPendingDeleteState(id)
  }
  if (conn.onNotepadEvent === notepadHandler) {
    conn.onNotepadEvent = null
  }
})

// 监听当前激活 Tab 的内容变化，自动保存
// 注意：由于是数组，且我们要监听特定字段，这里采用可以在 input 事件里触发保存
function onContentChange(note: Note) {
  saveStatus.value = '输入中...'

  const noteId = note.id
  clearNoteTimer(noteId)
  timers[noteId] = window.setTimeout(() => {
    delete timers[noteId]
    const latest = notes.value.find(n => n.id === noteId)
    if (!latest) return
    queueSend(latest)
  }, 1000)
}

function sendUpdate(note: Note) {
  const noteId = String(note.id || '')
  if (!noteId) return
  const state = getNoteSyncState(noteId)
  state.inFlight = true
  state.pending = false
  clearNoteSyncTimer(noteId)
  clearNoteRetryTimer(noteId)
  state.timer = window.setTimeout(() => {
    const current = noteSyncState.get(noteId)
    if (!current || !current.inFlight) return
    current.inFlight = false
    clearNoteSyncTimer(noteId)
    saveStatus.value = '同步超时，重试中...'
    if (current.pending) {
      current.pending = false
      const latest = notes.value.find(n => n.id === noteId)
      if (latest) sendUpdate(latest)
      return
    }

    if (current.retryCount < NOTE_MAX_RETRIES) {
      current.retryCount += 1
      current.retryTimer = window.setTimeout(() => {
        const latest = notes.value.find(n => n.id === noteId)
        if (!latest) return
        sendUpdate(latest)
      }, NOTE_RETRY_DELAY_MS)
    } else {
      saveStatus.value = '同步失败，请继续编辑后重试'
    }
  }, NOTE_ACK_TIMEOUT_MS)
  saveStatus.value = '同步中...'
  conn.sendMessage({
    type: 'notepad_update',
    payload: {
      id: note.id,
      title: note.title,
      content: note.content,
      baseUpdatedAt: normalizeUpdatedAt(note.updatedAt)
    }
  })
}

// 添加新笔记
function handleTabsEdit(targetName: string | undefined, action: 'remove' | 'add') {
  if (action === 'add') {
    const newId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const newNote: Note = { id: newId, title: '新笔记', content: '', updatedAt: 0 }
    notes.value.push(newNote)
    activeTab.value = newId
    // 立即告诉服务器创建
    queueSend(newNote)
  } else if (action === 'remove') {
    const noteId = targetName as string
    ElMessageBox.confirm('确定要删除这个笔记吗？删除后无法恢复。', '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      clearNoteTimer(noteId)
      clearNoteSyncState(noteId)
      const idx = notes.value.findIndex(n => n.id === noteId)
      if (idx === -1) return
      const note = notes.value[idx]
      if (!note) return
      const snapshot: Note = { ...note }
      const activeBeforeDelete = activeTab.value === noteId

      // 本地先删
      notes.value.splice(idx, 1)

      // 切换 tab
      if (activeTab.value === noteId) {
        activeTab.value = notes.value[0]?.id || ''
      }

      const rollbackTimer = window.setTimeout(() => {
        const pending = pendingDeleteState.get(noteId)
        if (!pending) return
        restorePendingDelete(noteId)
        ElMessage.warning('删除同步超时，已恢复该笔记')
      }, NOTE_DELETE_ACK_TIMEOUT_MS)

      pendingDeleteState.set(noteId, {
        note: snapshot,
        index: idx,
        activeBeforeDelete,
        timer: rollbackTimer
      })

      // 通知服务器
      conn.sendMessage({
        type: 'notepad_delete',
        payload: { id: noteId }
      })
    }).catch(() => {})
  }
}
</script>

<template>
  <el-card class="notepad-card" body-style="padding: 0;" shadow="never">
    <!-- 右上角控制区：新增按钮 + 同步状态 -->
    <div class="header-controls">
      <el-button
        :icon="Plus"
        circle
        size="small"
        @click="handleTabsEdit(undefined, 'add')"
        title="新建笔记"
      />
      <el-tag size="small" type="info">{{ saveStatus }}</el-tag>
    </div>

    <el-tabs
      v-model="activeTab"
      type="card"
      editable
      class="demo-tabs"
      @edit="handleTabsEdit"
    >
      <el-tab-pane
        v-for="note in notes"
        :key="note.id"
        :label="note.title"
        :name="note.id"
      >
        <template #label>
           <span>{{ note.title }}</span>
        </template>

        <div class="editor-area">
          <el-input
            v-model="note.title"
            placeholder="笔记标题"
            class="title-input"
            @input="onContentChange(note)"
          />
          <!-- 富文本编辑器 -->
          <div class="quill-wrapper">
            <QuillEditor
              :key="note.version || 0"
              v-model:content="note.content"
              theme="snow"
              contentType="html"
              placeholder="在此输入内容..."
              @update:content="onContentChange(note)"
            />
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<style scoped>
.notepad-card {
  height: 100%;
  border-radius: 8px 0 0 8px;
  border-right: none;
  overflow: hidden;
}

.notepad-card :deep(.el-card__body) {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
}

/* Header 右上角控制区 */
.header-controls {
  position: absolute;
  top: 21px; /* 垂直居中于 header区域 (40px + border 1px) */
  transform: translateY(-50%);
  right: 15px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
}

:deep(.el-tabs) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* 让 tabs header 有灰色背景，和 Clipboard 一致 */
/* 给 sync status 留出空间 */
/* 给 sync status 留出空间 */
:deep(.el-tabs__header) {
  margin: 0;
  background: var(--el-bg-color-overlay);
  border-bottom: 1px solid var(--el-border-color-light);
  height: 41px;  /* 明确高度对齐 */
  display: flex;
  align-items: center;
  padding-right: 100px;
  box-sizing: border-box;
}

/* 暗黑模式强制覆盖背景 */
html.dark :deep(.el-tabs__header) {
  background: #1d1e1f;
  border-bottom: 1px solid #363637;
}

:deep(.el-tabs__nav-wrap) {
  flex: 1;
}

/* 隐藏默认的 new-tab 按钮，使用自定义的 */
:deep(.el-tabs__new-tab) {
  display: none;
}

:deep(.el-tabs__content) {
  flex: 1;
  overflow: hidden;
  background: var(--el-bg-color);
}

/* 暗黑模式强制覆盖背景 */
html.dark :deep(.el-tabs__content) {
  background: #1d1e1f;
}

:deep(.el-tab-pane) {
  height: 100%;
}

:deep(.el-tab-pane) {
  height: 100%;
}

.demo-tabs > :deep(.el-tabs__content) {
  padding: 15px;
}

.editor-area {
  height: 100%; /* 占满 tab-pane 高度 */
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title-input {
  font-weight: bold;
  flex-shrink: 0;
}

.quill-wrapper {
  flex: 1; /* 自动填充剩余高度 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 修复 Quill 在 Element Tabs 里的样式问题 */
:deep(.ql-container) {
  flex: 1;
  font-size: 16px;
  font-family: inherit;
}
:deep(.ql-toolbar) {
  border-top-left-radius: 4px;
  border-top-right-radius: 4px;
}
:deep(.ql-container.ql-snow) {
  border-bottom-left-radius: 4px;
  border-bottom-right-radius: 4px;
}

/* 暗黑模式适配编辑器 */
html.dark .title-input :deep(.el-input__wrapper) {
  background-color: transparent;
  box-shadow: none;
}
/* Mobile Responsive Adjustments */
@media (max-width: 768px) {
  .header-controls {
    position: static;
    transform: none;
    margin: 10px 10px 5px;
    align-self: flex-end; /* Align right */
  }

  :deep(.el-tabs__header) {
    padding-right: 0;
  }
}

html.dark .title-input :deep(.el-input__inner) {
  color: #E5EAF3;
}

/* Dark mode for Quill Editor */
html.dark :deep(.ql-toolbar) {
  background-color: #1d1e1f;
  border-color: #4c4d4f;
}
html.dark :deep(.ql-toolbar .ql-stroke) {
  stroke: #cfd3dc;
}
html.dark :deep(.ql-toolbar .ql-fill) {
  fill: #cfd3dc;
}
html.dark :deep(.ql-toolbar .ql-picker) {
  color: #cfd3dc;
}

html.dark :deep(.ql-container.ql-snow) {
  border-color: #4c4d4f;
  background-color: #141414;
}

html.dark :deep(.ql-editor) {
  color: #cfd3dc;
}

html.dark :deep(.ql-editor.ql-blank::before) {
  color: #606266;
  font-style: normal;
}
</style>
