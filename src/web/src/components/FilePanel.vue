<script setup lang="ts">
import { Cloudy, Delete, Download, Folder, FolderOpened, Monitor, Share, Upload, UploadFilled } from '@element-plus/icons-vue'
import { ElMessage, type UploadProps } from 'element-plus'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '../stores/connection'

const conn = useConnectionStore()
const activeTab = ref('lan')
const downloadDir = ref('')
const transfer = computed(() => conn.transferTelemetry)

const transferPathLabel = computed(() => {
    const path = transfer.value?.path
    switch (path) {
        case 'lan-wt-relay': return 'LAN WT Relay'
        case 'lan-http-relay': return 'LAN HTTP Relay'
        case 'lan-wt-direct': return 'LAN WT Direct'
        case 'lan-http-direct': return 'LAN HTTP Direct'
        case 'webrtc': return 'WebRTC'
        case 'vps-relay': return 'VPS Relay'
        case 'browser-url': return 'Browser URL'
        case 'cloud': return 'Cloud'
        default: return 'N/A'
    }
})

const transferStatusLabel = computed(() => {
    const status = transfer.value?.status || 'idle'
    switch (status) {
        case 'active': return '传输中'
        case 'done': return '完成'
        case 'handoff': return '已交给浏览器下载'
        case 'error': return '失败'
        default: return '空闲'
    }
})

const transferSpeedText = computed(() => {
    const bps = Number(transfer.value?.speedBps || 0)
    if (bps <= 0) return '--'
    const mbps = bps / (1024 * 1024)
    return `${mbps.toFixed(mbps >= 10 ? 1 : 2)} MB/s`
})

const transferRouteText = computed(() => {
    const route = String((transfer.value as any)?.route || '').trim()
    return route || '--'
})

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
interface LanSharedFile {
    id: string
    name: string
    size: number
    status: 'pending' | 'uploading' | 'ready'  // pending=还在发送者 uploading=上传中 ready=在桌面端
    lanFileId?: string    // File ID on desktop server (when ready)
    ip?: string
    httpPort?: number
    h3Port?: number
    certHash?: string
    isRelay?: boolean // Phase 9: Relay Flag
    source: 'local' | 'remote'  // local=我共享的 remote=别人共享的
}

type DownloadResult = {
    ok: boolean
    handoff: boolean
}

const lanFileList = ref<any[]>([])                    // Files already on desktop's LAN server
const sharedFiles = ref<Map<string, LanSharedFile>>(new Map())  // Lazy shared files
const isLanAvailable = computed(() => !!conn.lanServerUrl)
const LAN_UPLOAD_REQUEST_TIMEOUT_MS = 25_000

const lanServerList = computed(() => Array.from(conn.lanServers.values()))
const currentHostId = computed({
    get: () => {
        for (const s of conn.lanServers.values()) {
            const serverUrl = `http://${s.ip}:${s.httpPort}`
            if (serverUrl === conn.lanServerUrl) return s.id
        }
        return lanServerList.value[0]?.id || ''
    },
    set: (val) => conn.switchLanHost(val)
})

// Fetch files from desktop via WebTransport (bypasses Mixed Content)
const fetchLanFiles = async () => {
    if (!conn.lanServerUrl) return
    try {
        lanFileList.value = await conn.listLanFilesWT()
    } catch (e) {
        console.error("Failed to fetch LAN files", e)
    }
}

// --- Lazy Share: Add file to shared list (metadata only) ---
const shareFileInput = ref<HTMLInputElement | null>(null)

const triggerShareFile = () => {
    shareFileInput.value?.click()
}

const onShareFileSelected = async (e: Event) => {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    for (const file of input.files) {
        const shareId = conn.shareLanFile(file)
        sharedFiles.value.set(shareId, {
            id: shareId,
            name: file.name,
            size: file.size,
            status: 'pending',
            source: 'local'
        })
        ElMessage.success(`📋 ${file.name} 已加入共享列表，等待下载触发上传`)
    }
    input.value = '' // reset
}

