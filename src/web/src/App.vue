<script setup lang="ts">
import { onMounted } from 'vue'
import { useConnectionStore } from './stores/connection'

const conn = useConnectionStore()

// 页面加载时自动连接
onMounted(() => {
  conn.connect()
})
</script>

<template>
  <div class="container">
    <el-card class="box-card">
      <template #header>
        <div class="card-header">
          <span>QuicLink Web</span>
          <el-tag v-if="conn.isConnected" type="success">云端在线</el-tag>
          <el-tag v-else type="danger">离线</el-tag>
        </div>
      </template>

      <div class="status-section">
        <h3>当前房间: test_room</h3>

        <div v-if="conn.hostOnline" class="host-found">
          <el-result
            icon="success"
            title="发现 Host 主机"
            :sub-title="`主机 IP: ${conn.hostIp}`"
          >
            <template #extra>
              <el-button type="primary">发起连接 (P2P)</el-button>
            </template>
          </el-result>
        </div>

        <div v-else class="host-missing">
          <el-empty description="等待 Host 上线..." />
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.container {
  display: flex;
  justify-content: center;
  padding-top: 50px;
}
.box-card {
  width: 400px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
