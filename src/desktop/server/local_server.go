package server

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// LocalFile represents a file stored locally on the desktop
type LocalFile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Path      string `json:"-"` // Internal path
	CreatedAt int64  `json:"createdAt"`
}

// ServerInfo contains ports and certificate info for client connection
type ServerInfo struct {
	HTTPPort int    `json:"httpPort"` // HTTP/1.1 fallback port
	H3Port   int    `json:"h3Port"`   // HTTP/3 + WebTransport port
	CertHash string `json:"certHash"` // Certificate hash for browser verification
}

type LocalServer struct {
	mu         sync.RWMutex
	files      map[string]*LocalFile
	uploadDir  string
	httpPort   int
	h3Port     int
	certHash   string
	httpServer *http.Server
	h3Server   *http3.Server
	wtServer   *webtransport.Server
	h3Conn     *net.UDPConn
	certFile   string
	keyFile    string

	// Phase 9: In-Memory Relay
	relayMu  sync.Mutex
	relayMap map[string]*RelaySession
}

type RelaySession struct {
	Writer *io.PipeWriter
	Reader *io.PipeReader
	Done   chan struct{} // Closed when transfer complete or error
	Name   string
	Size   int64
	Type   string
}

func NewLocalServer() *LocalServer {
	// Use ~/Downloads/QuicLink for uploads
	home, err := os.UserHomeDir()
	if err != nil {
		log.Printf("❌ Failed to get user home dir: %v", err)
		home = os.TempDir()
	}
	uploadDir := filepath.Join(home, "Downloads", "QuicLink")

	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		log.Printf("❌ Failed to create upload dir: %v", err)
	} else {
		log.Printf("📂 Local Upload Dir: %s", uploadDir)
	}

	return &LocalServer{
		files:     make(map[string]*LocalFile),
		uploadDir: uploadDir,
		relayMap:  make(map[string]*RelaySession),
	}
}

// SetUploadDir updates the directory where uploaded files are saved
func (s *LocalServer) SetUploadDir(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if path == "" {
		return
	}
	s.uploadDir = path
	os.MkdirAll(path, 0755)
	log.Printf("📂 Local Upload Dir Updated: %s", path)
}