// --- Handle P2P events for lazy sharing ---
// --- Handle LAN events for lazy sharing ---
const handleLanEvent = (type: string, data: any) => {
    if (type === 'lan_offer') {
        const existing = sharedFiles.value.get(data.id)
        if (existing && existing.source === 'local') {
            existing.status = data.status || existing.status
            existing.lanFileId = data.lanFileId || existing.lanFileId
            existing.ip = data.ip || existing.ip
            existing.httpPort = data.httpPort || existing.httpPort
            existing.h3Port = data.h3Port || existing.h3Port
            existing.certHash = data.certHash || existing.certHash
            existing.isRelay = data.isRelay ?? existing.isRelay
            return
        }

        const file: LanSharedFile = {
            id: data.id,
            name: data.name,
            size: data.size,
            status: data.status || 'pending',
            source: 'remote',
            ip: data.ip,
            httpPort: data.httpPort,
            h3Port: data.h3Port,
            certHash: data.certHash,
            lanFileId: data.lanFileId,
            isRelay: data.isRelay
        }
        sharedFiles.value.set(data.id, file)
    } else if (type === 'lan_ready') {
        const existing = sharedFiles.value.get(data.originalId)
        const autoDownload = !!existing && existing.source === 'remote' && existing.status === 'uploading'
        if (existing) {
            existing.status = 'ready'
            existing.lanFileId = data.lanFileId
            existing.ip = data.ip
            existing.httpPort = data.httpPort
            existing.h3Port = data.h3Port
            existing.certHash = data.certHash
            existing.isRelay = data.isRelay
        }
        ElMessage.success(`📥 ${data.name} 已就绪，可下载`)
        if (autoDownload && existing) {
            void requestDownload(existing)
        }
        if (data?.originalId) {
            clearLanRequestTimeout(data.originalId)
        }
        fetchLanFiles()
    } else if (type === 'lan_consumed') {
        const originalId = data?.originalId
        if (originalId && sharedFiles.value.has(originalId)) {
            sharedFiles.value.delete(originalId)
            downloadingFiles.value.delete(originalId)
            conn.removeSharedOffer(originalId)
        } else if (data?.lanFileId) {
            for (const [id, f] of sharedFiles.value.entries()) {
                if (f.lanFileId === data.lanFileId) {
                    sharedFiles.value.delete(id)
                    downloadingFiles.value.delete(id)
                    conn.removeSharedOffer(id)
                }
            }
        }
    } else if (type === 'lan_failed') {
        const originalId = data?.originalId
        if (originalId) {
            const existing = sharedFiles.value.get(originalId)
            if (existing && existing.source === 'remote') {
                existing.status = 'pending'
                existing.lanFileId = undefined
            }
            downloadingFiles.value.delete(originalId)
            clearLanRequestTimeout(originalId)
        }
        ElMessage.error(`中转失败: ${data?.reason || 'unknown'}`)
    } else if (type === 'lan_list') {
        lanFileList.value = data
    }
}

// --- Download logic ---
const downloadingFiles = ref<Set<string>>(new Set())
const lanRequestTimers = ref<Map<string, number>>(new Map())

const clearLanRequestTimeout = (id: string) => {
    const timer = lanRequestTimers.value.get(id)
    if (timer) {
        window.clearTimeout(timer)
        lanRequestTimers.value.delete(id)
    }
}

const scheduleLanRequestTimeout = (file: LanSharedFile) => {
    clearLanRequestTimeout(file.id)
    const timer = window.setTimeout(() => {
        lanRequestTimers.value.delete(file.id)
        const current = sharedFiles.value.get(file.id)
        if (!current || current.source !== 'remote') return
        if (current.status === 'uploading') {
            current.status = 'pending'
            current.lanFileId = undefined
            downloadingFiles.value.delete(file.id)
            ElMessage.warning(`等待超时，请重试下载: ${current.name}`)
        }
    }, LAN_UPLOAD_REQUEST_TIMEOUT_MS)
    lanRequestTimers.value.set(file.id, timer)
}

