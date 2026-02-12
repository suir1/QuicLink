package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"QuicLink/p2p"
	"QuicLink/server"

	"QuicLink/config"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/quic-go/quic-go/http3"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.design/x/clipboard"
)

// App struct
type App struct {
	ctx                     context.Context
	conn                    *websocket.Conn
	connMu                  sync.Mutex
	roomID                  string
	serverHost              string
	lastClipText            string
	lastClipSig             string
	pendingClip             map[string]string
	autoSyncRemoteClipboard bool
	clipMu                  sync.Mutex
	p2pNode                 *p2p.Node
	transportMode           string // "ws" or "wt"
	localServer             *server.LocalServer
	lanServerInfo           *server.ServerInfo // LAN Server info (ports, cert hash)
	deviceID                string
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		serverHost:              "localhost:3100", // Default, can be configured
		p2pNode:                 p2p.NewNode(),
		transportMode:           "none",
		localServer:             server.NewLocalServer(),
		deviceID:                uuid.New().String(),
		pendingClip:             make(map[string]string),
		autoSyncRemoteClipboard: true,
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

	// Load Config
	config.LoadConfig()
	a.localServer.SetUploadDir(config.Current.DownloadDir)

	// Start Local LAN Server (HTTP + HTTP/3)
	info, err := a.localServer.Start()
	if err != nil {
		log.Printf("❌ Failed to start local server: %v", err)
	} else {
		a.lanServerInfo = info
		log.Printf("🚀 LAN Server: HTTP=%d, HTTP/3=%d", info.HTTPPort, info.H3Port)
		// Broadcast LAN info periodically
		go a.broadcastLanInfo()
	}
}

// broadcastLanInfo periodically sends local IP/Port to signaling server
func (a *App) broadcastLanInfo() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	// Send immediately once
	time.AfterFunc(2*time.Second, func() {
		a.sendLanInfo()
	})

	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			a.sendLanInfo()
		}
	}
}

func (a *App) sendLanInfo() {
	if !a.GetConnectionStatus() || a.lanServerInfo == nil {
		return
	}

	ip := a.getLocalIP()
	if ip == "" {
		return
	}

	hostname, _ := os.Hostname()

	// Payload sent to other clients (dual protocol info)
	payload := map[string]interface{}{
		"id":       a.deviceID, // Unique ID per desktop instance
		"ip":       ip,
		"httpPort": a.lanServerInfo.HTTPPort, // HTTP fallback
		"h3Port":   a.lanServerInfo.H3Port,   // HTTP/3 + WebTransport
		"certHash": a.lanServerInfo.CertHash, // For browser WebTransport
		"name":     hostname,                 // Friendly name
	}
	log.Printf(
		"📡 Broadcasting lan_info: id=%s ip=%s http=%d h3=%d certHashLen=%d certPrefix=%s...",
		a.deviceID,
		ip,
		a.lanServerInfo.HTTPPort,
		a.lanServerInfo.H3Port,
		len(a.lanServerInfo.CertHash),
		truncate(a.lanServerInfo.CertHash, 12),
	)
	a.sendMessage(map[string]interface{}{
		"type":    "lan_info",
		"payload": payload,
	})
}

func (a *App) getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	for _, address := range addrs {
		// Check for IPv4 and not loopback
		if ipnet, ok := address.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return ""
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
			content, sig := a.readClipboardSnapshot()
			if content == "" || sig == "" {
				continue
			}

			if !a.tryMarkClipboardSeen(sig, content) {
				continue
			}

			log.Printf("📋 Clipboard changed (detected): %s", truncate(content, 50))

			id := fmt.Sprintf("%d-%s", time.Now().UnixMilli(), uuid.NewString()[:8])
			if !a.sendClipboardPush(content, id) {
				a.setPendingClipboard(content, id)
			}

			// Emit event to frontend
			wailsRuntime.EventsEmit(a.ctx, "clipboard:local", content)
		}
	}
}

func (a *App) readClipboardSnapshot() (string, string) {
	text := string(clipboard.Read(clipboard.FmtText))
	if text != "" {
		sum := sha256.Sum256([]byte(text))
		return text, "text:" + base64.StdEncoding.EncodeToString(sum[:])
	}

	imgBytes := clipboard.Read(clipboard.FmtImage)
	if len(imgBytes) == 0 {
		return "", ""
	}

	sum := sha256.Sum256(imgBytes)
	mime := http.DetectContentType(imgBytes)
	if !strings.HasPrefix(mime, "image/") {
		mime = "image/png"
	}
	content := fmt.Sprintf(
		"data:%s;base64,%s",
		mime,
		base64.StdEncoding.EncodeToString(imgBytes),
	)
	return content, "image:" + base64.StdEncoding.EncodeToString(sum[:])
}