// Start starts both HTTP and HTTP/3 servers
func (s *LocalServer) Start() (*ServerInfo, error) {
	// Generate Self-Signed Cert first
	certDir := filepath.Join(os.TempDir(), "quiclink_certs")
	os.MkdirAll(certDir, 0755)
	s.certFile = filepath.Join(certDir, "lan_cert.pem")
	s.keyFile = filepath.Join(certDir, "lan_key.pem")

	// Force regenerate cert to ensure 10-day limit is applied
	os.Remove(s.certFile)
	os.Remove(s.keyFile)

	certHash, err := s.generateCertWithHash()
	if err != nil {
		log.Printf("❌ Failed to generate cert: %v", err)
		return nil, err
	}
	s.certHash = certHash

	// Create shared handler
	mux := http.NewServeMux()
	mux.HandleFunc("/api/lan/files", s.handleListFiles)
	mux.HandleFunc("/api/lan/upload", s.handleUpload)
	mux.HandleFunc("/api/lan/download/", s.handleDownload)

	// Relay Endpoints
	mux.HandleFunc("/api/lan/relay/upload/", s.handleRelayUpload)
	mux.HandleFunc("/api/lan/relay/download/", s.handleRelayDownload)

	mux.HandleFunc("/wt", s.handleWebTransport) // WebTransport endpoint

	handler := s.enableCORS(mux)

	// 1. Start HTTP Server (TCP) - Always works as fallback
	httpListener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return nil, fmt.Errorf("failed to listen HTTP: %w", err)
	}
	s.httpPort = httpListener.Addr().(*net.TCPAddr).Port

	s.httpServer = &http.Server{
		Handler: handler,
	}

	go func() {
		log.Printf("🚀 LAN HTTP Server started on port :%d", s.httpPort)
		if err := s.httpServer.Serve(httpListener); err != nil && err != http.ErrServerClosed {
			log.Printf("❌ HTTP Server error: %v", err)
		}
	}()

	// 2. Start HTTP/3 + WebTransport Server (QUIC)
	// Bind UDP once and reuse the same socket for serving, to avoid port-race windows.
	h3Addr, err := net.ResolveUDPAddr("udp", "0.0.0.0:0")
	if err != nil {
		return nil, err
	}
	h3Conn, err := net.ListenUDP("udp", h3Addr)
	if err != nil {
		return nil, fmt.Errorf("failed to listen UDP for HTTP/3: %w", err)
	}
	s.h3Conn = h3Conn
	s.h3Port = h3Conn.LocalAddr().(*net.UDPAddr).Port

	// Load TLS config
	cert, err := tls.LoadX509KeyPair(s.certFile, s.keyFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load cert: %w", err)
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h3"},
	}

	s.h3Server = &http3.Server{
		Addr:      fmt.Sprintf(":%d", s.h3Port),
		Handler:   handler,
		TLSConfig: tlsConfig,
	}

	// Configure WebTransport
	s.wtServer = &webtransport.Server{
		H3: s.h3Server,
		// LAN mode needs cross-origin requests from browser pages not served by this local host.
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true // non-browser or same-origin requests without Origin header
			}
			u, err := url.Parse(origin)
			if err != nil {
				return false
			}
			return u.Scheme == "http" || u.Scheme == "https"
		},
	}
	webtransport.ConfigureHTTP3Server(s.h3Server)

	go func() {
		log.Printf("🚀 LAN HTTP/3 + WebTransport Server started on UDP port :%d", s.h3Port)
		if err := s.wtServer.Serve(s.h3Conn); err != nil && err != http.ErrServerClosed {
			log.Printf("❌ HTTP/3 Server error: %v", err)
		}
	}()

	log.Printf("📡 LAN Server Info: HTTP=%d, H3=%d, CertHash=%s...", s.httpPort, s.h3Port, s.certHash[:16])

	return &ServerInfo{
		HTTPPort: s.httpPort,
		H3Port:   s.h3Port,
		CertHash: s.certHash,
	}, nil
}

// Stop stops both servers
func (s *LocalServer) Stop() {
	if s.httpServer != nil {
		s.httpServer.Close()
	}
	if s.h3Server != nil {
		s.h3Server.Close()
	}
	if s.h3Conn != nil {
		s.h3Conn.Close()
		s.h3Conn = nil
	}
}

// GetInfo returns current server info
func (s *LocalServer) GetInfo() *ServerInfo {
	return &ServerInfo{
		HTTPPort: s.httpPort,
		H3Port:   s.h3Port,
		CertHash: s.certHash,
	}
}

// generateCertWithHash generates a self-signed cert and returns its SHA-256 hash
func (s *LocalServer) generateCertWithHash() (string, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject: pkix.Name{
			Organization: []string{"QuicLink LAN"},
			CommonName:   "QuicLink LAN",
		},
		// Backdate NotBefore to tolerate device clock skew between peers.
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(13 * 24 * time.Hour), // Must stay below 14 days for browser WT custom cert hashes
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	log.Printf("🔒 Generated self-signed certificate (valid from %s to %s)", template.NotBefore, template.NotAfter)

	// Add all local IPs to certificate
	template.DNSNames = []string{"localhost"}
	template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}

	addrs, _ := net.InterfaceAddrs()
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				template.IPAddresses = append(template.IPAddresses, ipnet.IP)
			}
		}
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return "", err
	}

	// Calculate SHA-256 hash of the certificate (for WebTransport serverCertificateHashes)
	hash := sha256.Sum256(derBytes)
	certHash := base64.StdEncoding.EncodeToString(hash[:])
	log.Printf("🔐 LAN Cert Hash: len=%d value=%s", len(certHash), certHash)

	// Write cert file
	certOut, err := os.Create(s.certFile)
	if err != nil {
		return "", err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		return "", err
	}

	// Write key file
	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return "", err
	}
	keyOut, err := os.Create(s.keyFile)
	if err != nil {
		return "", err
	}
	defer keyOut.Close()
	if err := pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}); err != nil {
		return "", err
	}

	return certHash, nil
}

