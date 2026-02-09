<script setup lang="ts">
import { Cloudy, Delete, Download, Folder, FolderOpened, Monitor, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage, type UploadProps } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection'

const conn = useConnectionStore()
const activeTab = ref('cloud')
const folderOpenedIcon = FolderOpened
const folderIcon = Folder
const downloadDir = ref('')

const fetchDownloadDir = async () => {
    const w = window as any
    if (w.go && w.go.main && w.go.main.App) {
        downloadDir.value = await w.go.main.App.GetDownloadDir()
    }
}

const changeDownloadDir = async () => {
    const w = window as any
    if (w.go && w.go.main && w.go.main.App) {
        const newDir = await w.go.main.App.SelectDownloadDir()
        if (newDir) {
            downloadDir.value = newDir
            ElMessage.success('下载路径已更新')
        }
    }
}

// --- Cloud Drive Logic ---
const cloudFileList = ref<any[]>([])
const cloudUploadUrl = computed(() => `${conn.HTTP_URL}/upload`)

const handleCloudSuccess: UploadProps['onSuccess'] = (response, uploadFile) => {
  if (response.url) {
      ElMessage.success('云端上传成功')
      fetchCloudFiles()
  }
}

const fetchCloudFiles = async () => {
    try {
        const res = await fetch(`${conn.HTTP_URL}/api/files`)
        if (res.ok) {
            const files = await res.json()
            cloudFileList.value = files.map((f: any) => ({
                name: f.name,
                url: `${conn.HTTP_URL}${f.url}`,
                status: 'success',
                uid: f.id,
                size: f.size
            }))
        }
    } catch (e) {
        console.error("Fetch Cloud Files Failed", e)
    }
}

// --- LAN Drive Logic ---
const lanFileList = ref<any[]>([])
const lanUploadUrl = computed(() => `${conn.lanServerUrl}/api/lan/upload`)

const isLanAvailable = computed(() => !!conn.lanServerUrl)
const isLanTrusted = ref(false)

const lanServerList = computed(() => Array.from(conn.lanServers.values()))
const currentHostId = computed({
    get: () => {
        for (const s of conn.lanServers.values()) {
            // 比较通过 ip 和 httpPort 构建的 URL
            const serverUrl = `http://${s.ip}:${s.httpPort}`
            if (serverUrl === conn.lanServerUrl) return s.id
        }
        return lanServerList.value[0]?.id || ''
    },
    set: (val) => conn.switchLanHost(val)
})

// Fetch LAN files
const fetchLanFiles = async () => {
    if (!conn.lanServerUrl) return
    try {
        const res = await fetch(`${conn.lanServerUrl}/api/lan/files`)
        if (res.ok) {
            lanFileList.value = await res.json()
            isLanTrusted.value = true
        }
    } catch (e) {
        console.error("Failed to fetch LAN files", e)
        isLanTrusted.value = false
    }
}

const checkTrustDelayed = () => {
    setTimeout(fetchLanFiles, 3000)
    setTimeout(fetchLanFiles, 8000)
}

// Watch for LAN server discovery
watch(() => conn.lanServerUrl, (newUrl) => {
    if (newUrl) {
        activeTab.value = 'lan' // Auto switch to LAN if discovered
        fetchLanFiles()
    }
})

watch(activeTab, (val) => {
    if (val === 'cloud') fetchCloudFiles()
    if (val === 'lan') fetchLanFiles()
})

const handleLanSuccess: UploadProps['onSuccess'] = (response, uploadFile) => {
    ElMessage.success('LAN 上传成功')
    fetchLanFiles() // Refresh list
}

// Initial fetch if already connected
onMounted(() => {
    fetchCloudFiles()
    if (conn.lanServerUrl) fetchLanFiles()
    if (conn.isDesktop) fetchDownloadDir()
})

// Format helpers
const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return (bytes / Math.pow(k, i)).toPrecision(3) + ' ' + sizes[i]
}

const openLanDownload = (file: any) => {
    window.open(`${conn.lanServerUrl}/api/lan/download/${file.id}`, '_blank')
}

