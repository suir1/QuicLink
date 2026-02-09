package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
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
	ctx           context.Context
	conn          *websocket.Conn
	connMu        sync.Mutex
	roomID        string
	serverHost    string
	lastClipText  string
	p2pNode       *p2p.Node
	transportMode string // "ws" or "wt"
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		serverHost:    "localhost:3100", // Default, can be configured
		p2pNode:       p2p.NewNode(),
		transportMode: "none",
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
			// Generate ID for the item to ensure persistence
			id := fmt.Sprintf("%d", time.Now().UnixMilli())
			a.sendMessage(map[string]interface{}{
				"type": "clipboard_push",
				"payload": map[string]string{
					"text": text,
					"id":   id,
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

// Connect establishes connection to signaling server (Adaptive: WT -> WSS -> WS)
func (a *App) Connect(host, roomID, password string) error {
	a.connMu.Lock()
	defer a.connMu.Unlock()

	// Reset valid connection check
	if a.transportMode != "none" {
		a.Disconnect()
	}

	a.serverHost = host
	a.roomID = roomID

	// 1. Attempt WebTransport (HTTP/3) - Best Performance
	log.Printf("🚀 Attempting WebTransport connection to %s...", host)
	// Pass password to enable authentication in private mode
	err := a.p2pNode.Connect(host, roomID, password)
	if err == nil {
		a.transportMode = "wt"
		log.Printf("✅ Connected via WebTransport (HTTP/3)")

		// Setup generic message handler
		a.p2pNode.OnMessage(func(msgType string, payload map[string]interface{}) {
			a.handleIncomingMessage(msgType, payload)
		})
		return nil
	}
	log.Printf("⚠️ WebTransport failed: %v", err)

	// 2. Attempt WebSocket Secure (WSS) - HTTPS Fallback
	log.Printf("🔄 Falling back: Attempting WSS (Secure WebSocket)...")
	if err := a.connectWebSocket(host, roomID, password, true); err == nil {
		return nil
	}
	log.Printf("⚠️ WSS failed. Falling back to WS...")

	// 3. Attempt WebSocket (WS) - HTTP Fallback
	log.Printf("🔄 Falling back: Attempting WS (Plain WebSocket)...")
	if err := a.connectWebSocket(host, roomID, password, false); err == nil {
		return nil
	}

	return fmt.Errorf("all connection methods failed")
}

// Helper: Connect via WebSocket
func (a *App) connectWebSocket(host, roomID, password string, secure bool) error {
	scheme := "ws"
	if secure {
		scheme = "wss"
	}

	query := "room=" + roomID
	if password != "" {
		query += "&token=" + password
	}

	u := url.URL{Scheme: scheme, Host: host, Path: "/ws", RawQuery: query}
	log.Printf("🔌 Connecting to %s", u.String())

	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
	}
	if secure {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // Dev only
	}

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		log.Printf("❌ %s dial failed: %v", scheme, err)
		return err
	}

	a.conn = conn
	a.transportMode = "ws"
	log.Printf("✅ Connected to room (WebSocket %s): %s", scheme, roomID)

	// Start reading messages
	go a.readMessages()
	return nil
}

// Disconnect closes the active connection
func (a *App) Disconnect() {
	// a.connMu.Lock() // Avoid deadlock if called from internal
	// defer a.connMu.Unlock()

	if a.transportMode == "wt" {
		a.p2pNode.Disconnect()
	} else if a.transportMode == "ws" && a.conn != nil {
		a.conn.Close()
		a.conn = nil
	}
	a.transportMode = "none"
	log.Println("🔌 Disconnected")
}

// handleIncomingMessage processes messages from any transport
func (a *App) handleIncomingMessage(msgType string, payload map[string]interface{}) {
	switch msgType {
	case "clipboard_push":
		// Deprecated: Server now sends clipboard_data
		// Keep for compatibility if needed, but logic is moved to clipboard_data
		if content, ok := payload["text"].(string); ok {
			log.Printf("📋 Received clipboard_push (legacy): %s", truncate(content, 50))
			a.SetClipboard(content)
			runtime.EventsEmit(a.ctx, "clipboard:remote", content)
		}
	case "clipboard_data":
		// New Protocol: Server broadcasts clipboard_data with ID
		if content, ok := payload["text"].(string); ok {
			log.Printf("📋 Received clipboard_data: %s", truncate(content, 50))

			// Update lastClipText to prevent echo when we write to system clipboard
			a.lastClipText = content

			// Optional: Write to system clipboard if 'Auto Sync' is desired
			// For now, we just emit to frontend to update UI
			runtime.EventsEmit(a.ctx, "clipboard:remote", payload)

			// If we wanted to auto-sync to system clipboard:
			// a.SetClipboard(content)
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
		runtime.EventsEmit(a.ctx, "p2p:message", map[string]interface{}{"type": msgType, "payload": payload})
	default:
		// Forward generic messages (init, chat, etc) to frontend
		log.Printf("📤 Forwarding message to frontend: type=%s", msgType)
		runtime.EventsEmit(a.ctx, "p2p:message", map[string]interface{}{"type": msgType, "payload": payload})
	}
}

// readMessages handles incoming WebSocket messages
func (a *App) readMessages() {
	for {
		a.connMu.Lock()
		conn := a.conn
		a.connMu.Unlock()

		if conn == nil || a.transportMode != "ws" {
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

		a.handleIncomingMessage(msgType, payload)
	}
}

// sendMessage sends a JSON message over the active transport
func (a *App) sendMessage(msg interface{}) {
	if a.transportMode == "wt" {
		if err := a.p2pNode.SendMessage(msg); err != nil {
			log.Printf("❌ WT Send error: %v", err)
		}
		return
	}

	// Fallback WS
	a.connMu.Lock()
	defer a.connMu.Unlock()

	if a.conn == nil {
		return
	}

	data, _ := json.Marshal(msg)
	if err := a.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("❌ WS Send error: %v", err)
	}
}

// SendGenericMessage is an exported method for frontend to send any message type
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
	return a.transportMode != "none"
}

// Greet is a sample method
func (a *App) Greet(name string) string {
	return "Hello " + name + ", Welcome to QuicLink Desktop!"
}

// --- P2P Module (Legacy Wrapper) ---

// ConnectP2P establishes a WebTransport P2P connection
// Deprecated: Logic moved to Connect()
func (a *App) ConnectP2P(host, roomID string) error {
	log.Println("⚠️ ConnectP2P called but is now managed by Connect()")
	return nil
}

// DisconnectP2P closes the P2P connection
func (a *App) DisconnectP2P() {
	// No-op, managed by Disconnect
}

// GetP2PStatus returns P2P connection status
func (a *App) GetP2PStatus() bool {
	return a.transportMode == "wt"
}

// ShareFileP2P announces a file to other peers
func (a *App) ShareFileP2P(id, name string, size int64, mimeType string) error {
	// Pass through sendMessage which handles routing
	return a.p2pNode.ShareFile(id, name, size, mimeType)
}

// SendP2PHello announces presence to other peers
func (a *App) SendP2PHello() error {
	return a.p2pNode.SendHello()
}

// shutdown is called when the app is closing
func (a *App) shutdown(ctx context.Context) {
	a.Disconnect()
}

// beforeClose is called before the app closes
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	a.Disconnect()
	time.Sleep(100 * time.Millisecond) // Allow graceful close
	return false
}
