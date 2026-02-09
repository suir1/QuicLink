package p2p

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/webtransport-go"
)

// Node represents a P2P WebTransport client node
type Node struct {
	ctx        context.Context
	cancel     context.CancelFunc
	session    *webtransport.Session
	stream     *webtransport.Stream
	mu         sync.Mutex
	serverHost string
	roomID     string
	connected  bool
	onMessage  func(msgType string, payload map[string]interface{})
}

// NewNode creates a new P2P node
func NewNode() *Node {
	return &Node{}
}

// Connect establishes a WebTransport connection to the signaling server
// token is optional, used for authentication in private mode
func (n *Node) Connect(host, roomID string, token ...string) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	n.serverHost = host
	n.roomID = roomID

	// Create context with timeout for connection
	var cancel context.CancelFunc
	n.ctx, cancel = context.WithTimeout(context.Background(), 15*time.Second)
	n.cancel = cancel

	// Ensure host has port (webtransport requires explicit port)
	hostWithPort := host
	if !strings.Contains(host, ":") {
		hostWithPort = host + ":443"
	}

	// WebTransport URL with optional token
	url := fmt.Sprintf("https://%s/wt?room=%s", hostWithPort, roomID)
	if len(token) > 0 && token[0] != "" {
		url += "&token=" + token[0]
	}
	log.Printf("🔌 P2P Connecting to: %s", url)

	// Configure Dialer with HTTP/3 support
	// webtransport.Dialer uses TLSClientConfig directly
	dialer := webtransport.Dialer{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // For self-signed certs in dev
		},
	}

	// Dial WebTransport
	log.Printf("🔍 Starting QUIC/WebTransport dial...")
	_, session, err := dialer.Dial(n.ctx, url, nil)
	if err != nil {
		log.Printf("❌ WebTransport dial error details: %v", err)
		log.Printf("   Host: %s, Room: %s", host, roomID)
		return fmt.Errorf("webtransport dial failed: %w", err)
	}
	n.session = session
	log.Printf("✅ WebTransport session established")

	// Open bidirectional stream for signaling (Control Stream)
	log.Printf("🔍 Opening bidirectional stream...")
	stream, err := session.OpenStreamSync(n.ctx)
	if err != nil {
		log.Printf("❌ Stream open error: %v", err)
		session.CloseWithError(0, "stream open failed")
		return fmt.Errorf("open stream failed: %w", err)
	}
	n.stream = stream
	n.connected = true

	// Replace timeout context with a cancellable one for long-lived connection
	n.ctx, n.cancel = context.WithCancel(context.Background())

	log.Printf("✅ P2P Connected to room: %s via WebTransport", roomID)

	// Start reading messages
	go n.readLoop()

	// Start keep-alive heartbeat (prevent idle timeout)
	go n.keepAlive()

	return nil
}

// keepAlive sends periodic ping messages to prevent idle timeout
func (n *Node) keepAlive() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			n.mu.Lock()
			connected := n.connected
			n.mu.Unlock()

			if !connected {
				return
			}

			// Send a ping message
			err := n.SendMessage(map[string]interface{}{
				"type":    "ping",
				"payload": map[string]interface{}{},
			})
			if err != nil {
				log.Printf("⚠️ Keep-alive ping failed: %v", err)
				return
			}
		case <-n.ctx.Done():
			return
		}
	}
}

// readLoop handles incoming messages from the WebTransport stream
func (n *Node) readLoop() {
	n.mu.Lock()
	stream := n.stream
	n.mu.Unlock()

	if stream == nil {
		return
	}

	defer n.Disconnect()

	decoder := json.NewDecoder(stream)
	for {
		var msg map[string]interface{}
		if err := decoder.Decode(&msg); err != nil {
			if err == io.EOF {
				log.Println("🔌 P2P Stream closed (EOF)")
				return
			}
			// Ignore simple close errors
			log.Printf("❌ P2P Read error: %v", err)
			return
		}

		log.Printf("📝 Recevied Message: %+v", msg)

		msgType, _ := msg["type"].(string)
		payload, _ := msg["payload"].(map[string]interface{})

		if n.onMessage != nil {
			n.onMessage(msgType, payload)
		}
	}
}

// SendMessage sends a JSON message over the WebTransport stream
func (n *Node) SendMessage(msg interface{}) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	if !n.connected || n.stream == nil {
		return fmt.Errorf("not connected")
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	// Append newline for Go's decoder if needed, or just write raw JSON
	// The server's json.Decoder handles stream of JSON objects fine handling whitespace
	// But adding a newline is a safe delimiter practice
	_, err = n.stream.Write(append(data, '\n'))
	return err
}

// ShareFile announces a file offer to other peers
func (n *Node) ShareFile(id, name string, size int64, mimeType string) error {
	return n.SendMessage(map[string]interface{}{
		"type": "file_offer",
		"payload": map[string]interface{}{
			"id":   id,
			"name": name,
			"size": size,
			"type": mimeType,
		},
	})
}

// SendHello announces presence to other peers
func (n *Node) SendHello() error {
	return n.SendMessage(map[string]interface{}{
		"type":    "p2p_hello",
		"payload": map[string]interface{}{},
	})
}

// OnMessage sets the callback for incoming messages
func (n *Node) OnMessage(callback func(msgType string, payload map[string]interface{})) {
	n.onMessage = callback
}

// Disconnect closes the WebTransport connection
func (n *Node) Disconnect() {
	n.mu.Lock()
	defer n.mu.Unlock()

	if !n.connected {
		return
	}
	n.connected = false

	if n.cancel != nil {
		n.cancel()
	}

	if n.session != nil {
		n.session.CloseWithError(0, "client disconnected")
		n.session = nil
	}
	n.stream = nil

	log.Println("🔌 P2P Disconnected")
}

// IsConnected returns the connection state
func (n *Node) IsConnected() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.connected
}
