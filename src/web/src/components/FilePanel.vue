<script setup lang="ts">
import { Delete, Download, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage, type UploadProps } from 'element-plus'
import { computed, ref } from 'vue'
import { useConnectionStore } from '../stores/connection'

const conn = useConnectionStore()
const fileList = ref<any[]>([])

// 计算上传接口地址 (根据环境变量或默认值)
const uploadUrl = computed(() => {
  const host = import.meta.env.VITE_VPS_HOST || 'localhost:8080'
  return `http://${host}/upload`
})

// 上传成功回调
const handleSuccess: UploadProps['onSuccess'] = (response, uploadFile) => {
  // response 是 Go 后端返回的 JSON: { url: "/files/...", name: "..." }
  if (response.url) {
    // 修正 URL (加上 host)
    const host = import.meta.env.VITE_VPS_HOST || 'localhost:8080'
    uploadFile.url = `http://${host}${response.url}`
    ElMessage.success('上传成功')
  }
}

const handleError: UploadProps['onError'] = () => {
  ElMessage.error('上传失败 (可能超过大小限制)')
}
</script>

<template>
  <el-card class="file-card">
    <template #header>
      <div class="card-header">
        <span>☁️ 云端文件中转 (临时)</span>
        <el-tag size="small" type="info">10分钟后删除</el-tag>
      </div>
    </template>

    <el-upload
      class="upload-demo"
      drag
      :action="uploadUrl"
      multiple
      :on-success="handleSuccess"
      :on-error="handleError"
      :file-list="fileList"
    >
      <el-icon class="el-icon--upload"><upload-filled /></el-icon>
      <div class="el-upload__text">
        拖拽文件到此处，或 <em>点击上传</em>
      </div>
    </el-upload>

    <div class="file-list" v-if="fileList.length > 0">
      <div v-for="file in fileList" :key="file.uid" class="file-item">
        <span class="fname">{{ file.name }}</span>
        <div class="factions" v-if="file.status === 'success'">
           <a :href="file.url" target="_blank" style="margin-right: 10px;">
             <el-button circle :icon="Download" size="small" type="success" plain />
           </a>
           <el-button circle :icon="Delete" size="small" type="danger" plain @click="fileList.splice(fileList.indexOf(file), 1)"/>
        </div>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; }
.file-list { margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px; }
.file-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px dashed #eee; }
.fname { font-size: 14px; color: #333; }
</style>
