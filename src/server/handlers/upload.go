package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const UploadDir = "./uploads"

func HandleUpload(w http.ResponseWriter, r *http.Request) {
	// 1. 限制上传大小 200MB
	r.ParseMultipartForm(200 << 20)

	// 2. 获取文件
	file, handler, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Invalid file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// 3. 准备目录
	os.MkdirAll(UploadDir, os.ModePerm)

	// 4. 生成唯一文件名 (时间戳_原名)
	filename := filepath.Base(handler.Filename)
	safeName := fmt.Sprintf("%d_%s", time.Now().Unix(), filename)
	dstPath := filepath.Join(UploadDir, safeName)

	// 5. 写入磁盘
	dst, err := os.Create(dstPath)
	if err != nil {
		http.Error(w, "Save failed", http.StatusInternalServerError)
		return
	}
	defer dst.Close()
	io.Copy(dst, file)

	// 6. 返回 JSON
	w.Header().Set("Content-Type", "application/json")
	// 允许跨域
	w.Header().Set("Access-Control-Allow-Origin", "*")

	json.NewEncoder(w).Encode(map[string]string{
		"status": "success",
		"url":    "/files/" + safeName,
		"name":   filename,
	})
}
