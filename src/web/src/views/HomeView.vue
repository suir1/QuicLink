<script setup lang="ts">
import { CopyDocument, Loading } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QrcodeVue from 'qrcode.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useConnectionStore } from '../stores/connection'

// 引入功能组件 (请确保这些文件存在于 components 目录下)
import ClipboardCard from '../components/ClipboardCard.vue'
import FilePanel from '../components/FilePanel.vue'
import NotepadPanel from '../components/NotepadPanel.vue'

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
  conn.onNotepadData = (text) => {
    notepadRef.value?.updateContent(text)
  }

  // 2. 检查服务器模式并加入
  const mode = await conn.checkMode()

  if (mode === 'public') {
    joinRoom()
  } else if (mode === 'private') {
    promptPassword()
  }
})

// 监听 URL 变化 (仅公共模式下允许随意切换房间)
watch(() => route.params.roomId, () => {
  if (conn.serverMode === 'public') joinRoom()
})

// 加入房间逻辑
function joinRoom() {
  const roomId = (route.params.roomId as string) || 'public'
  conn.connect(roomId)
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

    <div class="status-bar-wrapper">
      <el-alert
        v-if="conn.isConnected"
        :title="conn.serverMode === 'private' ? '🔒 私有加密隧道已建立' : `🌐 已加入公共房间: ${conn.currentRoom}`"
        type="success"
        effect="dark"
        center
        show-icon
        :closable="false"
      />
      <el-alert
        v-else
        title="正在连接服务器..."
        type="info"
        center
        show-icon
        :closable="false"
      />
    </div>

    <el-row v-if="conn.isConnected" :gutter="20" class="main-content">

      <el-col :xs="24" :md="8">
        <el-card class="box-card info-card">
          <div class="qr-wrapper">
            <qrcode-vue :value="currentUrl" :size="160" level="M" background="#ffffff" foreground="#000000"/>
            <p>手机扫码互传</p>
          </div>

          <el-input v-model="currentUrl" readonly size="small">
            <template #append>
              <el-button :icon="CopyDocument" @click="copyLink" />
            </template>
          </el-input>

          <div class="host-status">
            <p>PC 主机状态:</p>
            <div v-if="conn.hostOnline">
               <el-tag type="success" effect="dark" size="large">在线</el-tag>
               <div class="host-ip">IP: {{ conn.hostIp }}</div>
            </div>
            <el-tag v-else type="info" size="large">离线</el-tag>
          </div>
          <div class="host-hint" v-if="!conn.hostOnline">
            <small>请打开电脑端的 QuicLink 客户端以启用剪切板同步</small>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="16">

        <div class="feature-block">
          <NotepadPanel ref="notepadRef" />
        </div>

        <div class="feature-block">
          <ClipboardCard ref="clipboardRef" />
        </div>

        <div class="feature-block">
          <FilePanel />
        </div>

      </el-col>
    </el-row>

    <div v-else class="loading-state">
      <el-icon class="is-loading" :size="40" color="#409eff"><Loading /></el-icon>
      <p>正在尝试连接服务器...</p>
    </div>

  </div>
</template>

<style scoped>
.app-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 15px;
}

.status-bar-wrapper {
  margin-bottom: 20px;
}

.main-content {
  margin-top: 10px;
}

/* 左侧信息卡片 */
.qr-wrapper {
  text-align: center;
  margin-bottom: 20px;
  padding: 10px;
  background: #f9fafe;
  border-radius: 8px;
}
.qr-wrapper p {
  font-size: 13px;
  color: #666;
  margin-top: 8px;
}

.host-status {
  margin-top: 25px;
  padding-top: 20px;
  border-top: 1px dashed #eee;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  color: #333;
  font-weight: 500;
}

.host-ip {
  font-size: 12px;
  color: #999;
  text-align: right;
  margin-top: 4px;
}

.host-hint {
  margin-top: 10px;
  color: #909399;
  line-height: 1.4;
}

/* 右侧功能块 */
.feature-block {
  margin-bottom: 20px;
}

.loading-state {
  text-align: center;
  margin-top: 100px;
}
.loading-state p {
  color: #606266;
  margin-top: 15px;
}
</style>
