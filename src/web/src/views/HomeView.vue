<script setup lang="ts">
import { CopyDocument } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import QrcodeVue from 'qrcode.vue'
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useConnectionStore } from '../stores/connection'

const route = useRoute()
const conn = useConnectionStore()

const currentUrl = computed(() => window.location.href)

onMounted(async () => {
  // 1. 先问服务器是啥模式
  const mode = await conn.checkMode()

  if (mode === 'public') {
    // 公共模式：直接进房间
    joinRoom()
  } else if (mode === 'private') {
    // 私有模式：强制弹窗输密码
    promptPassword()
  }
})

// 监听路由变化 (仅公共模式下有效)
watch(() => route.params.roomId, () => {
  if (conn.serverMode === 'public') joinRoom()
})

function joinRoom() {
  const roomId = (route.params.roomId as string) || 'public'
  conn.connect(roomId)
}

function promptPassword() {
  ElMessageBox.prompt('此服务器为私有模式，请输入访问密码', '身份验证', {
    confirmButtonText: '连接',
    cancelButtonText: '取消',
    inputType: 'password',
    closeOnClickModal: false,
    closeOnPressEscape: false,
    showCancelButton: false // 强制输入
  })
  .then(({ value }) => {
    // 私有模式下，房间名不重要，随便给一个 'root'
    conn.connect('root', value)
  })
  .catch(() => {
    ElMessage.warning('必须输入密码才能使用')
  })
}

function copyLink() {
  navigator.clipboard.writeText(currentUrl.value)
  ElMessage.success('链接已复制')
}
</script>

<template>
  <div class="app-container">
    <el-row :gutter="20" justify="center">

      <template v-if="conn.isConnected">
        <el-col :xs="24" :sm="10" :md="8">
          <el-card class="box-card">
            <template #header>
              <div class="card-header">
                <span>
                  {{ conn.serverMode === 'private' ? '🔒 私有云盘' : `🏠 房间: ${conn.currentRoom}` }}
                </span>
                <el-tag type="success" effect="dark">在线</el-tag>
              </div>
            </template>

            <div class="qr-section">
              <qrcode-vue :value="currentUrl" :size="180" level="M" />
              <p class="hint">扫码加入 (P2P 直连)</p>
            </div>

            <el-input v-model="currentUrl" readonly size="small">
              <template #append>
                <el-button :icon="CopyDocument" @click="copyLink" />
              </template>
            </el-input>
          </el-card>
        </el-col>

        <el-col :xs="24" :sm="12" :md="10">
          <el-card class="box-card">
            <template #header>🖥️ 控制台</template>

            <div v-if="conn.hostOnline">
              <el-result icon="success" title="C++ Host 在线" :sub-title="`IP: ${conn.hostIp}`">
                <template #extra>
                  <el-button type="primary">管理剪切板</el-button>
                </template>
              </el-result>
            </div>
            <div v-else>
              <el-empty description="等待本地主机接入..." />
            </div>
          </el-card>
        </el-col>
      </template>

      <el-col v-else :span="24" style="text-align: center; margin-top: 50px;">
        <el-icon class="is-loading" :size="30"><Loading /></el-icon>
        <p>正在连接服务器...</p>
      </el-col>

    </el-row>
  </div>
</template>

<style scoped>
.app-container { padding: 20px; max-width: 1000px; margin: 0 auto; }
.box-card { margin-bottom: 20px; }
.card-header { display: flex; justify-content: space-between; align-items: center; }
.qr-section { text-align: center; margin: 20px 0; }
.hint { font-size: 12px; color: #666; margin-top: 10px; }
</style>
