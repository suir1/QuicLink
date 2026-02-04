package store

import (
	"log"
	"sync"
	"time"
)

// Connection 抽象接口，屏蔽 WebSocket/WebTransport 差异
type Connection interface {
	WriteJSON(v interface{}) error
	Close() error
}

// Room 结构体：定义一个房间的所有状态
type Room struct {
	ID       string
	Password string

	// 房间内的所有客户端连接 (用于广播)
	Clients map[Connection]bool

	// 特殊标记：谁是 Host (C++ 客户端)
	Host     Connection
	HostInfo interface{} // 存 Host 的 IP、端口等 JSON 信息

	// --- 新增：记事本功能 ---
	Notes      map[string]*Note // 存储多标签记事本 (ID -> Note)
	LastUpdate time.Time        // 最后活动时间 (可用于后续清理非活跃房间)

	// --- 新增：剪贴板历史 ---
	ClipboardHistory []ClipboardItem

	// 读写锁：保证并发安全
	mutex sync.RWMutex
}

// Note 记事本单页结构
type Note struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	UpdatedAt int64  `json:"updatedAt"`
}

// ClipboardItem 剪贴板历史项
type ClipboardItem struct {
	ID        int64  `json:"id"`
	Text      string `json:"text"`
	Time      string `json:"time"`
	Type      string `json:"type"` // "text", "image"
	Timestamp int64  `json:"timestamp"`
}

// 全局房间管理器
var (
	Rooms       = make(map[string]*Room)
	ManagerLock sync.RWMutex
)

// GetOrCreateRoom 获取现有房间或创建新房间
func GetOrCreateRoom(roomId string) *Room {
	ManagerLock.Lock()
	defer ManagerLock.Unlock()

	// 如果房间存在，直接返回
	if room, exists := Rooms[roomId]; exists {
		return room
	}

	// 如果不存在，创建新房间
	newRoom := &Room{
		ID:               roomId,
		Clients:          make(map[Connection]bool),
		Notes:            make(map[string]*Note),
		ClipboardHistory: make([]ClipboardItem, 0),
		LastUpdate:       time.Now(),
	}

	// 初始化一个默认笔记
	defaultNote := &Note{
		ID:        "default",
		Title:     "默认笔记",
		Content:   "",
		UpdatedAt: time.Now().Unix(),
	}
	newRoom.Notes[defaultNote.ID] = defaultNote

	Rooms[roomId] = newRoom
	log.Printf("🏠 New Room Created: %s", roomId)
	return newRoom
}

// GetRoom 仅获取，不创建 (用于 API 查询等)
func GetRoom(roomId string) *Room {
	ManagerLock.RLock()
	defer ManagerLock.RUnlock()
	return Rooms[roomId]
}

// Join 客户端加入房间
func (r *Room) Join(conn Connection) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	r.Clients[conn] = true
	r.LastUpdate = time.Now()
	log.Printf("➕ Client joined room [%s]. Total: %d", r.ID, len(r.Clients))
}

// Leave 客户端离开房间
func (r *Room) Leave(conn Connection) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	if _, ok := r.Clients[conn]; ok {
		delete(r.Clients, conn)
		conn.Close() // 确保连接关闭

		// 如果离开的是 Host，清除 Host 标记
		if r.Host == conn {
			log.Printf("⚠️ Host left room [%s]", r.ID)
			r.Host = nil
			r.HostInfo = nil
			// 这里可以选择广播 "host_offline" 消息
		}
	}
	log.Printf("➖ Client left room [%s]. Total: %d", r.ID, len(r.Clients))
}

// SetHost 注册 C++ 客户端为 Host
func (r *Room) SetHost(conn Connection, info interface{}) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	r.Host = conn
	r.HostInfo = info
	r.LastUpdate = time.Now()
	log.Printf("🖥️ Host registered in room [%s]", r.ID)
}

// UpdateNote 更新或创建笔记
func (r *Room) UpdateNote(id, title, content string) *Note {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	note, exists := r.Notes[id]
	if !exists {
		note = &Note{ID: id}
		r.Notes[id] = note
	}

	// 只更新非空字段 (前端可能只发局部更新，但这里简化为全量覆盖，需前端配合)
	// 实际应用中，前端应该保证发送完整数据或我们在协议里细分
	note.Title = title
	note.Content = content
	note.UpdatedAt = time.Now().Unix()

	r.LastUpdate = time.Now()
	return note
}

// DeleteNote 删除笔记
func (r *Room) DeleteNote(id string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	delete(r.Notes, id)
	r.LastUpdate = time.Now()
}

// SetPassword 设置房间密码 (用于 Private 模式)
func (r *Room) SetPassword(password string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.Password = password
}

// Broadcast 向房间内所有客户端广播消息
// sender: 可选参数。如果传入 sender，则不会向该 sender 发送消息 (避免回声)
func (r *Room) Broadcast(msg interface{}, sender Connection) {
	r.mutex.RLock()
	defer r.mutex.RUnlock()

	// log.Printf("📢 Broadcasting to %d clients in room %s", len(r.Clients), r.ID)

	for client := range r.Clients {
		// 如果指定了 sender，且当前 client 就是 sender，则跳过
		if sender != nil && client == sender {
			continue
		}

		err := client.WriteJSON(msg)
		if err != nil {
			log.Printf("❌ Broadcast error: %v", err)
			client.Close()
			// 注意：这里不能直接 delete，因为我们在遍历 map
			// 实际生产中可以收集 error clients 并在循环外删除，或者依赖 Leave 机制
		}
	}
}

// AddClipboardItem 添加一条剪贴板记录 (保留最近 20 条)
func (r *Room) AddClipboardItem(text string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()

	// 简单的去重：如果最近的一条和新的一样，虽然时间变了，但也更新一下时间戳防止重复刷
	if len(r.ClipboardHistory) > 0 {
		last := r.ClipboardHistory[len(r.ClipboardHistory)-1]
		if last.Text == text {
			return
		}
	}

	// 构造新 Item
	isImage := len(text) > 10 && text[:10] == "data:image"
	msgType := "text"
	if isImage {
		msgType = "image"
	}

	now := time.Now()
	item := ClipboardItem{
		ID:        now.UnixNano(),
		Text:      text,
		Time:      now.Format("15:04"),
		Type:      msgType,
		Timestamp: now.Unix(),
	}

	r.ClipboardHistory = append(r.ClipboardHistory, item)

	// 限制长度 20
	if len(r.ClipboardHistory) > 20 {
		r.ClipboardHistory = r.ClipboardHistory[len(r.ClipboardHistory)-20:]
	}

	r.LastUpdate = now
}
