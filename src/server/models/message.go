package models

import "encoding/json"

// WebSocket 消息信封
type Message struct {
	Type    string          `json:"type"`    // 消息类型
	Payload json.RawMessage `json:"payload"` // 灵活的数据载荷
}

// 预定义消息类型常量 (可选，防手误)
const (
	MsgTypeInit          = "init"
	MsgTypeNoteUpdate    = "note_update"
	MsgTypeClipboardPush = "clipboard_push"
	MsgTypeRegisterHost  = "register_host"
	MsgTypeClipboardNew  = "clipboard_new" // 服务器广播给客户端的新条目
)
