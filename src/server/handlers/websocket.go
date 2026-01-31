package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"quiclink-server/config"
	"quiclink-server/models"
	"quiclink-server/store"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // 允许跨域
}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	if config.Current.AppMode == "private" {
		token := r.URL.Query().Get("token")
		if token != config.Current.AdminPassword {
			http.Error(w, "🔒 Forbidden: This is a private server.", http.StatusForbidden)
			return
		}
	}
	// 升级连接
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade Error:", err)
		return
	}

	// 获取房间 ID
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		roomID = "public_lobby"
	}
	room := store.GetOrCreateRoom(roomID)

	// 注册并确保退出时清理
	store.AddClient(room, conn)
	defer store.RemoveClient(room, conn)

	// 发送初始化数据
	initialPayload := map[string]interface{}{
		"notes":    room.Notes,
		"history":  room.History,
		"hostInfo": room.HostInfo,
	}
	conn.WriteJSON(map[string]interface{}{"type": models.MsgTypeInit, "payload": initialPayload})

	log.Printf("User joined room [%s]", roomID)

	// 消息循环
	for {
		var msg models.Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			break // 连接断开
		}

		// 业务逻辑路由
		switch msg.Type {

		// [PublicRoom] 更新便签
		case models.MsgTypeNoteUpdate:
			var note models.Note
			if err := json.Unmarshal(msg.Payload, &note); err == nil {
				updateRoomNote(room, note)
				store.Broadcast(room, msg) // 广播给其他人
			}

		// [PublicRoom] 发送剪切板/文件 Bullet
		case models.MsgTypeClipboardPush:
			var item models.ClipboardItem
			if err := json.Unmarshal(msg.Payload, &item); err == nil {
				item.Timestamp = time.Now().Unix()
				addClipboardItem(room, item)

				// 广播带时间戳的新 Bullet
				outBytes, _ := json.Marshal(item)
				store.Broadcast(room, models.Message{
					Type:    models.MsgTypeClipboardNew,
					Payload: outBytes,
				})
			}

		// [QuicRoom] 主机上线注册
		case models.MsgTypeRegisterHost:
			var hostInfo models.QuicHostInfo
			if err := json.Unmarshal(msg.Payload, &hostInfo); err == nil {
				updateHostInfo(room, &hostInfo)
				log.Printf("🚀 Host Online: %s", hostInfo.IP)
				// 广播告诉 Web 端
				store.Broadcast(room, msg)
			}
		}
	}
}

// --- 辅助函数 (操作 Store 数据) ---

func updateRoomNote(room *models.RoomData, newNote models.Note) {
	store.RoomMutex.Lock()
	defer store.RoomMutex.Unlock()

	found := false
	for i, n := range room.Notes {
		if n.ID == newNote.ID {
			room.Notes[i] = newNote
			found = true
			break
		}
	}
	if !found {
		room.Notes = append(room.Notes, newNote)
	}
}

func addClipboardItem(room *models.RoomData, item models.ClipboardItem) {
	store.RoomMutex.Lock()
	defer store.RoomMutex.Unlock()
	room.History = append(room.History, item)
	// 限制 50 条
	if len(room.History) > 50 {
		room.History = room.History[1:]
	}
}

func updateHostInfo(room *models.RoomData, info *models.QuicHostInfo) {
	store.RoomMutex.Lock()
	defer store.RoomMutex.Unlock()
	room.HostInfo = info
}