// --- Robust Download (WT -> HTTP Fallback) ---
const downloadLanFile = async (
    lanFileId: string,
    name: string,
    ip?: string,
    httpPort?: number,
    isRelay?: boolean,
    h3Port?: number,
    certHash?: string,
    autoTriggered = false
): Promise<DownloadResult> => {
    // Phase 9: Relay Download (Direct HTTP Stream)
    if (isRelay) {
        const server = conn.getActiveLanServer()
        const targetIp = ip || server?.ip
        const targetPort = httpPort || server?.httpPort
        const targetH3Port = h3Port || server?.h3Port
        const targetCertHash = certHash || server?.certHash

        if (!autoTriggered && !conn.isDesktop && !conn.isSpeedDownloadMode()) {
            const via = await conn.openLanDownloadURL(
                lanFileId,
                name,
                targetIp,
                targetPort,
                targetH3Port,
                true
            )
            if (via) {
                ElMessage.success(`📥 ${name} 开始下载 (${via.toUpperCase()})`)
                return { ok: true, handoff: true }
            }
            ElMessage.error('无法获取中转地址')
            return { ok: false, handoff: false }
        }

        try {
            const ok = await conn.downloadLanRelayWT(
                lanFileId,
                name,
                targetIp,
                targetH3Port,
                targetCertHash
            )
            if (ok) {
                ElMessage.success(`📥 ${name} 下载完成 (WT Relay)`)
                return { ok: true, handoff: false }
            }
        } catch (e) {
            console.warn('WT relay download failed, falling back to HTTP', e)
        }

        if (autoTriggered && !conn.isSpeedDownloadMode()) {
            ElMessage.warning(`自动下载失败，请点击再次下载: ${name}`)
            return { ok: false, handoff: false }
        }

        const via = await conn.openLanDownloadURL(
            lanFileId,
            name,
            targetIp,
            targetPort,
            targetH3Port,
            true
        )
        if (via) {
            ElMessage.success(`📥 ${name} 开始中转下载 (${via.toUpperCase()})`)
            return { ok: true, handoff: true }
        } else {
            ElMessage.error('无法获取中转地址')
            return { ok: false, handoff: false }
        }
    }

    const server = conn.getActiveLanServer()
    const targetIp = ip || server?.ip
    const targetPort = httpPort || server?.httpPort
    const targetH3Port = h3Port || server?.h3Port

    if (!conn.isDesktop && !conn.isSpeedDownloadMode()) {
        const via = await conn.openLanDownloadURL(
            lanFileId,
            name,
            targetIp,
            targetPort,
            targetH3Port,
            false
        )
        if (via) {
            ElMessage.success(`📥 ${name} 开始下载 (${via.toUpperCase()})`)
            return { ok: true, handoff: true }
        }
        ElMessage.error('无法获取下载地址')
        return { ok: false, handoff: false }
    }

    // 1. Try WebTransport first
    try {
        const ok = await conn.downloadLanFileWT(lanFileId, name)
        if (ok) {
            ElMessage.success(`📥 ${name} 下载完成 (WT)`)
            return { ok: true, handoff: false }
        }
    } catch (e) {
        console.warn('WT download failed, falling back to HTTP', e)
    }

    // 2. Fallback to URL Download (HTTPS first, then HTTP)
    const via = await conn.openLanDownloadURL(
        lanFileId,
        name,
        targetIp,
        targetPort,
        targetH3Port,
        false
    )
    if (via) {
        ElMessage.success(`📥 ${name} 开始下载 (${via.toUpperCase()})`)
        return { ok: true, handoff: true }
    } else {
        ElMessage.error('无法获取下载地址')
        return { ok: false, handoff: false }
    }
}

const requestDownload = async (file: LanSharedFile) => {
    if (file.status === 'ready' && file.lanFileId) {
        const autoTriggered = downloadingFiles.value.has(file.id)
        downloadingFiles.value.add(file.id)
        const result = await downloadLanFile(file.lanFileId, file.name, file.ip, file.httpPort, file.isRelay, file.h3Port, file.certHash, autoTriggered)
        if (result.ok && file.source === 'remote') {
            // URL handoff has no reliable completion callback, so treat successful handoff
            // as user-consumed intent and let lan_consumed event drive final cleanup.
            conn.notifyLanFileConsumed(file.id, file.lanFileId)
        }
        if (result.ok && file.source === 'remote' && !result.handoff) {
            sharedFiles.value.delete(file.id)
        }
        downloadingFiles.value.delete(file.id)
    } else if (file.status === 'pending' && file.source === 'remote') {
        downloadingFiles.value.add(file.id)
        file.status = 'uploading'
        conn.requestLanFile(file.id)
        scheduleLanRequestTimeout(file)
        ElMessage.info(`⏳ 正在请求 ${file.name}，等待上传到主机...`)
    }
}

const openLanDownload = async (file: any) => {
    downloadingFiles.value.add(file.id)
    await downloadLanFile(file.id, file.name)
    downloadingFiles.value.delete(file.id)
}

// Upload directly to desktop via WebTransport
const directUploadInput = ref<HTMLInputElement | null>(null)

const triggerDirectUpload = () => {
    directUploadInput.value?.click()
}

