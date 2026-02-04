package p2p

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

// Node represents a P2P WebTransport client node
type Node struct {
	ctx        context.Context
	cancel     context.CancelFunc
	conn       *quic.Conn
	stream     *quic.Stream // Pointer type as returned by OpenStreamSync
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
	url := fmt.Sprintf("https://%s/webtransport?room=%s", host, roomID)
	log.Printf("🔌 P2P Connecting to: %s", url)

	// TLS config (InsecureSkipVerify for self-signed certs in dev)
	tlsConf := &tls.Config{
		InsecureSkipVerify: true,
		NextProtos:         []string{http3.NextProtoH3},
	}

	// QUIC config
	quicConf := &quic.Config{
		MaxIdleTimeout:  time.Second * 30,
		KeepAlivePeriod: time.Second * 10,
	}

	// Dial QUIC connection
	conn, err := quic.DialAddr(n.ctx, host, tlsConf, quicConf)
	if err != nil {
		return fmt.Errorf("quic dial failed: %w", err)
	}
	n.conn = conn

	// Open bidirectional stream for signaling
	stream, err := conn.OpenStreamSync(n.ctx)
	if err != nil {
		return fmt.Errorf("open stream failed: %w", err)
	}
	n.stream = stream
	n.connected = true

	log.Printf("✅ P2P Connected to room: %s", roomID)

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

	decoder := json.NewDecoder(stream)
	for {
		var msg map[string]interface{}
		if err := decoder.Decode(&msg); err != nil {
			if err == io.EOF {
				log.Println("🔌 P2P Stream closed")
				return
			}
			log.Printf("❌ P2P Read error: %v", err)
			return
		}

		msgType, _ := msg["type"].(string)
		payload, _ := msg["payload"].(map[string]interface{})

		log.Printf("📩 P2P Message: %s", msgType)

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

	n.connected = false

	if n.cancel != nil {
		n.cancel()
	}

	if n.stream != nil {
		n.stream.Close()
		n.stream = nil
	}

	if n.conn != nil {
		n.conn.CloseWithError(0, "closed")
		n.conn = nil
	}
	log.Println("🔌 P2P Disconnected")
}

// IsConnected returns the connection state
func (n *Node) IsConnected() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.connected
}
