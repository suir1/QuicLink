package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"quiclink-server/config" // 引入配置
	"quiclink-server/handlers"
)

func main() {
	// 1. 加载配置
	config.LoadConfig()

	// 2. 静态文件
	http.Handle("/", http.FileServer(http.Dir("./dist")))
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(handlers.UploadDir))))

	// 3. API
	http.HandleFunc("/ws", handlers.HandleWebSocket)
	http.HandleFunc("/upload", handlers.HandleUpload)

	// 新增：前端查询当前模式
	http.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"mode": config.Current.AppMode,
		})
	})

	// 4. 启动
	port := "8080"
	fmt.Printf("🚀 Server Running in [%s] mode on port %s\n", config.Current.AppMode, port)
	err := http.ListenAndServe(":"+port, nil)
	if err != nil {
		log.Fatal(err)
	}
}