func (a *App) tryMarkClipboardSeen(sig, content string) bool {
	a.clipMu.Lock()
	defer a.clipMu.Unlock()

	if sig == a.lastClipSig {
		return false
	}
	a.lastClipSig = sig
	a.lastClipText = content
	return true
}

func (a *App) markClipboardSeen(content string) {
	snapshot := content
	if strings.HasPrefix(content, "data:image") {
		if raw, err := decodeImageDataURL(content); err == nil {
			sum := sha256.Sum256(raw)
			snapshot = "image:" + base64.StdEncoding.EncodeToString(sum[:])
		}
	}
	if !strings.HasPrefix(snapshot, "image:") {
		sum := sha256.Sum256([]byte(content))
		snapshot = "text:" + base64.StdEncoding.EncodeToString(sum[:])
	}

	a.clipMu.Lock()
	a.lastClipText = content
	a.lastClipSig = snapshot
	a.clipMu.Unlock()
}

func (a *App) sendClipboardPush(content, id string) bool {
	if !a.GetConnectionStatus() {
		return false
	}
	a.sendMessage(map[string]interface{}{
		"type": "clipboard_push",
		"payload": map[string]string{
			"text": content,
			"id":   id,
		},
	})
	return true
}

func (a *App) setPendingClipboard(content, id string) {
	a.clipMu.Lock()
	a.pendingClip = map[string]string{
		"text": content,
		"id":   id,
	}
	a.clipMu.Unlock()
}

func (a *App) flushPendingClipboard() {
	if !a.GetConnectionStatus() {
		return
	}

	a.clipMu.Lock()
	payload := a.pendingClip
	a.clipMu.Unlock()
	if payload == nil || payload["text"] == "" {
		return
	}

	if a.sendClipboardPush(payload["text"], payload["id"]) {
		a.clipMu.Lock()
		a.pendingClip = nil
		a.clipMu.Unlock()
	}
}

// GetAutoSyncRemoteClipboard returns whether remote clipboard is written into system clipboard automatically.
func (a *App) GetAutoSyncRemoteClipboard() bool {
	a.clipMu.Lock()
	defer a.clipMu.Unlock()
	return a.autoSyncRemoteClipboard
}

// SetAutoSyncRemoteClipboard controls whether remote clipboard updates are written back into system clipboard.
func (a *App) SetAutoSyncRemoteClipboard(enabled bool) {
	a.clipMu.Lock()
	a.autoSyncRemoteClipboard = enabled
	a.clipMu.Unlock()
	log.Printf("⚙️ Clipboard auto-sync set to: %v", enabled)
}

func decodeImageDataURL(content string) ([]byte, error) {
	const marker = ";base64,"
	if !strings.HasPrefix(content, "data:image") {
		return nil, fmt.Errorf("not image data url")
	}
	idx := strings.Index(content, marker)
	if idx < 0 {
		return nil, fmt.Errorf("invalid data url")
	}
	return base64.StdEncoding.DecodeString(content[idx+len(marker):])
}

// GetTransportMode returns current transport mode ("ws", "wt", or "none")
func (a *App) GetTransportMode() string {
	return a.transportMode
}

// GetLocalServerPort returns the HTTP port of the local LAN server
func (a *App) GetLocalServerPort() int {
	if a.lanServerInfo != nil {
		return a.lanServerInfo.HTTPPort
	}
	return 0
}

// GetLocalLanInfo returns local LAN server info for frontend relay logic.
func (a *App) GetLocalLanInfo() map[string]interface{} {
	if a.lanServerInfo == nil {
		return map[string]interface{}{
			"ip":       "",
			"httpPort": 0,
			"h3Port":   0,
			"certHash": "",
		}
	}
	return map[string]interface{}{
		"ip":       a.getLocalIP(),
		"httpPort": a.lanServerInfo.HTTPPort,
		"h3Port":   a.lanServerInfo.H3Port,
		"certHash": a.lanServerInfo.CertHash,
	}
}

// StartNativeRelayUpload starts LAN relay upload directly in Go (desktop data plane),
// without using WebView fetch/WebTransport JS APIs.
func (a *App) StartNativeRelayUpload(relayID, filePath, fileName string, persist bool) error {
	if a.localServer == nil {
		return fmt.Errorf("local server not ready")
	}
	if strings.TrimSpace(relayID) == "" {
		return fmt.Errorf("relay id is required")
	}
	if strings.TrimSpace(filePath) == "" {
		return fmt.Errorf("file path is required")
	}

	err := a.localServer.StartRelayFromFile(relayID, filePath, fileName, persist)
	if err != nil {
		return err
	}
	log.Printf("🚀 Native relay started: id=%s file=%s persist=%v", relayID, filePath, persist)
	return nil
}

