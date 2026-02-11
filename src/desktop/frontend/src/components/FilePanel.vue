<script setup lang="ts">
import { Cloudy, Delete, Download, FolderOpened, Monitor, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage, type UploadProps } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection'

const conn = useConnectionStore()
const activeTab = ref('lan')
const downloadDir = ref('')

// --- Desktop native calls ---
const wailsApp = () => (window as any).go?.main?.App

const fetchDownloadDir = async () => {
    const app = wailsApp()
    if (app) {
        downloadDir.value = await app.GetDownloadDir()
    }
}

const changeDownloadDir = async () => {
    const app = wailsApp()
    if (app) {
        const newDir = await app.SelectDownloadDir()
        if (newDir) {
            downloadDir.value = newDir
            ElMessage.success('下载路径已更新')
        }
    }
}

const openDownloadFolder = () => {
    const app = wailsApp()
    if (app) {
        app.OpenDownloadDir()
    }
}

// --- LAN Drive Logic (Desktop IS the LAN server) ---
const lanFileList = ref<any[]>([])
const lanPort = ref(0)

const fetchLanPort = async () => {
    const app = wailsApp()
    if (app && app.GetLocalServerPort) {
        lanPort.value = await app.GetLocalServerPort()
    }
}

const lanUploadUrl = computed(() => `http://localhost:${lanPort.value}/api/lan/upload`)

const fetchLanFiles = async () => {
    if (!lanPort.value) return
    try {
        const res = await fetch(`http://localhost:${lanPort.value}/api/lan/files`)
        if (res.ok) {
            lanFileList.value = await res.json()
        }
    } catch (e) {
        console.error("Failed to fetch LAN files", e)
    }
}

const handleLanSuccess: UploadProps['onSuccess'] = () => {
    ElMessage.success('文件已添加到 LAN 共享')
    fetchLanFiles()
}

const openLanDownload = (file: any) => {
    window.open(`http://localhost:${lanPort.value}/api/lan/download/${file.id}`, '_blank')
}

// --- Cloud Drive Logic ---
const cloudFileList = ref<any[]>([])

const VPS_HOST = import.meta.env.VITE_VPS_HOST || 'localhost:3100'
const HTTP_URL = `http://${VPS_HOST}`

const cloudUploadUrl = computed(() => `${HTTP_URL}/upload`)

const handleCloudSuccess: UploadProps['onSuccess'] = (response, uploadFile) => {
  if (response.url) {
      uploadFile.url = `${HTTP_URL}${response.url}`
      ElMessage.success('云端上传成功')
      fetchCloudFiles()
  }
}

const fetchCloudFiles = async () => {
    try {
        const res = await fetch(`${HTTP_URL}/api/files`)
        if (res.ok) {
            const files = await res.json()
            cloudFileList.value = files.map((f: any) => ({
                name: f.name,
                url: `${HTTP_URL}${f.url}`,
                status: 'success',
                uid: f.id,
                size: f.size
            }))
        }
    } catch (e) {
        console.error("Fetch Cloud Files Failed", e)
    }
}

// Tab switch
watch(activeTab, (val) => {
    if (val === 'cloud') fetchCloudFiles()
    if (val === 'lan') fetchLanFiles()
})

// Format helpers
const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return (bytes / Math.pow(k, i)).toPrecision(3) + ' ' + sizes[i]
}

onMounted(async () => {
    await fetchLanPort()
    fetchLanFiles()
    fetchCloudFiles()
    fetchDownloadDir()
})
</script>