// enableCORS adds CORS headers to allow LAN access from Web
func (s *LocalServer) enableCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-File-Name, X-File-Type")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// handleWebTransport upgrades connection to WebTransport for file transfer
func (s *LocalServer) handleWebTransport(w http.ResponseWriter, r *http.Request) {
	if s.wtServer == nil {
		http.Error(w, "WebTransport not available", http.StatusServiceUnavailable)
		return
	}

	session, err := s.wtServer.Upgrade(w, r)
	if err != nil {
		log.Printf("❌ WebTransport upgrade failed: %v", err)
		return
	}

	log.Printf("✅ WebTransport session established from %s", r.RemoteAddr)

	// Handle streams for file transfer
	go s.handleWTSession(session)
}

// handleWTSession handles incoming WebTransport streams
func (s *LocalServer) handleWTSession(session *webtransport.Session) {
	ctx := session.Context()

	for {
		stream, err := session.AcceptStream(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // Session closed
			}
			log.Printf("❌ AcceptStream error: %v", err)
			return
		}

		go s.handleWTStream(stream)
	}
}

// handleWTStream handles a single bidirectional stream for file operations
func (s *LocalServer) handleWTStream(stream *webtransport.Stream) {
	defer stream.Close()

	// Use bufio.Reader to read JSON command line without losing buffered data
	// json.NewDecoder would buffer extra bytes beyond JSON boundary, causing data loss
	bufReader := bufio.NewReader(stream)

	// Read the first line (JSON command terminated by \n)
	line, err := bufReader.ReadBytes('\n')
	if err != nil {
		log.Printf("❌ WT Stream read command error: %v", err)
		return
	}

	var cmd struct {
		Action  string `json:"action"` // "upload", "download", "list"
		FileID  string `json:"fileId,omitempty"`
		RelayID string `json:"relayId,omitempty"`
		Name    string `json:"name,omitempty"`
		Size    int64  `json:"size,omitempty"`
	}

	if err := json.Unmarshal(line, &cmd); err != nil {
		log.Printf("❌ WT Stream decode error: %v", err)
		return
	}

	switch cmd.Action {
	case "list":
		s.wtHandleList(stream)
	case "download":
		s.wtHandleDownload(stream, cmd.FileID)
	case "upload":
		// Pass bufReader so it can read remaining buffered data + stream
		s.wtHandleUpload(stream, bufReader, cmd.Name, cmd.Size)
	case "relay_upload":
		s.wtHandleRelayUpload(stream, bufReader, cmd.RelayID, cmd.Name)
	case "relay_download":
		s.wtHandleRelayDownload(stream, cmd.RelayID)
	}
}

func (s *LocalServer) wtHandleList(stream *webtransport.Stream) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	list := []*LocalFile{}
	for _, f := range s.files {
		list = append(list, f)
	}

	json.NewEncoder(stream).Encode(map[string]interface{}{
		"status": "ok",
		"files":  list,
	})
}

func (s *LocalServer) wtHandleDownload(stream *webtransport.Stream, fileID string) {
	s.mu.RLock()
	fileInfo, ok := s.files[fileID]
	s.mu.RUnlock()

	if !ok {
		json.NewEncoder(stream).Encode(map[string]string{"error": "file not found"})
		return
	}

	// Send file info first
	json.NewEncoder(stream).Encode(map[string]interface{}{
		"status": "ok",
		"name":   fileInfo.Name,
		"size":   fileInfo.Size,
	})

	// Stream file content
	file, err := os.Open(fileInfo.Path)
	if err != nil {
		return
	}
	defer file.Close()

	io.Copy(stream, file)
}