const onDirectUploadSelected = async (e: Event) => {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    for (const file of input.files) {
        try {
            await conn.uploadLanFileWT(file)
            ElMessage.success(`⚡ ${file.name} 已上传到主机`)
            fetchLanFiles()
        } catch (err) {
            ElMessage.error(`上传失败: ${file.name}`)
        }
    }
    input.value = ''
}

// Watch for LAN server discovery
watch(() => conn.lanServerUrl, (newUrl) => {
    if (newUrl) {
        activeTab.value = 'lan'
        fetchLanFiles()
    }
})

watch(activeTab, (val) => {
    if (val === 'cloud') fetchCloudFiles()
    if (val === 'lan') fetchLanFiles()
})

// Register event handler
onMounted(() => {
    fetchCloudFiles()
    if (conn.lanServerUrl) fetchLanFiles()
    if (conn.isDesktop) fetchDownloadDir()

    // Listen for LAN events
    // Listen for LAN events
    conn.onLanEvent = handleLanEvent
})

onBeforeUnmount(() => {
    for (const timer of lanRequestTimers.value.values()) {
        window.clearTimeout(timer)
    }
    lanRequestTimers.value.clear()
    if (conn.onLanEvent === handleLanEvent) {
        conn.onLanEvent = null
    }
})

// Shared files list (remote only)
const remoteSharedFiles = computed(() =>
    Array.from(sharedFiles.value.values()).filter(f => f.source === 'remote')
)
const localSharedFiles = computed(() =>
    Array.from(sharedFiles.value.values()).filter(f => f.source === 'local')
)

// Format helpers
const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return (bytes / Math.pow(k, i)).toPrecision(3) + ' ' + sizes[i]
}

const transferProgressText = computed(() => {
    const bytes = Number(transfer.value?.bytes || 0)
    const total = Number(transfer.value?.total || 0)
    if (!bytes && !total) return '--'
    return `${formatSize(bytes)} / ${total > 0 ? formatSize(total) : '未知'}`
})

const openDownloadFolder = () => {
    const w = window as any
    if (w.go && w.go.main && w.go.main.App) {
        w.go.main.App.OpenDownloadDir()
    } else {
        ElMessage.warning('仅桌面端支持打开文件夹')
    }
}

const statusLabel = (status: string) => {
    switch (status) {
        case 'pending': return '等待下载'
        case 'uploading': return '上传中...'
        case 'ready': return '可下载'
        default: return status
    }
}

