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
	log.Printf("🔌 WebSocket Incoming Request from %s | Room: %s", r.RemoteAddr, r.URL.Query().Get("room"))
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
	// 获取房间ID，默认为 "public"
	roomId := r.URL.Query().Get("room")

	// Private 模式下强制使用单一房间
	if config.Current.AppMode == "private" {
		roomId = "root"
	}

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
	// ---------------------------------------------------------
	// 4. 发送初始化状态 (Init State)
	// ---------------------------------------------------------
	if err := SendInitState(room, conn, roomId); err != nil {
		log.Println("❌ Init error:", err)
		return
	}

	// ---------------------------------------------------------
	// 5. 消息循环 (Message Loop)
	// ---------------------------------------------------------
	for {
		var msg Message
		err := conn.ReadJSON(&msg)
		if err != nil {
			break // 连接断开
		}

		if !ProcessMessage(room, conn, msg) {
			break
		}
	}
}