func (s *LocalServer) wtHandleUpload(stream *webtransport.Stream, bufReader *bufio.Reader, name string, size int64) {
	if size < 0 {
		json.NewEncoder(stream).Encode(map[string]string{"error": "invalid file size"})
		return
	}

	id := uuid.New().String()
	savePath := filepath.Join(s.uploadDir, id+"_"+name)

	dst, err := os.Create(savePath)
	if err != nil {
		json.NewEncoder(stream).Encode(map[string]string{"error": "failed to create file"})
		return
	}
	defer dst.Close()

	// Read file content from bufReader (which contains any buffered data + remaining stream)
	written, err := io.CopyN(dst, bufReader, size)
	if err != nil {
		if errors.Is(err, io.EOF) && written < size {
			log.Printf("❌ WT Upload truncated: expected=%d, written=%d", size, written)
			json.NewEncoder(stream).Encode(map[string]string{"error": "incomplete upload"})
			return
		}
		log.Printf("❌ WT Upload error: %v", err)
		json.NewEncoder(stream).Encode(map[string]string{"error": "upload failed"})
		return
	}

	if written != size {
		log.Printf("❌ WT Upload size mismatch: expected=%d, written=%d", size, written)
		json.NewEncoder(stream).Encode(map[string]string{"error": "upload size mismatch"})
		return
	}

	localFile := &LocalFile{
		ID:        id,
		Name:      name,
		Size:      written,
		Path:      savePath,
		CreatedAt: time.Now().Unix(),
	}

	s.mu.Lock()
	s.files[id] = localFile
	s.mu.Unlock()

	log.Printf("📥 WT Upload received: %s (%d bytes)", name, written)

	json.NewEncoder(stream).Encode(map[string]interface{}{
		"status": "ok",
		"file":   localFile,
	})
}

func (s *LocalServer) wtHandleRelayUpload(stream *webtransport.Stream, bufReader *bufio.Reader, relayID, name string) {
	if relayID == "" {
		json.NewEncoder(stream).Encode(map[string]string{"error": "missing relayId"})
		return
	}
	if name == "" {
		name = "relay_" + relayID
	}

	pr, pw := io.Pipe()
	session := &RelaySession{
		Reader: pr,
		Writer: pw,
		Done:   make(chan struct{}),
		Name:   name,
	}

	s.relayMu.Lock()
	s.relayMap[relayID] = session
	s.relayMu.Unlock()

	// Let sender know the relay session is ready for receiver download.
	_ = json.NewEncoder(stream).Encode(map[string]interface{}{
		"status":  "ready",
		"relayId": relayID,
	})

	defer func() {
		log.Printf("🏁 WT Relay Session Cleanup: %s", relayID)
		s.relayMu.Lock()
		delete(s.relayMap, relayID)
		s.relayMu.Unlock()
		pw.Close()
		close(session.Done)
	}()

	written, err := io.Copy(pw, bufReader)
	if err != nil {
		log.Printf("❌ WT Relay Upload Error (%s): %v", relayID, err)
		return
	}
	log.Printf("✅ WT Relay Complete: %s (%d bytes)", relayID, written)
}

func (s *LocalServer) wtHandleRelayDownload(stream *webtransport.Stream, relayID string) {
	if relayID == "" {
		json.NewEncoder(stream).Encode(map[string]string{"error": "missing relayId"})
		return
	}

	session, err := s.waitRelaySession(relayID, 30*time.Second)
	if err != nil {
		json.NewEncoder(stream).Encode(map[string]string{"error": "relay session timeout"})
		return
	}

	log.Printf("🚀 WT Relay Download Connected: %s (File: %s)", relayID, session.Name)

	json.NewEncoder(stream).Encode(map[string]interface{}{
		"status": "ok",
		"name":   session.Name,
	})
	if _, err := io.Copy(stream, session.Reader); err != nil {
		log.Printf("❌ WT Relay Download Error (%s): %v", relayID, err)
	}
}

// --- HTTP Handlers (existing, unchanged) ---

