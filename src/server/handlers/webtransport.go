package handlers

import (
	"encoding/json"
	"io"
	"log"
	"net/http"

	"github.com/quic-go/webtransport-go"

	"quiclink-server/config"
	"quiclink-server/store"
)

// WTServer 是 WebTransport 服务器实例，由 main.go 初始化
var WTServer *webtransport.Server

// WebTransportClient 封装 WT 会话和主控流，实现 Connection 接口
type WebTransportClient struct {
	Session *webtransport.Session
	Stream  *webtransport.Stream
	Encoder *json.Encoder
	Decoder *json.Decoder
}

func (c *WebTransportClient) WriteJSON(v interface{}) error {
	return c.Encoder.Encode(v)
}

func (c *WebTransportClient) Close() error {
	// 关闭 Session
	return c.Session.CloseWithError(0, "closed")
}

func (c *WebTransportClient) ReadJSON(v interface{}) error {
	return c.Decoder.Decode(v)
}

func HandleWebTransport(w http.ResponseWriter, r *http.Request) {
	if WTServer == nil {
		log.Printf("❌ WebTransport Server not initialized")
		w.WriteHeader(500)
		return
	}

	// 1. 升级到 WebTransport
	session, err := WTServer.Upgrade(w, r)
	if err != nil {
		log.Printf("❌ WebTransport Upgrade failed: %v", err)
		w.WriteHeader(500)
		return
	}

	// 2. 等待客户端建立主控流 (Bidirectional Stream)
	// 约定：客户端建立连接后，必须立即发起一个 bidirectional stream 用于信令交互
	stream, err := session.AcceptStream(r.Context())
	if err != nil {
		log.Printf("❌ Failed to accept Main Stream: %v", err)
		return
	}
	defer stream.Close()

	// 3. 构建连接对象
	client := &WebTransportClient{
		Session: session,
		Stream:  stream,
		Encoder: json.NewEncoder(stream),
		Decoder: json.NewDecoder(stream),
	}

	// 4. 鉴权 & 房间处理
	if config.Current.AppMode == "private" {
		token := r.URL.Query().Get("token")
		if token != config.Current.AdminPassword {
			log.Printf("🔒 Blocked unauthorized WT access")
			client.Close()
			return
		}
	}

	roomId := r.URL.Query().Get("room")
	if roomId == "" {
		roomId = "public"
	}

	room := store.GetOrCreateRoom(roomId)
	room.Join(client)
	defer room.Leave(client)

	// 5. 发送初始化信息
	if err := SendInitState(room, client, roomId); err != nil {
		log.Printf("❌ WT Init error: %v", err)
		return
	}

	// 6. 消息循环
	for {
		var msg Message
		err := client.ReadJSON(&msg)
		if err != nil {
			if err != io.EOF {
				// log.Printf("⚠️ WT Read error: %v", err)
			}
			break
		}

		if !ProcessMessage(room, client, msg) {
			break
		}
	}
}
