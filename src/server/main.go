package main

import (
	"fmt"
	"log"
	"net/http"

	"quiclink-server/handlers"
)

func main() {
	// 1. 静态文件服务 (Vue 前端页面)
	// 生产环境时，把 vue build 出来的 dist 目录放在 ./dist
	http.Handle("/", http.FileServer(http.Dir("./dist")))

	// 2. 文件下载服务
	// 访问 /files/xxx.jpg -> 读取 ./uploads/xxx.jpg
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(handlers.UploadDir))))

	// 3. API 路由
	http.HandleFunc("/ws", handlers.HandleWebSocket)
	http.HandleFunc("/upload", handlers.HandleUpload)

	// 4. 启动服务器
	port := "8080"
	fmt.Printf(`
🚀 QuicLink Server Running!
----------------------------------
📡 WebSocket: ws://localhost:%s/ws
🌍 Web UI:    http://localhost:%s/
📂 Uploads:   ./uploads
----------------------------------
`, port, port)

	err := http.ListenAndServe(":"+port, nil)
	if err != nil {
		log.Fatal("Server Error: ", err)
	}
}
