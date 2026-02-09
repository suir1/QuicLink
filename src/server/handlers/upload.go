package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"quiclink-server/config" // 引入配置
)

const UploadDir = "./uploads"

func HandleUpload(w http.ResponseWriter, r *http.Request) {
	// 1动态获取大小限制
	maxSize := config.Current.Limits.MaxUploadSizeMB << 20 // MB -> Bytes

	// 限制读取大小
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, fmt.Sprintf("File too large! Max size: %dMB", config.Current.Limits.MaxUploadSizeMB), http.StatusRequestEntityTooLarge)
		return
	}

	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 2. 准备保存
	os.MkdirAll(UploadDir, os.ModePerm)
	filename := filepath.Base(handler.Filename)
	safeName := fmt.Sprintf("%d_%s", time.Now().Unix(), filename)
	dstPath := filepath.Join(UploadDir, safeName)

	dst, err := os.Create(dstPath)
	if err != nil {
		http.Error(w, "Save failed", http.StatusInternalServerError)
		return
	}
	defer dst.Close()
	io.Copy(dst, file)

	// 3. 处理过期删除 (如果是 0 则不删除)
	retention := config.Current.Limits.FileRetentionMinutes
	if retention > 0 {
		go func(path string, minutes int) {
			time.Sleep(time.Duration(minutes) * time.Minute)
			os.Remove(path)
			log.Printf("🗑️ Auto-deleted: %s", path)
		}(dstPath, retention)
	}

	// 4. 响应
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "success",
		"url":    "/files/" + safeName,
		"name":   filename,
	})
}

type FileInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Url       string `json:"url"`
	CreatedAt int64  `json:"createdAt"`
}

func HandleListFiles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	entries, err := os.ReadDir(UploadDir)
	if err != nil {
		json.NewEncoder(w).Encode([]FileInfo{})
		return
	}

	var files = []FileInfo{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}

		// Parse original name from "timestamp_filename"
		// If parsing fails, just use the full name
		originalName := entry.Name()
		// simple heuristic: if it starts with digits and has underscore
		// 1739..._filename.ext
		if len(entry.Name()) > 11 && entry.Name()[10] == '_' {
			// Assuming timestamp is usually 10 digits (Unix seconds), checking index 10
			// But simple split is safer
			parts := strings.SplitN(entry.Name(), "_", 2)
			if len(parts) == 2 {
				originalName = parts[1]
			}
		}

		files = append(files, FileInfo{
			ID:        entry.Name(), // Use disk filename as ID
			Name:      originalName,
			Size:      info.Size(),
			Url:       "/files/" + entry.Name(),
			CreatedAt: info.ModTime().Unix(),
		})
	}

	json.NewEncoder(w).Encode(files)
}
