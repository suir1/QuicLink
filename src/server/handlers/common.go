package handlers

import (
	"log"
	"quiclink-server/store"
)

// ProcessMessage 处理单个业务消息
// 返回 bool 表示是否继续循环 (true=继续, false=断开)
func ProcessMessage(room *store.Room, conn store.Connection, msg Message) bool {
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
				log.Printf("📝 Notepad update received: id=%s, title=%s", id, title)
				room.UpdateNote(id, title, content)
				// Broadcast the original message to others
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

	case "clipboard_push":
		// Web/Host 发送了新文本 -> 广播给对面 (包括发送者自己，以同步 Server ID)
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if text, ok := payload["text"].(string); ok {
				// Try to get client-provided ID
				id, _ := payload["id"].(string)

				item := room.AddClipboardItem(text, id)
				if item != nil {
					// Encode item to map for broadcast
					broadcastPayload := map[string]interface{}{
						"id":   item.ID,
						"text": item.Text,
						"time": item.Time,
						"type": item.Type,
					}
					// Broadcast 'clipboard_data' to ALL clients (including sender)
					room.Broadcast(Message{
						Type:    "clipboard_data",
						Payload: broadcastPayload,
					}, nil) // nil sender means broadcast to all

					log.Printf("💾 Saved clipboard item [%s]. Broadcasted to all.", item.ID)
				}
			}
		}
		// Notice: We do NOT broadcast the original 'clipboard_push' anymore,
		// because we replaced it with 'clipboard_data' containing the ID.

	case "clipboard_pull":
		// Web 请求获取剪切板 -> 转发给 Host
		room.Broadcast(msg, conn)

	case "clipboard_data":
		// Host 响应了剪切板内容 -> 广播给 Web
		room.Broadcast(msg, conn)

	// --- 剪切板删除 ---
	case "clipboard_delete":
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			// ID is now string to avoid precision loss
			if id, ok := payload["id"].(string); ok {
				room.DeleteClipboardItem(id)
				room.Broadcast(msg, conn) // Broadcast to sync deletion
				log.Printf("🗑️ Deleted clipboard item: %s. Remaining: %d", id, len(room.ClipboardHistory))
			}
		}

	// --- WebRTC 信令转发 (P2P Signaling) ---
	case "offer", "answer", "candidate":
		room.Broadcast(msg, conn)

	// --- P2P 文件传输信令 ---
	case "file_offer", "file_request", "file_chunk", "file_accept", "p2p_hello":
		// 直接广播给房间内其他人
		room.Broadcast(msg, conn)

	// --- 心跳检测 ---
	case "ping":
		conn.WriteJSON(Message{Type: "pong"})

	default:
		// 未知消息，忽略
	}

	return true
}

// SendInitState 发送房间初始化状态
func SendInitState(room *store.Room, conn store.Connection, roomId string) error {
	// 获取所有笔记列表
	notesList := make([]*store.Note, 0, len(room.Notes))
	for _, n := range room.Notes {
		notesList = append(notesList, n)
	}

	initMsg := Message{
		Type: "init",
		Payload: map[string]interface{}{
			"room_id":          roomId,
			"hostInfo":         room.HostInfo,
			"notes":            notesList,
			"clipboardHistory": room.ClipboardHistory,
			"createdAt":        room.CreatedAt.Unix(),
		},
	}
	log.Printf("📤 Sending Init State to client. History Size: %d", len(room.ClipboardHistory))
	return conn.WriteJSON(initMsg)
}
