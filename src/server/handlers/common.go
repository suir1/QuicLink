package handlers

import (
	"encoding/json"
	"log"
	"quiclink-server/store"
	"strconv"
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
			baseUpdatedAt := parseInt64(payload["baseUpdatedAt"])

			if id != "" {
				updated, status := room.UpdateNote(id, title, content, baseUpdatedAt)
				if status == store.NoteUpdateApplied {
					_ = conn.WriteJSON(Message{
						Type:    "notepad_ack",
						Payload: updated,
					})
					room.Broadcast(Message{
						Type:    "notepad_update",
						Payload: updated,
					}, conn)
				} else if status == store.NoteUpdateConflict {
					_ = conn.WriteJSON(Message{
						Type:    "notepad_conflict",
						Payload: updated,
					})
				} else if status == store.NoteUpdateDeleted {
					_ = conn.WriteJSON(Message{
						Type: "notepad_delete",
						Payload: map[string]interface{}{
							"id": id,
						},
					})
				}
			}
		}

		// --- 记事本删除 (Notepad Delete) ---
	case "notepad_delete":
		payload, ok := msg.Payload.(map[string]interface{})
		if ok {
			id, _ := payload["id"].(string)
			if id != "" {
				room.DeleteNote(id)
				_ = conn.WriteJSON(Message{
					Type: "notepad_delete_ack",
					Payload: map[string]interface{}{
						"id": id,
					},
				})
				room.Broadcast(msg, conn)
			}
		}

	case "clipboard_push":
		// Web/Host 发送了新文本 -> 广播给对面 (包括发送者自己，以同步 Server ID)
		if payload, ok := msg.Payload.(map[string]interface{}); ok {
			if text, ok := payload["text"].(string); ok {
				// Log entire payload keys to debug missing ID
				// log.Printf("📥 Clipboard Push Keys: %v", payload)

				// Try to get client-provided ID (Handle both string and number types)
				var id string
				if val, ok := payload["id"].(string); ok {
					id = val
				} else if val, ok := payload["id"].(float64); ok {
					id = strconv.FormatFloat(val, 'f', 0, 64)
				} else {
					log.Printf("⚠️ ID Parsing Failed! Payload['id'] is Type: %T, Value: %v", payload["id"], payload["id"])
				}
				// log.Printf("📥 Clipboard Push: Len=%d", len(text))

				item := room.AddClipboardItem(text, id)
				if item != nil {
					if id == "" {
						log.Printf("⚠️ Warning: AddClipboardItem called with empty ID (Server generated: %s)", item.ID)
					}
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

					// log.Printf("💾 Saved clipboard item [%s]", item.ID)
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
			if id, ok := parseStringID(payload["id"]); ok {
				room.DeleteClipboardItem(id)
				room.Broadcast(Message{
					Type: "clipboard_delete",
					Payload: map[string]interface{}{
						"id": id,
					},
				}, nil) // Broadcast to all (including sender) as delete ACK
				log.Printf("🗑️ Deleted clipboard item: %s", id)
			}
		}

	// --- WebRTC 信令转发 (P2P Signaling) ---
	case "offer", "answer", "candidate":
		room.Broadcast(msg, conn)

	// --- P2P 文件传输信令 ---
	case "file_offer", "file_request", "file_chunk", "file_accept", "p2p_hello":
		// 直接广播给房间内其他人
		room.Broadcast(msg, conn)

	// --- LAN Discovery ---
	case "lan_info":
		room.Broadcast(msg, conn)

	// --- LAN 文件共享信令 ---
	case "lan_file_offer", "lan_file_request", "lan_file_ready", "lan_file_shared",
		"lan_file_consumed", "lan_file_failed", "lan_list_request", "lan_list_response", "lan_download_request",
		"p2p_relay_offer", "p2p_relay_request", "p2p_relay_ready", "p2p_offer_removed",
		"netdisk_file", "vps_relay_offer", "vps_relay_ack":
		room.Broadcast(msg, conn)

	// --- 心跳检测 ---
	case "ping":
		conn.WriteJSON(Message{Type: "pong"})

	default:
		// 未知消息，忽略
	}

	return true
}

func parseInt64(raw interface{}) int64 {
	switch v := raw.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		i, err := v.Int64()
		if err == nil {
			return i
		}
	case string:
		if v == "" {
			return 0
		}
		i, err := strconv.ParseInt(v, 10, 64)
		if err == nil {
			return i
		}
	}
	return 0
}

func parseStringID(raw interface{}) (string, bool) {
	switch v := raw.(type) {
	case string:
		if v == "" {
			return "", false
		}
		return v, true
	case int:
		return strconv.FormatInt(int64(v), 10), true
	case int64:
		return strconv.FormatInt(v, 10), true
	case float64:
		return strconv.FormatInt(int64(v), 10), true
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			return "", false
		}
		return strconv.FormatInt(i, 10), true
	default:
		return "", false
	}
}

// SendInitState 发送房间初始化状态
func SendInitState(room *store.Room, conn store.Connection, roomId string) error {
	notesList := room.SnapshotNotes()
	clipboardHistory := room.SnapshotClipboardHistory()

	initMsg := Message{
		Type: "init",
		Payload: map[string]interface{}{
			"room_id":          roomId,
			"hostInfo":         room.HostInfo,
			"notes":            notesList,
			"clipboardHistory": clipboardHistory,
			"createdAt":        room.CreatedAt.Unix(),
		},
	}
	log.Printf("📤 Sending Init State to client. History Size: %d", len(clipboardHistory))
	return conn.WriteJSON(initMsg)
}
