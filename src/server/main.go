package main

import (
	"fmt"
	"log"
	"net/http"

	"quiclink-server/handlers"
)

func main() {

	http.Handle("/", http.FileServer(http.Dir("./dist")))

	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(handlers.UploadDir))))

	http.HandleFunc("/ws", handlers.HandleWebSocket)
	http.HandleFunc("/upload", handlers.HandleUpload)

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
