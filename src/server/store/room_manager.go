package store

import (
	"log"
	"quiclink-server/models"
	"sync"

	"github.com/gorilla/websocket"
)

// 全局房间管理器
var (
	Rooms     = make(map[string]*models.RoomData)
	RoomMutex sync.RWMutex // 读写锁
)

// 获取或创建房间
func GetOrCreateRoom(roomId string) *models.RoomData {
	RoomMutex.Lock()
	defer RoomMutex.Unlock()

	// 1. 如果存在，直接返回
	if room, exists := Rooms[roomId]; exists {
		return room
	}

	// 2. 不存在，初始化新房间
	newRoom := &models.RoomData{
		ID:      roomId,
		Notes:   make([]models.Note, 0),
		History: make([]models.ClipboardItem, 0),
		Clients: make(map[*websocket.Conn]bool),
	}

	// 预置一个默认便签
	newRoom.Notes = append(newRoom.Notes, models.Note{
		ID: "default", Title: "Quick Note", Content: "",
	})

	Rooms[roomId] = newRoom
	log.Printf("✨ Room Created: %s", roomId)
	return newRoom
}

// 注册客户端到房间
func AddClient(room *models.RoomData, conn *websocket.Conn) {
	RoomMutex.Lock() // 注意：这里简单起见用全局锁，高并发可改用 Room 级锁
	defer RoomMutex.Unlock()
	room.Clients[conn] = true
}

// 从房间移除客户端
func RemoveClient(room *models.RoomData, conn *websocket.Conn) {
	RoomMutex.Lock()
	defer RoomMutex.Unlock()
	if _, ok := room.Clients[conn]; ok {
		delete(room.Clients, conn)
		conn.Close()
	}
}

// 广播消息给房间内所有人
func Broadcast(room *models.RoomData, msg models.Message) {
	RoomMutex.RLock() // 读锁
	defer RoomMutex.RUnlock()

	for client := range room.Clients {
		// 并发写 WS 需要注意，这里简单串行发送
		err := client.WriteJSON(msg)
		if err != nil {
			log.Printf("Broadcast error: %v", err)
			client.Close()
			// 注意：遍历时删除可能会有问题，但在 Gorilla WS 中通常导致下一次循环错误
			// 真正的移除操作会由 ReadLoop 的 defer 触发
		}
	}
}