const statusType = (status: string) => {
    switch (status) {
        case 'pending': return 'info'
        case 'uploading': return 'warning'
        case 'ready': return 'success'
        default: return 'info'
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
                        <el-button circle :icon="Delete" size="small" type="danger" plain @click="cloudFileList.splice(cloudFileList.indexOf(file), 1)"/>
                    </div>
                </div>
            </div>
        </div>

        <!-- LAN Drive View -->
        <div v-if="activeTab === 'lan'" class="pane-content">
            <!-- Offline State -->
            <div v-if="!isLanAvailable" class="lan-offline">
                <el-empty description="未发现局域网主机 (Desktop)">
                    <p class="sub-tip">请确保电脑端 QuicLink 已启动并在同一 WiFi 下</p>
                </el-empty>
            </div>

            <!-- LAN Connected -->
            <div v-if="isLanAvailable" class="lan-connected">
                 <!-- Multi-Host Selector -->
                 <div v-if="lanServerList.length > 1" class="host-select-bar">
                    <span class="label">当前主机:</span>
                    <el-select v-model="currentHostId" size="small" style="width: 160px">
                        <el-option v-for="host in lanServerList" :key="host.id" :label="host.name" :value="host.id" />
                    </el-select>
                 </div>

                 <!-- Action Buttons Row -->
                 <div class="action-row">
                    <el-button type="primary" :icon="Upload" @click="triggerShareFile" plain>
                        共享文件到列表
                    </el-button>
                    <el-button type="success" :icon="Upload" plain @click="triggerDirectUpload">
                        直接上传到主机
                    </el-button>
                    <input ref="directUploadInput" type="file" multiple hidden @change="onDirectUploadSelected" />
                    <input ref="shareFileInput" type="file" multiple hidden @change="onShareFileSelected" />
                 </div>

                 <div class="transfer-diagnostics">
                    <span><strong>通道:</strong> {{ transferPathLabel }}</span>
                    <span><strong>状态:</strong> {{ transferStatusLabel }}</span>
                    <span><strong>链路:</strong> {{ transferRouteText }}</span>
                    <span><strong>速率:</strong> {{ transferSpeedText }}</span>
                    <span><strong>进度:</strong> {{ transferProgressText }}</span>
                 </div>

                 <!-- Section: Shared Files (lazy, not yet uploaded) -->
                 <div v-if="remoteSharedFiles.length > 0 || localSharedFiles.length > 0" class="lan-section">
                    <div class="section-title">
                        <el-icon><Share /></el-icon>
                        <span>共享列表 (点击下载)</span>
                    </div>

                    <!-- My shared files -->
                    <div v-for="file in localSharedFiles" :key="file.id" class="file-item shared-item">
                        <div class="file-info-col">
                            <div class="fname-row">
                                <span class="fname">{{ file.name }}</span>
                                <el-tag size="small" type="info" round>我共享的</el-tag>
                                <el-tag size="small" :type="statusType(file.status)" round>{{ statusLabel(file.status) }}</el-tag>
                            </div>
                            <span class="fsize">{{ formatSize(file.size) }}</span>
                        </div>
                    </div>

                    <!-- Others' shared files -->
                    <div v-for="file in remoteSharedFiles" :key="file.id" class="file-item shared-item">
                        <div class="file-info-col">
                            <div class="fname-row">
                                <span class="fname">{{ file.name }}</span>
                                <el-tag size="small" :type="statusType(file.status)" round>{{ statusLabel(file.status) }}</el-tag>
                            </div>
                            <span class="fsize">{{ formatSize(file.size) }}</span>
                        </div>
                        <div class="factions">
                            <el-button
                                circle
                                :icon="Download"
                                size="small"
                                type="primary"
                                plain
                                :loading="downloadingFiles.has(file.id)"
                                :disabled="file.status === 'uploading'"
                                @click="requestDownload(file)"
                                :title="file.status === 'ready' ? '从主机下载' : '请求下载 (通过主机中转)'"
                            />
                        </div>
                    </div>
                 </div>

                 <!-- Section: Desktop Server Files -->
                 <div class="lan-section">
                    <div class="section-title">
                        <el-icon><Folder /></el-icon>
                        <span>主机文件</span>
                        <el-button size="small" link @click="fetchLanFiles" style="margin-left: auto;">刷新</el-button>
                    </div>

                    <div v-if="lanFileList.length === 0" class="empty-tip">主机暂无文件</div>
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

                 <!-- Desktop path config -->
                 <div v-if="conn.isDesktop && downloadDir" class="path-bar">
                    <span class="path-text" :title="downloadDir">📂 {{ downloadDir }}</span>
                    <el-button link type="primary" size="small" @click="changeDownloadDir">修改</el-button>
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
.file-tabs :deep(.el-tabs__header) { margin: 0; }
.file-tabs :deep(.el-tabs__nav-wrap::after) { display: none; }
.tab-label { display: flex; align-items: center; gap: 6px; }
.lan-tag { transform: scale(0.8); }

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

.upload-area { margin-bottom: 20px; }
.file-list-container { flex: 1; }

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

.shared-item {
    border-left: 3px solid var(--el-color-primary-light-3);
}

.file-info-col { display: flex; flex-direction: column; gap: 2px; }
.fname-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.fname { font-size: 14px; font-weight: 500; color: var(--el-text-color-primary); }
.fsize { font-size: 12px; color: var(--el-text-color-secondary); }

.empty-tip {
    text-align: center;
    color: var(--el-text-color-placeholder);
    padding: 20px;
    font-size: 13px;
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

/* LAN layout */
.lan-connected {
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100%;
}

.action-row {
    display: flex;
    gap: 10px;
    align-items: center;
}

.transfer-diagnostics {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    font-size: 12px;
    color: var(--el-text-color-regular);
    background: var(--el-fill-color-lighter);
    border: 1px solid var(--el-border-color-light);
    border-radius: 8px;
    padding: 8px 10px;
}

.transfer-diagnostics strong {
    color: var(--el-text-color-primary);
    font-weight: 600;
}

.lan-section {
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-light);
    border-radius: 8px;
    padding: 12px;
}

.section-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-text-color-regular);
    margin-bottom: 10px;
}

.path-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-light);
    padding: 6px 10px;
    border-radius: 6px;
}
.path-text {
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>