<template>
  <el-card class="file-card" :body-style="{ padding: '0px', height: '100%', display: 'flex', flexDirection: 'column' }">
    <template #header>
      <div class="card-header">
         <el-tabs v-model="activeTab" class="file-tabs">
            <el-tab-pane name="lan">
                <template #label>
                    <span class="tab-label">
                        <el-icon><Monitor /></el-icon> 局域网加速
                        <el-tag size="small" type="success" effect="dark" round class="lan-tag">本机</el-tag>
                    </span>
                </template>
            </el-tab-pane>
            <el-tab-pane name="cloud">
                <template #label>
                    <span class="tab-label"><el-icon><Cloudy /></el-icon> 云端中转</span>
                </template>
            </el-tab-pane>
         </el-tabs>
          <div class="header-right" v-if="activeTab === 'lan'">
               <el-button link :icon="FolderOpened" @click="openDownloadFolder" title="打开下载文件夹">打开文件夹</el-button>
          </div>
      </div>
    </template>

    <div class="tab-content">
        <!-- LAN Drive View (Desktop is the server) -->
        <div v-if="activeTab === 'lan'" class="pane-content">
             <div class="upload-area">
                <el-upload
                    class="upload-demo"
                    drag
                    :action="lanUploadUrl"
                    multiple
                    :show-file-list="false"
                    :on-success="handleLanSuccess"
                >
                    <el-icon class="el-icon--upload"><upload-filled /></el-icon>
                    <div class="el-upload__text">
                        添加文件到 LAN 共享
                    </div>
                </el-upload>
            </div>

            <div class="file-list-container">
                <div class="list-header">
                    <span>本机共享文件列表</span>
                    <div class="header-actions">
                         <div class="path-display" v-if="downloadDir">
                            <span class="path-text" :title="downloadDir">保存至: {{ downloadDir }}</span>
                            <el-button link type="primary" size="small" @click="changeDownloadDir">修改</el-button>
                         </div>
                         <el-button size="small" link @click="fetchLanFiles">刷新</el-button>
                    </div>
                </div>
                <div v-if="lanFileList.length === 0" class="empty-tip">暂无共享文件</div>
                <div v-for="file in lanFileList" :key="file.id" class="file-item">
                    <div class="file-info-col">
                        <span class="fname">{{ file.name }}</span>
                        <span class="fsize">{{ formatSize(file.size) }}</span>
                    </div>
                    <div class="factions">
                        <el-button circle :icon="Download" size="small" type="primary" plain @click="openLanDownload(file)" />
                    </div>
                </div>
            </div>
        </div>

        <!-- Cloud Drive View -->
        <div v-if="activeTab === 'cloud'" class="pane-content">
            <div class="upload-area">
                <el-upload
                    class="upload-demo"
                    drag
                    :action="cloudUploadUrl"
                    multiple
                    :on-success="handleCloudSuccess"
                    :file-list="cloudFileList"
                >
                    <el-icon class="el-icon--upload"><upload-filled /></el-icon>
                    <div class="el-upload__text">
                        上传到 VPS (临时存储)
                    </div>
                </el-upload>
            </div>

            <div class="file-list-container">
                <div v-if="cloudFileList.length === 0" class="empty-tip">暂无上传文件</div>
                <div v-for="file in cloudFileList" :key="file.uid" class="file-item">
                    <span class="fname">{{ file.name }}</span>
                    <div class="factions" v-if="file.status === 'success'">
                        <a :href="file.url" target="_blank">
                            <el-button circle :icon="Download" size="small" type="success" plain />
                        </a>
                        <el-button circle :icon="Delete" size="small" type="danger" plain @click="cloudFileList.splice(cloudFileList.indexOf(file), 1)"/>
                    </div>
                </div>
            </div>
        </div>
    </div>
  </el-card>
</template>

<style scoped>
.file-card {
    height: 100%;
    border: none;
}

.card-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-right: 15px;
}
.file-tabs :deep(.el-tabs__header) {
    margin: 0;
}
.file-tabs :deep(.el-tabs__nav-wrap::after) {
    display: none;
}
.tab-label {
    display: flex;
    align-items: center;
    gap: 6px;
}
.lan-tag {
    transform: scale(0.8);
}

.tab-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.pane-content {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 15px;
    overflow-y: auto;
}

.upload-area {
    margin-bottom: 20px;
}

.file-list-container {
    flex: 1;
}

.file-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    border-bottom: 1px solid var(--el-border-color-light);
    background: var(--el-bg-color-overlay);
    margin-bottom: 5px;
    border-radius: 4px;
}

.file-info-col {
    display: flex;
    flex-direction: column;
}

.fname {
    font-size: 14px;
    font-weight: 500;
    color: var(--el-text-color-primary);
}

.fsize {
    font-size: 12px;
    color: var(--el-text-color-secondary);
}

.empty-tip {
    text-align: center;
    color: var(--el-text-color-placeholder);
    padding: 20px;
    font-size: 13px;
}

.list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
}

.header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
}
.path-display {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
    padding: 2px 8px;
    border-radius: 4px;
}
.path-text {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