// ImportLocalFile imports a local file path into LAN shared storage.
func (a *App) ImportLocalFile(filePath string) (map[string]interface{}, error) {
	if a.localServer == nil {
		return nil, fmt.Errorf("local server not ready")
	}
	localFile, err := a.localServer.ImportFileFromPath(filePath)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"id":        localFile.ID,
		"name":      localFile.Name,
		"size":      localFile.Size,
		"createdAt": localFile.CreatedAt,
	}, nil
}

// UploadCloudFile uploads a local file to VPS /upload endpoint with Go-native multipart streaming.
func (a *App) UploadCloudFile(filePath string) (map[string]interface{}, error) {
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return nil, fmt.Errorf("file path is required")
	}

	host := strings.TrimSpace(a.serverHost)
	if host == "" {
		host = "localhost:3100"
	}
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimPrefix(host, "https://")

	attempts := []struct {
		scheme string
		via    string
		useH3  bool
	}{
		{scheme: "https", via: "h3", useH3: true},
		{scheme: "https", via: "https", useH3: false},
		{scheme: "http", via: "http", useH3: false},
	}
	var lastErr error
	for _, attempt := range attempts {
		endpoint := fmt.Sprintf("%s://%s/upload", attempt.scheme, host)
		var (
			resp map[string]interface{}
			err  error
		)
		if attempt.useH3 {
			resp, err = postMultipartFileH3(endpoint, filePath, true)
		} else {
			resp, err = postMultipartFile(endpoint, filePath, attempt.scheme == "https")
		}
		if err != nil {
			lastErr = fmt.Errorf("%s upload failed: %w", strings.ToUpper(attempt.via), err)
			continue
		}

		if u, ok := resp["url"].(string); ok && strings.HasPrefix(u, "/") {
			resp["url"] = fmt.Sprintf("%s://%s%s", attempt.scheme, host, u)
		}
		resp["uploadVia"] = attempt.via
		return resp, nil
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("upload failed")
	}
	return nil, lastErr
}

// UploadVpsRelayFile uploads a local file to VPS relay endpoint and returns relay metadata.
func (a *App) UploadVpsRelayFile(filePath string) (map[string]interface{}, error) {
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return nil, fmt.Errorf("file path is required")
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("path is a directory")
	}

	host := strings.TrimSpace(a.serverHost)
	if host == "" {
		host = "localhost:3100"
	}
	host = strings.TrimPrefix(host, "http://")
	host = strings.TrimPrefix(host, "https://")

	fileName := filepath.Base(filePath)
	relayID := fmt.Sprintf("vps-relay-%d-%s", time.Now().UnixMilli(), uuid.NewString()[:8])
	attempts := []struct {
		scheme string
		via    string
		useH3  bool
	}{
		{scheme: "https", via: "h3", useH3: true},
		{scheme: "https", via: "https", useH3: false},
		{scheme: "http", via: "http", useH3: false},
	}

	var lastErr error
	for _, attempt := range attempts {
		endpoint := fmt.Sprintf("%s://%s/api/relay/upload/%s?name=%s",
			attempt.scheme, host, relayID, url.QueryEscape(fileName))

		var (
			resp map[string]interface{}
			err  error
		)
		if attempt.useH3 {
			resp, err = postMultipartFileH3(endpoint, filePath, true)
		} else {
			resp, err = postMultipartFile(endpoint, filePath, attempt.scheme == "https")
		}
		if err != nil {
			lastErr = fmt.Errorf("%s upload failed: %w", strings.ToUpper(attempt.via), err)
			continue
		}

		rawDownloadURL, _ := resp["downloadUrl"].(string)
		if rawDownloadURL == "" {
			rawDownloadURL = fmt.Sprintf("/api/relay/download/%s", relayID)
		}
		absDownloadURL := rawDownloadURL
		if strings.HasPrefix(rawDownloadURL, "/") {
			absDownloadURL = fmt.Sprintf("%s://%s%s", attempt.scheme, host, rawDownloadURL)
		}

		return map[string]interface{}{
			"id":         relayID,
			"relayId":    relayID,
			"name":       fileName,
			"size":       info.Size(),
			"type":       "application/octet-stream",
			"url":        absDownloadURL,
			"isVpsRelay": true,
			"uploadVia":  attempt.via,
			"expiresAt":  resp["expiresAt"],
		}, nil
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("vps relay upload failed")
	}
	return nil, lastErr
}

