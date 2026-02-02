package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/quic-go/quic-go/http3"

	"quiclink-server/config"
	"quiclink-server/handlers"
)

func main() {
	// 加载配置
	config.LoadConfig()

	// 检查并生成证书
	certFile := "cert.pem"
	keyFile := "key.pem"
	if _, err := os.Stat(certFile); os.IsNotExist(err) {
		fmt.Println("🔒 Generating self-signed certificate...")
		if err := generateSelfSignedCert(certFile, keyFile); err != nil {
			log.Fatalf("Failed to generate cert: %v", err)
		}
	}

	// 静态文件
	fs := http.FileServer(http.Dir("./dist"))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 告诉浏览器支持 HTTP/3
		w.Header().Add("Alt-Svc", `h3=":8080"; ma=2592000`)
		fs.ServeHTTP(w, r)
	}))
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(handlers.UploadDir))))

	// API
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Alt-Svc", `h3=":8080"; ma=2592000`)
		handlers.HandleWebSocket(w, r)
	})
	http.HandleFunc("/upload", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Alt-Svc", `h3=":8080"; ma=2592000`)
		handlers.HandleUpload(w, r)
	})

	// WebTransport endpoint
	http.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Alt-Svc", `h3=":8080"; ma=2592000`)
		handlers.HandleWebTransport(w, r)
	})

	http.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Add("Alt-Svc", `h3=":8080"; ma=2592000`)
		json.NewEncoder(w).Encode(map[string]string{
			"mode": config.Current.AppMode,
			"proto": r.Proto, // 返回当前协议版本 (HTTP/1.1, HTTP/2, HTTP/3)
		})
	})

	port := "8080"
	fmt.Printf("🚀 Server Running in [%s] mode on https://localhost:%s (HTTP/3 + HTTP/2)\n", config.Current.AppMode, port)

	var wg sync.WaitGroup
	wg.Add(2)

	// 1. 启动 HTTP/3 (UDP)
	go func() {
		defer wg.Done()
		server := http3.Server{
			Addr: ":" + port,
			Handler: nil, // use http.DefaultServeMux
		}
		if err := server.ListenAndServeTLS(certFile, keyFile); err != nil {
			log.Printf("❌ HTTP/3 Server error: %v", err)
		}
	}()

	// 2. 启动 HTTPS (TCP)
	go func() {
		defer wg.Done()
		if err := http.ListenAndServeTLS(":"+port, certFile, keyFile, nil); err != nil {
			log.Printf("❌ HTTPS Server error: %v", err)
		}
	}()

	wg.Wait()
}

// 生成自签名证书
func generateSelfSignedCert(certFile, keyFile string) error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"QuicLink Dev"},
		},
		NotBefore: time.Now(),
		NotAfter:  time.Now().Add(365 * 24 * time.Hour),

		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	// 允许 localhost 和常见局域网 IP
	template.DNSNames = []string{"localhost"}
	template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("0.0.0.0")}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	// 写入 cert.pem
	certOut, err := os.Create(certFile)
	if err != nil {
		return err
	}
	defer certOut.Close()
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes}); err != nil {
		return err
	}

	// 写入 key.pem
	keyOut, err := os.Create(keyFile)
	if err != nil {
		return err
	}
	defer keyOut.Close()
	if err := pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)}); err != nil {
		return err
	}

	return nil
}
