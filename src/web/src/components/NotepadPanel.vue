<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

interface Note {
  id: string
  title: string
  content: string
}

const conn = useConnectionStore()
const activeTab = ref('default')
const notes = ref<Note[]>([])
const saveStatus = ref('已同步')

// 防抖定时器映射 (id -> timer)
const timers: Record<string, number> = {}

// 初始化
onMounted(() => {
  // 注册事件监听
  conn.onNotepadEvent = (type, payload) => {
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
          if (note.content !== payload.content) note.content = payload.content
          if (note.title !== payload.title) note.title = payload.title
        }
      } else {
        // 新增
        notes.value.push(payload)
      }
      saveStatus.value = '收到更新'
    } else if (type === 'notepad_delete') {
      // payload: { id }
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

  if (timers[note.id]) clearTimeout(timers[note.id])
  timers[note.id] = setTimeout(() => {
    sendUpdate(note)
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
    const newId = `note-${Date.now()}`
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
  <el-card class="notepad-card" body-style="padding: 0;">
    <div class="header-bar">
      <span>📝 云端记事本</span>
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
           <!-- 标题支持双击编辑 (简化版：用 el-popover 或者直接 input 替换 text? 这里简单起见只显示) -->
           <!-- 为了体验更好，可以在 tab 内容里加一个标题编辑栏 -->
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
.header-bar {
  padding: 10px 15px;
  border-bottom: 1px solid #ebeef5;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.demo-tabs > :deep(.el-tabs__content) {
  padding: 15px;
}

.editor-area {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title-input {
  font-weight: bold;
}

.quill-wrapper {
  height: 400px; /* 给编辑器一个固定高度 */
  display: flex;
  flex-direction: column;
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
</style>
