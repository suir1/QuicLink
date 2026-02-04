package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net/url"
	"sync"
	"time"

	"QuicLink/p2p"

	"github.com/gorilla/websocket"
	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.design/x/clipboard"
)

// App struct
type App struct {
	ctx          context.Context
	conn         *websocket.Conn
	connMu       sync.Mutex
	roomID       string
	serverHost   string
	lastClipText string
	p2pNode      *p2p.Node
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		serverHost: "localhost:8080", // Default, can be configured
		p2pNode:    p2p.NewNode(),
	}
}

// startup is called when the app starts
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Initialize clipboard
	if err := clipboard.Init(); err != nil {
		log.Printf("❌ Clipboard init failed: %v", err)
		return
	}

	// Start clipboard watcher in background
	go a.watchClipboard()
}

// --- Clipboard Module ---

// watchClipboard monitors system clipboard and sends changes to server
// Fixed: Switched to polling mode for better reliability on macOS
func (a *App) watchClipboard() {
	ticker := time.NewTicker(time.Second * 1)
	defer ticker.Stop()

	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			text := a.GetClipboard()
			if text == "" || text == a.lastClipText {
				continue
			}

			// Update local cache
			a.lastClipText = text
			log.Printf("📋 Clipboard changed (detected): %s", truncate(text, 50))

			// Send to server if connected
			a.sendMessage(map[string]interface{}{
				"type": "clipboard_push",
				"payload": map[string]string{
					"text": text,
				},
			})

			// Emit event to frontend
			runtime.EventsEmit(a.ctx, "clipboard:local", text)
		}
	}
}

// GetClipboard returns current clipboard text
func (a *App) GetClipboard() string {
	return string(clipboard.Read(clipboard.FmtText))
}

// SetClipboard sets system clipboard text
func (a *App) SetClipboard(text string) {
	a.lastClipText = text // Prevent echo
	clipboard.Write(clipboard.FmtText, []byte(text))
}

// --- Signaling Module ---

// Connect establishes WebSocket connection to signaling server
// useHTTPS: true for wss://, false for ws://
func (a *App) Connect(host, roomID string, useHTTPS bool) error {
	a.connMu.Lock()
	defer a.connMu.Unlock()

	if a.conn != nil {
		a.conn.Close()
	}

	a.serverHost = host
	a.roomID = roomID

	scheme := "ws"
	if useHTTPS {
		scheme = "wss"
	}

	u := url.URL{Scheme: scheme, Host: host, Path: "/ws", RawQuery: "room=" + roomID}
	log.Printf("🔌 Connecting to %s", u.String())

	dialer := websocket.Dialer{}
	if useHTTPS {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // Dev only
	}

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		log.Printf("❌ WebSocket dial failed: %v", err)
		return err
	}

	a.conn = conn
	log.Printf("✅ Connected to room: %s", roomID)

	// Start reading messages
	go a.readMessages()

	return nil
}

// Disconnect closes the WebSocket connection
func (a *App) Disconnect() {
	a.connMu.Lock()
	defer a.connMu.Unlock()

	if a.conn != nil {
		a.conn.Close()
		a.conn = nil
	}
	log.Println("🔌 Disconnected")
}

// readMessages handles incoming WebSocket messages
func (a *App) readMessages() {
	for {
		a.connMu.Lock()
		conn := a.conn
		a.connMu.Unlock()

		if conn == nil {
			return
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("❌ Read error: %v", err)
			a.Disconnect()
			return
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		msgType, _ := msg["type"].(string)
		payload, _ := msg["payload"].(map[string]interface{})

		switch msgType {
		case "clipboard_push":
			if content, ok := payload["text"].(string); ok {
				log.Printf("📋 Received clipboard: %s", truncate(content, 50))
				a.SetClipboard(content)
				runtime.EventsEmit(a.ctx, "clipboard:remote", content)
			}
		case "file_offer":
			// Forward to frontend for display
			runtime.EventsEmit(a.ctx, "p2p:offer", payload)
		case "init":
			// Handle init message - extract and emit clipboard history directly
			log.Printf("📥 Received init message from server")
			if history, ok := payload["clipboardHistory"].([]interface{}); ok && len(history) > 0 {
				log.Printf("📜 Emitting clipboard history to frontend (%d items)", len(history))
				runtime.EventsEmit(a.ctx, "clipboard:history", history)
			} else {
				log.Printf("⚠️ Init payload has no clipboardHistory or it's empty")
			}
			// Also forward the whole init for other handlers (notes, hostInfo etc)
			runtime.EventsEmit(a.ctx, "p2p:message", msg)
		default:
			// Forward generic messages (init, chat, etc) to frontend
			log.Printf("📤 Forwarding message to frontend: type=%s", msgType)
			runtime.EventsEmit(a.ctx, "p2p:message", msg)
		}
	}
}

// sendMessage sends a JSON message over WebSocket
func (a *App) sendMessage(msg interface{}) {
	a.connMu.Lock()
	defer a.connMu.Unlock()

	if a.conn == nil {
		return
	}

	data, _ := json.Marshal(msg)
	if err := a.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("❌ Send error: %v", err)
	}
}

// SendGenericMessage is an exported method for frontend to send any message type through WebSocket
func (a *App) SendGenericMessage(msgType string, payload map[string]interface{}) {
	log.Printf("📤 Frontend sending: %s", msgType)
	a.sendMessage(map[string]interface{}{
		"type":    msgType,
		"payload": payload,
	})
}

// SendClipboard manually sends current clipboard to server
func (a *App) SendClipboard() {
	text := a.GetClipboard()
	if text != "" {
		a.sendMessage(map[string]interface{}{
			"type": "clipboard_push",
			"payload": map[string]string{
				"text": text,
			},
		})
	}
}

// --- Utilities ---

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// GetConnectionStatus returns connection state
func (a *App) GetConnectionStatus() bool {
	a.connMu.Lock()
	defer a.connMu.Unlock()
	return a.conn != nil
}

// Greet is a sample method (can be removed later)
func (a *App) Greet(name string) string {
	return "Hello " + name + ", Welcome to QuicLink Desktop!"
}

// --- P2P Module ---

// ConnectP2P establishes a WebTransport P2P connection
func (a *App) ConnectP2P(host, roomID string) error {
	// Setup message callback to emit events to frontend
	a.p2pNode.OnMessage(func(msgType string, payload map[string]interface{}) {
		runtime.EventsEmit(a.ctx, "p2p:message", map[string]interface{}{
			"type":    msgType,
			"payload": payload,
		})
	})

	return a.p2pNode.Connect(host, roomID)
}

// DisconnectP2P closes the P2P connection
func (a *App) DisconnectP2P() {
	a.p2pNode.Disconnect()
}

// GetP2PStatus returns P2P connection status
func (a *App) GetP2PStatus() bool {
	return a.p2pNode.IsConnected()
}

// ShareFileP2P announces a file to other peers
func (a *App) ShareFileP2P(id, name string, size int64, mimeType string) error {
	return a.p2pNode.ShareFile(id, name, size, mimeType)
}

// SendP2PHello announces presence to other peers
func (a *App) SendP2PHello() error {
	return a.p2pNode.SendHello()
}

// shutdown is called when the app is closing
func (a *App) shutdown(ctx context.Context) {
	a.Disconnect()
	a.p2pNode.Disconnect()
}

// beforeClose is called before the app closes
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	// Perform cleanup
	a.Disconnect()
	a.p2pNode.Disconnect()
	time.Sleep(100 * time.Millisecond) // Allow graceful close
	return false
}