func postMultipartFile(endpoint, filePath string, insecureTLS bool) (map[string]interface{}, error) {
	transport := &http.Transport{}
	if insecureTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   0, // keep streaming for large files
	}
	return postMultipartFileWithClient(endpoint, filePath, client)
}

func postMultipartFileH3(endpoint, filePath string, insecureTLS bool) (map[string]interface{}, error) {
	transport := &http3.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: insecureTLS},
	}
	defer transport.Close()

	client := &http.Client{
		Transport: transport,
		Timeout:   0, // keep streaming for large files
	}
	return postMultipartFileWithClient(endpoint, filePath, client)
}

func postMultipartFileWithClient(endpoint, filePath string, client *http.Client) (map[string]interface{}, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open file failed: %w", err)
	}
	defer file.Close()

	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)

	go func() {
		defer pw.Close()
		defer writer.Close()

		part, err := writer.CreateFormFile("file", filepath.Base(filePath))
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(part, file); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
	}()

	req, err := http.NewRequest(http.MethodPost, endpoint, pr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("upload failed: %d %s", resp.StatusCode, string(body))
	}

	if len(bytes.TrimSpace(body)) == 0 {
		return map[string]interface{}{
			"url": "",
		}, nil
	}

	var out map[string]interface{}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("invalid upload response: %w", err)
	}
	return out, nil
}

// DownloadLanRelayFile downloads LAN relay file to desktop download directory via Go native HTTP client.
func (a *App) DownloadLanRelayFile(relayID, fileName, ip string, httpPort int) (string, error) {
	relayID = strings.TrimSpace(relayID)
	if relayID == "" {
		return "", fmt.Errorf("relay id is required")
	}
	if strings.TrimSpace(ip) == "" {
		ip = "127.0.0.1"
	}
	if httpPort <= 0 {
		if a.lanServerInfo != nil && a.lanServerInfo.HTTPPort > 0 {
			httpPort = a.lanServerInfo.HTTPPort
		} else {
			return "", fmt.Errorf("http port is required")
		}
	}

	endpoint := fmt.Sprintf("http://%s:%d/api/lan/relay/download/%s", ip, httpPort, url.PathEscape(relayID))
	return a.downloadToLocal(endpoint, fileName)
}

func (a *App) downloadToLocal(downloadURL, fallbackName string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, downloadURL, nil)
	if err != nil {
		return "", err
	}
	transport := &http.Transport{
		DisableCompression: true,
		MaxIdleConns:       64,
		MaxConnsPerHost:    32,
		IdleConnTimeout:    90 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   0, // Large files: stream until completion.
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return "", fmt.Errorf("download failed: %d %s", resp.StatusCode, string(body))
	}

	name := strings.TrimSpace(fallbackName)
	if name == "" {
		if _, params, err := mime.ParseMediaType(resp.Header.Get("Content-Disposition")); err == nil {
			if v := strings.TrimSpace(params["filename"]); v != "" {
				name = filepath.Base(v)
			}
		}
	}
	if name == "" {
		name = fmt.Sprintf("relay-%d.bin", time.Now().Unix())
	}

	dir := config.Current.DownloadDir
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, "Downloads", "QuicLink")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	savePath := uniqueFilePath(dir, name)
	dst, err := os.Create(savePath)
	if err != nil {
		return "", err
	}
	defer dst.Close()

	buf := make([]byte, 1024*1024)
	written, err := io.CopyBuffer(dst, resp.Body, buf)
	if err != nil {
		return "", err
	}
	log.Printf("📥 Native LAN relay download complete: %s (%d bytes)", savePath, written)
	return savePath, nil
}

func uniqueFilePath(dir, name string) string {
	base := filepath.Base(name)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" {
		stem = "download"
	}
	full := filepath.Join(dir, stem+ext)
	if _, err := os.Stat(full); os.IsNotExist(err) {
		return full
	}
	for i := 1; i < 10000; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s(%d)%s", stem, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, time.Now().UnixNano(), ext))
}

// GetClipboard returns current clipboard text
func (a *App) GetClipboard() string {
	return string(clipboard.Read(clipboard.FmtText))
}