func (s *LocalServer) handleListFiles(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	list := []*LocalFile{}
	for _, f := range s.files {
		list = append(list, f)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

func (s *LocalServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Limit upload size (e.g., 10GB for LAN)
	r.Body = http.MaxBytesReader(w, r.Body, 10<<30)

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	id := uuid.New().String()
	savePath := filepath.Join(s.uploadDir, id+"_"+header.Filename)

	dst, err := os.Create(savePath)
	if err != nil {
		http.Error(w, "Failed to create file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}

	localFile := &LocalFile{
		ID:        id,
		Name:      header.Filename,
		Size:      header.Size,
		Path:      savePath,
		CreatedAt: time.Now().Unix(),
	}

	s.mu.Lock()
	s.files[id] = localFile
	s.mu.Unlock()

	log.Printf("📥 HTTP Upload received: %s (%d bytes)", header.Filename, header.Size)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(localFile)
}

func (s *LocalServer) handleDownload(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/api/lan/download/"):]
	if id == "" {
		http.Error(w, "Missing ID", http.StatusBadRequest)
		return
	}

	s.mu.RLock()
	fileInfo, ok := s.files[id]
	s.mu.RUnlock()

	if !ok {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", fileInfo.Name))
	http.ServeFile(w, r, fileInfo.Path)
}

// --- Phase 9: Streaming Relay Handlers ---

// handleRelayUpload receives the file stream from Sender
// POST /api/lan/relay/upload/:id
func (s *LocalServer) handleRelayUpload(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/api/lan/relay/upload/"):]
	if id == "" {
		http.Error(w, "Missing Relay ID", http.StatusBadRequest)
		return
	}

	log.Printf("🚀 Relay Upload Start: %s", id)

	// Create Pipe
	pr, pw := io.Pipe()

	// Decode filename (query param preferred to avoid CORS custom-header preflight)
	rawName := r.URL.Query().Get("name")
	if rawName == "" {
		rawName = r.Header.Get("X-File-Name")
	}
	decodedName, err := url.QueryUnescape(rawName)
	if err != nil {
		decodedName = rawName // Fallback
	}
	if decodedName == "" {
		decodedName = "relay_" + id
	}

	session := &RelaySession{
		Reader: pr,
		Writer: pw,
		Done:   make(chan struct{}),
		Name:   decodedName,
		// Size:   r.ContentLength, // optional
	}

	// Register session
	s.relayMu.Lock()
	s.relayMap[id] = session
	s.relayMu.Unlock()

	// Wait for downloader to connect signal?
	// Actually, we just start copying to pipe. Writer will block until reader is ready.

	// Cleanup ensure
	defer func() {
		log.Printf("🏁 Relay Session Cleanup: %s", id)
		s.relayMu.Lock()
		delete(s.relayMap, id)
		s.relayMu.Unlock()
		pw.Close() // Close writer, reader will get EOF
		close(session.Done)
	}()

	// Copy request body to Pipe
	// This BLOCKs until the Reader (Downloader) reads data
	written, err := io.Copy(pw, r.Body)
	if err != nil {
		log.Printf("❌ Relay Pipe Error (Upload side): %v", err)
		http.Error(w, "Relay Broken", http.StatusInternalServerError)
		return
	}

	log.Printf("✅ Relay Complete: %s (%d bytes)", id, written)
	w.WriteHeader(http.StatusOK)
}

// handleRelayDownload sends the file stream to Receiver
// GET /api/lan/relay/download/:id
func (s *LocalServer) handleRelayDownload(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/api/lan/relay/download/"):]
	if id == "" {
		http.Error(w, "Missing Relay ID", http.StatusBadRequest)
		return
	}

	session, err := s.waitRelaySession(id, 30*time.Second)
	if err != nil {
		http.Error(w, "Relay Session Timeout (Sender did not connect)", http.StatusNotFound)
		return
	}

	log.Printf("🚀 Relay Download Connected: %s (File: %s)", id, session.Name)

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", session.Name))
	w.Header().Set("Content-Type", "application/octet-stream")

	// Stream from Pipe Reader
	// This UNBLOCKs the writer
	_, err = io.Copy(w, session.Reader)
	if err != nil {
		log.Printf("❌ Relay Download Error: %v", err)
	}
}

func (s *LocalServer) waitRelaySession(id string, timeoutDur time.Duration) (*RelaySession, error) {
	timeout := time.After(timeoutDur)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-timeout:
			return nil, fmt.Errorf("timeout waiting relay session %s", id)
		case <-ticker.C:
			s.relayMu.Lock()
			session, found := s.relayMap[id]
			s.relayMu.Unlock()
			if found {
				return session, nil
			}
		}
	}
}
