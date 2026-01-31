package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
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