// SetClipboard sets system clipboard text
func (a *App) SetClipboard(text string) {
	if text == "" {
		return
	}

	a.markClipboardSeen(text) // Prevent echo

	if strings.HasPrefix(text, "data:image") {
		if raw, err := decodeImageDataURL(text); err == nil {
			clipboard.Write(clipboard.FmtImage, raw)
			return
		}
	}

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
		go a.flushPendingClipboard()
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
	go a.flushPendingClipboard()
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
			if a.GetAutoSyncRemoteClipboard() {
				a.SetClipboard(content)
			}
			wailsRuntime.EventsEmit(a.ctx, "clipboard:remote", content)
		}
	case "clipboard_data":
		// New Protocol: Server broadcasts clipboard_data with ID
		if content, ok := payload["text"].(string); ok {
			log.Printf("📋 Received clipboard_data: %s", truncate(content, 50))
			if a.GetAutoSyncRemoteClipboard() {
				// Auto-sync remote clipboard to system clipboard.
				a.SetClipboard(content)
			}
			wailsRuntime.EventsEmit(a.ctx, "clipboard:remote", payload)
		}
	case "clipboard_pull":
		content, sig := a.readClipboardSnapshot()
		if content == "" || sig == "" {
			log.Printf("📋 clipboard_pull: local clipboard empty")
			return
		}
		a.tryMarkClipboardSeen(sig, content)
		id := fmt.Sprintf("%d-%s", time.Now().UnixMilli(), uuid.NewString()[:8])
		if !a.sendClipboardPush(content, id) {
			a.setPendingClipboard(content, id)
		}
	case "file_offer":
		// Forward to frontend for display
		wailsRuntime.EventsEmit(a.ctx, "p2p:offer", payload)
	case "init":
		// Handle init message - extract and emit clipboard history directly
		log.Printf("📥 Received init message from server")
		if history, ok := payload["clipboardHistory"].([]interface{}); ok && len(history) > 0 {
			log.Printf("📜 Emitting clipboard history to frontend (%d items)", len(history))
			wailsRuntime.EventsEmit(a.ctx, "clipboard:history", history)
		} else {
			log.Printf("⚠️ Init payload has no clipboardHistory or it's empty")
		}
		// Also forward the whole init for other handlers (notes, hostInfo etc)
		wailsRuntime.EventsEmit(a.ctx, "p2p:message", map[string]interface{}{"type": msgType, "payload": payload})
	default:
		// Forward generic messages (init, chat, etc) to frontend
		log.Printf("📤 Forwarding message to frontend: type=%s", msgType)
		wailsRuntime.EventsEmit(a.ctx, "p2p:message", map[string]interface{}{"type": msgType, "payload": payload})
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
	content, sig := a.readClipboardSnapshot()
	if content != "" && sig != "" {
		a.tryMarkClipboardSeen(sig, content)
		id := fmt.Sprintf("%d-%s", time.Now().UnixMilli(), uuid.NewString()[:8])
		if !a.sendClipboardPush(content, id) {
			a.setPendingClipboard(content, id)
		}
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
	if a.localServer != nil {
		a.localServer.Stop()
	}
	a.Disconnect()
}

// OpenDownloadDir opens the local download directory
func (a *App) OpenDownloadDir() {
	path := config.Current.DownloadDir
	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, "Downloads", "QuicLink")
	}

	// Create if not exists
	os.MkdirAll(path, 0755)

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", path)
	case "darwin":
		cmd = exec.Command("open", path)
	case "linux":
		cmd = exec.Command("xdg-open", path)
	default:
		log.Printf("❌ Unsupported OS for OpenDownloadDir")
		return
	}

	cmd.Start()
}

// SelectDownloadDir opens a dialog for the user to select the download directory
func (a *App) SelectDownloadDir() string {
	selection, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Select Download Directory",
	})

	if err != nil || selection == "" {
		return ""
	}

	// Update Config
	if err := config.SetDownloadDir(selection); err != nil {
		log.Printf("❌ Failed to save config: %v", err)
		return ""
	}

	// Update Local Server
	a.localServer.SetUploadDir(selection)
	return selection
}

// SelectRelayFiles opens native file picker and returns file metadata for Go-native relay path.
func (a *App) SelectRelayFiles() []map[string]interface{} {
	selection, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Select Files For Relay",
	})
	if err != nil || len(selection) == 0 {
		return []map[string]interface{}{}
	}

	result := make([]map[string]interface{}, 0, len(selection))
	for _, p := range selection {
		info, statErr := os.Stat(p)
		if statErr != nil || info.IsDir() {
			continue
		}
		result = append(result, map[string]interface{}{
			"path": p,
			"name": filepath.Base(p),
			"size": info.Size(),
			"type": "application/octet-stream",
		})
	}
	return result
}

// GetDownloadDir returns the current download directory
func (a *App) GetDownloadDir() string {
	if config.Current == nil {
		return ""
	}
	return config.Current.DownloadDir
}

// beforeClose is called before the app closes
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	a.Disconnect()
	time.Sleep(100 * time.Millisecond) // Allow graceful close
	return false
}
