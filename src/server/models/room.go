package models

import "github.com/gorilla/websocket"

// 便签 (支持多便签)
type Note struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

// 剪切板条目
type ClipboardItem struct {
	ID         string `json:"id"`
	Type       string `json:"type"`       // "text" | "file" | "image"
	Content    string `json:"content"`    // 文本内容 或 文件名
	Url        string `json:"url"`        // 下载链接 (如果是文件)
	Timestamp  int64  `json:"timestamp"`  // 时间戳
	Source     string `json:"source"`     // 来源设备 (e.g., "MacBook Pro")
	DeviceType string `json:"deviceType"` // "mac", "win", "web"
}

// QuicRoom 的主机信息 (信令用)
type QuicHostInfo struct {
	IP       string `json:"ip"`
	Port     int    `json:"port"`
	CertHash string `json:"certHash"`
}

// 房间状态 (核心结构)
type RoomData struct {
	ID string `json:"id"`

	// --- Public Room 数据 (存 VPS 内存) ---
	Notes   []Note          `json:"notes"`
	History []ClipboardItem `json:"history"`

	// --- Quic Room 数据 (信令转发) ---
	HostInfo *QuicHostInfo `json:"hostInfo,omitempty"`

	// --- 内部连接管理 (不导出到 JSON) ---
	Clients map[*websocket.Conn]bool `json:"-"`
}
