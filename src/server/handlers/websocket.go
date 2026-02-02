package handlers

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"quiclink-server/config"
	"quiclink-server/store"
)

// Message 定义前后端通信的标准 JSON 格式
type Message struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

// WebSocket 升级器配置 (允许跨域)
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// ---------------------------------------------------------
	// 1. 安全鉴权 (Private Mode Check)
	// ---------------------------------------------------------
	if config.Current.AppMode == "private" {
		token := r.URL.Query().Get("token")
		// 如果 URL 里没带 token 或者 token 不对
		if token != config.Current.AdminPassword {
			log.Printf("🔒 Blocked unauthorized access from %s", r.RemoteAddr)
			http.Error(w, "Forbidden: Private Mode needs valid token", http.StatusForbidden)
			return
		}
	}

	// ---------------------------------------------------------
	// 2. 协议升级 (HTTP -> WebSocket)
	// ---------------------------------------------------------
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("❌ Upgrade error:", err)
		return
	}

	// ---------------------------------------------------------
	// 3. 房间处理 (Room Management)
	// ---------------------------------------------------------
	// 获取房间ID，默认为 "public"
	roomId := r.URL.Query().Get("room")
	if roomId == "" {
		roomId = "public"
	}

	// 获取或创建房间对象
	room := store.GetOrCreateRoom(roomId)

	// 加入房间
	room.Join(conn)

	// 退出时的清理工作
	defer func() {
		room.Leave(conn)
	}()

	// ---------------------------------------------------------
	// 4. 发送初始化状态 (Init State)
	// ---------------------------------------------------------
	// 获取所有笔记列表
	notesList := make([]*store.Note, 0, len(room.Notes))
	for _, n := range room.Notes {
		notesList = append(notesList, n)
	}

	initMsg := Message{
		Type: "init",
		Payload: map[string]interface{}{
			"room_id":  roomId,
			"hostInfo": room.HostInfo,
			"notes":    notesList, // 发送笔记列表
		},
	}
	conn.WriteJSON(initMsg)

	// ---------------------------------------------------------
	// 5. 消息循环 (Message Loop)
	// ---------------------------------------------------------
	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			break
		}

		switch msg.Type {

		// --- 角色注册 ---
		case "register_host":
			room.SetHost(conn, msg.Payload)
			room.Broadcast(msg, conn)

		// --- 记事本更新/创建 (Notepad Update) ---
		case "notepad_update":
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				id, _ := payload["id"].(string)
				title, _ := payload["title"].(string)
				content, _ := payload["content"].(string)

				if id != "" {
					room.UpdateNote(id, title, content)
					room.Broadcast(msg, conn)
				}
			}

		// --- 记事本删除 (Notepad Delete) ---
		case "notepad_delete":
			payload, ok := msg.Payload.(map[string]interface{})
			if ok {
				id, _ := payload["id"].(string)
				if id != "" {
					room.DeleteNote(id)
					room.Broadcast(msg, conn)
				}
			}

		// --- 剪切板同步 (Clipboard) ---
		case "clipboard_push":
			// Web/Host 发送了新文本 -> 广播给对面
			room.Broadcast(msg, conn)

		case "clipboard_pull":
			// Web 请求获取剪切板 -> 转发给 Host
			// 这里简单起见直接广播，Host 收到会响应
			room.Broadcast(msg, conn)

		case "clipboard_data":
			// Host 响应了剪切板内容 -> 广播给 Web
			room.Broadcast(msg, conn)

		// --- WebRTC 信令转发 (P2P Signaling) ---
		// offer, answer, candidate 这些是 P2P 握手必须的消息
		// 服务器只负责透传，不看内容
		case "offer", "answer", "candidate":
			room.Broadcast(msg, conn)

		// --- 心跳检测 (可选) ---
		case "ping":
			conn.WriteJSON(Message{Type: "pong"})
		}
	}
}