const openDownloadFolder = () => {
    // Call Backend
    const w = window as any
    if (w.go && w.go.main && w.go.main.App) {
        w.go.main.App.OpenDownloadDir()
    } else {
        ElMessage.warning('仅桌面端支持打开文件夹')
    }
}
</script>

<template>
  <el-card class="file-card" :body-style="{ padding: '0px', height: '100%', display: 'flex', flexDirection: 'column' }">
    <template #header>
      <div class="card-header">
         <el-tabs v-model="activeTab" class="file-tabs">
            <el-tab-pane name="cloud">
                <template #label>
                    <span class="tab-label"><el-icon><Cloudy /></el-icon> 云端中转</span>
                </template>
            </el-tab-pane>
            <el-tab-pane name="lan">
                <template #label>
                    <span class="tab-label">
                        <el-icon><Monitor /></el-icon> 局域网加速
                        <el-tag v-if="isLanAvailable" size="small" type="success" effect="dark" round class="lan-tag">Online</el-tag>
                    </span>
                </template>
            </el-tab-pane>
         </el-tabs>
          <div class="header-right" v-if="activeTab === 'lan' && conn.isDesktop">
               <el-button link :icon="FolderOpened" @click="openDownloadFolder" title="打开下载文件夹">打开文件夹</el-button>
          </div>
      </div>
    </template>

    <div class="tab-content">
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
                        <!-- Delete not implemented on backend yet, so just visual remove -->
                        <el-button circle :icon="Delete" size="small" type="danger" plain @click="cloudFileList.splice(cloudFileList.indexOf(file), 1)"/>
                    </div>
                </div>
            </div>
        </div>

        <!-- LAN Drive View -->
        <div v-if="activeTab === 'lan'" class="pane-content">
            <div v-if="!isLanAvailable" class="lan-offline">
                <el-empty description="未发现局域网主机 (Desktop)">
                    <p class="sub-tip">请确保电脑端 QuicLink 已启动并在同一 WiFi 下</p>
                </el-empty>
            </div>

            <div v-else-if="!isLanTrusted" class="lan-trust">
                 <el-result icon="warning" title="安全证书校验" sub-title="局域网 HTTPS 需要您手动信任证书">
                    <template #extra>
                        <a :href="conn.lanServerUrl + '/api/lan/files'" target="_blank" style="text-decoration: none;">
                            <el-button type="primary" @click="checkTrustDelayed">点击前往信任证书</el-button>
                        </a>
                        <div style="margin-top: 10px; font-size: 12px; color: #999;">
                            (在新标签页点击 "高级 -> 继续访问")
                        </div>
                    </template>
                 </el-result>
            </div>

            <div v-else>
                 <!-- Multi-Host Selector -->
                 <div v-if="lanServerList.length > 1" class="host-select-bar">
                    <span class="label">当前主机:</span>
                    <el-select v-model="currentHostId" size="small" style="width: 160px">
                        <el-option
                            v-for="host in lanServerList"
                            :key="host.id"
                            :label="host.name"
                            :value="host.id"
                        />
                    </el-select>
                 </div>

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
                            极速上传到主机 (LAN)
                        </div>
                    </el-upload>
                </div>

                <div class="file-list-container">
                    <div class="list-header">
                        <span>主机文件列表 ({{ conn.hostIp || 'LAN' }})</span>
                        <div class="header-actions">
                             <div class="path-display" v-if="conn.isDesktop && downloadDir">
                                <span class="path-text" :title="downloadDir">保存至: {{ downloadDir }}</span>
                                <el-button link type="primary" size="small" @click="changeDownloadDir">修改</el-button>
                             </div>
                             <el-button size="small" link @click="fetchLanFiles">刷新</el-button>
                        </div>
                    </div>
                    <div v-if="lanFileList.length === 0" class="empty-tip">主机暂无共享文件</div>
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
        </div>
    </div>
  </el-card>
</template>

<style scoped>
.file-card {
    height: 100%;
    border: none; /* Let container handle borders */
}

/* Custom Tabs in Header */
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

.lan-offline {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
}
.sub-tip {
    font-size: 12px;
    color: var(--el-text-color-secondary);
    margin-top: 5px;
}
.host-select-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 15px;
    padding: 0 5px;
}
.host-select-bar .label {
    font-size: 13px;
    color: var(--el-text-color-regular);
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
