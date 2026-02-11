package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"quiclink-server/config"
)

type RelayFile struct {
	ID         string
	Name       string
	Path       string
	Size       int64
	CreatedAt  time.Time
	ExpiresAt  time.Time
	Downloaded int
	Acked      int
}

var (
	relayIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{6,128}$`)
	relayRootDir   = filepath.Join(UploadDir, "relay")

	relayStore = struct {
		sync.RWMutex
		items map[string]*RelayFile
	}{
		items: make(map[string]*RelayFile),
	}

	relayCleanupOnce sync.Once
)

func addRelayCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Range")
}

func relayTTL() time.Duration {
	minutes := config.Current.Limits.FileRetentionMinutes
	if minutes <= 0 {
		minutes = 30
	}
	return time.Duration(minutes) * time.Minute
}

func relayMaxUploadSizeBytes() int64 {
	maxUploadSize := config.Current.Limits.MaxUploadSizeMB << 20
	if maxUploadSize <= 0 {
		maxUploadSize = 10 << 20
	}
	return maxUploadSize
}

func parseRelayID(path, prefix string) (string, error) {
	if !strings.HasPrefix(path, prefix) {
		return "", errors.New("invalid path")
	}
	relayID := strings.TrimPrefix(path, prefix)
	if relayID == "" || strings.Contains(relayID, "/") {
		return "", errors.New("invalid relay id")
	}
	if !relayIDPattern.MatchString(relayID) {
		return "", errors.New("invalid relay id format")
	}
	return relayID, nil
}

func removeRelayFileLocked(relayID string) {
	existing, ok := relayStore.items[relayID]
	if !ok {
		return
	}
	_ = os.Remove(existing.Path)
	delete(relayStore.items, relayID)
}

func StartRelayCleanupLoop() {
	relayCleanupOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(1 * time.Minute)
			defer ticker.Stop()

			for range ticker.C {
				now := time.Now()
				var expired []string

				relayStore.RLock()
				for relayID, item := range relayStore.items {
					if now.After(item.ExpiresAt) {
						expired = append(expired, relayID)
					}
				}
				relayStore.RUnlock()

				if len(expired) == 0 {
					continue
				}

				relayStore.Lock()
				for _, relayID := range expired {
					removeRelayFileLocked(relayID)
				}
				relayStore.Unlock()
			}
		}()
	})
}

func HandleRelayUpload(w http.ResponseWriter, r *http.Request) {
	addRelayCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	relayID, err := parseRelayID(r.URL.Path, "/api/relay/upload/")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fileName := strings.TrimSpace(r.URL.Query().Get("name"))
	if fileName == "" {
		fileName = "relay.bin"
	}
	fileName = filepath.Base(fileName)

	if err := os.MkdirAll(relayRootDir, os.ModePerm); err != nil {
		http.Error(w, "failed to initialize relay storage", http.StatusInternalServerError)
		return
	}

	maxUploadSize := relayMaxUploadSizeBytes()
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	tempPath := filepath.Join(relayRootDir, relayID+".part")
	finalPath := filepath.Join(relayRootDir, relayID)

	relayStore.Lock()
	removeRelayFileLocked(relayID)
	relayStore.Unlock()

	dst, err := os.Create(tempPath)
	if err != nil {
		http.Error(w, "failed to create relay temp file", http.StatusInternalServerError)
		return
	}

	written, copyErr := io.Copy(dst, r.Body)
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(tempPath)
		var maxBytesErr *http.MaxBytesError
		if errors.As(copyErr, &maxBytesErr) {
			http.Error(
				w,
				fmt.Sprintf("relay upload too large: max %d MB", maxUploadSize>>20),
				http.StatusRequestEntityTooLarge,
			)
			return
		}
		http.Error(w, "relay upload failed", http.StatusBadRequest)
		return
	}
	if closeErr != nil {
		_ = os.Remove(tempPath)
		http.Error(w, "relay upload failed", http.StatusInternalServerError)
		return
	}

	if err := os.Rename(tempPath, finalPath); err != nil {
		_ = os.Remove(tempPath)
		http.Error(w, "failed to finalize relay upload", http.StatusInternalServerError)
		return
	}

	now := time.Now()
	expireAt := now.Add(relayTTL())

	relayStore.Lock()
	relayStore.items[relayID] = &RelayFile{
		ID:        relayID,
		Name:      fileName,
		Path:      finalPath,
		Size:      written,
		CreatedAt: now,
		ExpiresAt: expireAt,
	}
	relayStore.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "ok",
		"relayId":     relayID,
		"name":        fileName,
		"size":        written,
		"downloadUrl": fmt.Sprintf("/api/relay/download/%s", relayID),
		"expiresAt":   expireAt.Unix(),
	})
}

func HandleRelayDownload(w http.ResponseWriter, r *http.Request) {
	addRelayCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	relayID, err := parseRelayID(r.URL.Path, "/api/relay/download/")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	relayStore.RLock()
	item, ok := relayStore.items[relayID]
	relayStore.RUnlock()
	if !ok {
		http.NotFound(w, r)
		return
	}

	if time.Now().After(item.ExpiresAt) {
		relayStore.Lock()
		removeRelayFileLocked(relayID)
		relayStore.Unlock()
		http.NotFound(w, r)
		return
	}

	file, err := os.Open(item.Path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename*=UTF-8''%s", url.QueryEscape(item.Name)))
	http.ServeContent(w, r, item.Name, item.CreatedAt, file)

	relayStore.Lock()
	if existing := relayStore.items[relayID]; existing != nil {
		existing.Downloaded++
	}
	relayStore.Unlock()
}

func HandleRelayMeta(w http.ResponseWriter, r *http.Request) {
	addRelayCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	relayID, err := parseRelayID(r.URL.Path, "/api/relay/meta/")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	relayStore.RLock()
	item, ok := relayStore.items[relayID]
	relayStore.RUnlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":           "not_found",
			"relayId":          relayID,
			"canDownload":      false,
			"remainingSeconds": 0,
		})
		return
	}

	now := time.Now()
	if now.After(item.ExpiresAt) {
		relayStore.Lock()
		removeRelayFileLocked(relayID)
		relayStore.Unlock()

		w.WriteHeader(http.StatusGone)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":           "expired",
			"relayId":          relayID,
			"name":             item.Name,
			"size":             item.Size,
			"canDownload":      false,
			"remainingSeconds": 0,
		})
		return
	}

	if _, statErr := os.Stat(item.Path); statErr != nil {
		relayStore.Lock()
		delete(relayStore.items, relayID)
		relayStore.Unlock()

		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":           "missing",
			"relayId":          relayID,
			"canDownload":      false,
			"remainingSeconds": 0,
		})
		return
	}

	remaining := int(item.ExpiresAt.Sub(now).Seconds())
	if remaining < 0 {
		remaining = 0
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "ready",
		"relayId":          relayID,
		"name":             item.Name,
		"size":             item.Size,
		"createdAt":        item.CreatedAt.Unix(),
		"expiresAt":        item.ExpiresAt.Unix(),
		"remainingSeconds": remaining,
		"downloaded":       item.Downloaded,
		"acked":            item.Acked,
		"canDownload":      true,
		"acceptRanges":     true,
	})
}

func HandleRelayAck(w http.ResponseWriter, r *http.Request) {
	addRelayCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	relayID, err := parseRelayID(r.URL.Path, "/api/relay/ack/")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var req struct {
		Cleanup bool `json:"cleanup"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	relayStore.Lock()
	item := relayStore.items[relayID]
	if item == nil {
		relayStore.Unlock()
		http.NotFound(w, r)
		return
	}

	if req.Cleanup {
		removeRelayFileLocked(relayID)
		relayStore.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"relayId": relayID,
			"cleanup": true,
		})
		return
	}

	item.Acked++
	earlyExpire := time.Now().Add(2 * time.Minute)
	if item.ExpiresAt.After(earlyExpire) {
		item.ExpiresAt = earlyExpire
	}
	acked := item.Acked
	relayStore.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "ok",
		"relayId": relayID,
		"acked":   acked,
	})
}
