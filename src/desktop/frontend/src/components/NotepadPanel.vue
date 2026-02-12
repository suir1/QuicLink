<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

interface Note {
  id: string
  title: string
  content: string
  version?: number
}

const conn = useConnectionStore()
const activeTab = ref('default')
const notes = ref<Note[]>([])
const saveStatus = ref('已同步')

// 防抖定时器映射 (id -> timer)
const timers: Record<string, number> = {}

function clearNoteTimer(noteId: string) {
  if (!noteId) return
  if (timers[noteId]) {
    clearTimeout(timers[noteId])
    delete timers[noteId]
  }
}

// 初始化
onMounted(() => {
  // 注册事件监听
  conn.onNotepadEvent = (type: string, payload: any) => {
    console.log(`📝 NotepadPanel received: ${type}`, payload)
    if (type === 'init') {
      // payload 是 Note[] 列表
      notes.value = payload
      // 如果当前没有选中的或者选中的不存在了，默认选第一个
      if (!notes.value.some(n => n.id === activeTab.value)) {
        const first = notes.value[0]
        if (first) activeTab.value = first.id
      }
    } else if (type === 'notepad_update') {
      // payload: { id, title, content }
      const idx = notes.value.findIndex(n => n.id === payload.id)
      if (idx !== -1) {
        // 更新现有
        const note = notes.value[idx]
        if (note) {
          if (note.content !== payload.content) {
            note.content = payload.content
            note.version = (note.version || 0) + 1
          }
          if (note.title !== payload.title) note.title = payload.title
        }
      } else {
        // 新增
        notes.value.push(payload)
      }
      saveStatus.value = '收到更新'
    } else if (type === 'notepad_delete') {
      // payload: { id }
      clearNoteTimer(payload.id)
      const idx = notes.value.findIndex(n => n.id === payload.id)
      if (idx !== -1) {
        notes.value.splice(idx, 1)
        if (activeTab.value === payload.id) {
          activeTab.value = notes.value[0]?.id || ''
        }
      }
    }
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
    sendUpdate(latest)
  }, 1000)
}

function sendUpdate(note: Note) {
  conn.sendMessage({
    type: 'notepad_update',
    payload: {
      id: note.id,
      title: note.title,
      content: note.content
    }
  })
  saveStatus.value = '已同步至云端'
}

// 添加新笔记
function handleTabsEdit(targetName: string | undefined, action: 'remove' | 'add') {
  if (action === 'add') {
    const newId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const newNote = { id: newId, title: '新笔记', content: '' }
    notes.value.push(newNote)
    activeTab.value = newId
    // 立即告诉服务器创建
    sendUpdate(newNote)
  } else if (action === 'remove') {
    const noteId = targetName as string
    ElMessageBox.confirm('确定要删除这个笔记吗？删除后无法恢复。', '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      clearNoteTimer(noteId)
      // 本地先删
      const idx = notes.value.findIndex(n => n.id === noteId)
      if (idx !== -1) notes.value.splice(idx, 1)

      // 切换 tab
      if (activeTab.value === noteId) {
        activeTab.value = notes.value[0]?.id || ''
      }

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
html.dark .title-input :deep(.el-input__inner) {
  color: #E5EAF3;
}
</style>
