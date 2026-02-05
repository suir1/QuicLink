package p2p

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"

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
func (n *Node) Connect(host, roomID string) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	n.serverHost = host
	n.roomID = roomID
	n.ctx, n.cancel = context.WithCancel(context.Background())

	// WebTransport URL
	url := fmt.Sprintf("https://%s/wt?room=%s", host, roomID)
	log.Printf("🔌 P2P Connecting to: %s", url)

	// Configure Dialer with HTTP/3 support
	// webtransport.Dialer uses TLSClientConfig directly
	dialer := webtransport.Dialer{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // For self-signed certs in dev
		},
	}

	// Dial WebTransport
	_, session, err := dialer.Dial(n.ctx, url, nil)
	if err != nil {
		return fmt.Errorf("webtransport dial failed: %w", err)
	}
	n.session = session

	// Open bidirectional stream for signaling (Control Stream)
	stream, err := session.OpenStreamSync(n.ctx)
	if err != nil {
		session.CloseWithError(0, "stream open failed")
		return fmt.Errorf("open stream failed: %w", err)
	}
	n.stream = stream
	n.connected = true

	log.Printf("✅ P2P Connected to room: %s via WebTransport", roomID)

	// Start reading messages
	go n.readLoop()

	return nil
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
