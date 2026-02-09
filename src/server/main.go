package main

import (
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
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"quiclink-server/config"
	"quiclink-server/handlers"
	"quiclink-server/store"

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

// Wrapper to capture status code
type responseWriterWrapper struct {
	http.ResponseWriter
	status int
}

func (w *responseWriterWrapper) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func main() {
	// 加载配置
	config.LoadConfig()

	// 启动房间清理任务 (Public 模式有效)
	store.StartCleanupLoop()

	port := fmt.Sprintf("%d", config.Current.Port)

	// 检查并生成证书 (仅 HTTPS 模式需要)
	certFile := config.Current.CertFile
	keyFile := config.Current.KeyFile
	if config.Current.UseHTTPS {
		// 自动判断：如果证书不存在，则生成自签名证书，并强制启用 Hash
		if _, err := os.Stat(certFile); os.IsNotExist(err) {
			fmt.Println("🔒 Generating self-signed certificate...")
			if err := generateSelfSignedCert(certFile, keyFile); err != nil {
				log.Fatalf("Failed to generate cert: %v", err)
			}
			// 自签名证书必须启用 Hash
			config.Current.ForceCertHash = true
		}

		// 计算证书 Hash (仅在强制启用时)
		if config.Current.ForceCertHash {
			if err := computeCertHash(certFile); err != nil {
				log.Printf("⚠️ Failed to compute cert hash: %v", err)
			}
		} else {
			fmt.Println("🔒 Loaded external certificate (Hash Validation Disabled)")
		}
	}

	// 静态文件
	fs := http.FileServer(http.Dir("./dist"))
	// SPA Handler: Serves index.html for unknown paths
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", `h3=":443"; ma=2592000`)
		}

		path := "./dist" + r.URL.Path
		// Check if file exists, otherwise serve index.html
		if _, err := os.Stat(path); os.IsNotExist(err) {
			http.ServeFile(w, r, "./dist/index.html")
			return
		}
		fs.ServeHTTP(w, r)
	}))
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(handlers.UploadDir))))

	// API
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", `h3=":443"; ma=2592000`)
		}
		handlers.HandleWebSocket(w, r)
	})
	http.HandleFunc("/upload", func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", `h3=":443"; ma=2592000`)
		}
		handlers.HandleUpload(w, r)
	})
	http.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", `h3=":443"; ma=2592000`)
		}
		handlers.HandleListFiles(w, r)
	})

	// WebTransport endpoint (仅 HTTPS 模式)
	http.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		if !config.Current.UseHTTPS {
			http.Error(w, "WebTransport requires HTTPS mode", http.StatusBadRequest)
			return
		}
		w.Header().Add("Alt-Svc", `h3=":443"; ma=2592000`)
		handlers.HandleWebTransport(w, r)
	})

	http.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		if config.Current.UseHTTPS {
			// Advertise external port 443 for HTTP/3, not internal port 3100
			w.Header().Add("Alt-Svc", `h3=":443"; ma=2592000`)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"mode":     config.Current.AppMode,
			"proto":    r.Proto,
			"https":    config.Current.UseHTTPS,
			"certHash": CertHash,
		})
	})

	// HTTP 模式 (无 TLS)
	if !config.Current.UseHTTPS {
		fmt.Printf("🚀 Server Running in [%s] mode on http://localhost:%s (HTTP only)\n", config.Current.AppMode, port)
		if err := http.ListenAndServe(":"+port, nil); err != nil {
			log.Fatalf("❌ HTTP Server error: %v", err)
		}
		return
	}

	// HTTPS 模式 (TLS + HTTP/3)
	fmt.Printf("🚀 Server Running in [%s] mode on https://localhost:%s (HTTP/3 + HTTP/2)\n", config.Current.AppMode, port)

	var wg sync.WaitGroup
	wg.Add(2)

	// 加载 TLS 证书
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		log.Fatalf("❌ Failed to load TLS cert: %v", err)
	}

	// 配置 TLS，必须设置 NextProtos 为 "h3" 以支持 HTTP/3 ALPN 协商
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{"h3"}, // 关键：告诉客户端我们支持 HTTP/3
	}

	// 1. 初始化 WebTransport Server
	// Wrap DefaultServeMux with logging
	// 注意：对于 WebTransport CONNECT 请求，不能使用 wrapper，因为 http3.Settingser 接口需要原始 ResponseWriter
	loggingHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("🔍 [%s] Request: %s %s from %s", r.Proto, r.Method, r.URL.Path, r.RemoteAddr)

		// 对于 WebTransport CONNECT 请求，直接使用原始 ResponseWriter
		// 因为 webtransport.Server.Upgrade() 需要类型断言到 http3.Settingser
		if r.Method == http.MethodConnect && r.URL.Path == "/wt" {
			http.DefaultServeMux.ServeHTTP(w, r)
			log.Printf("🔍 [%s] Response: WebTransport for %s %s", r.Proto, r.Method, r.URL.Path)
			return
		}

		// 其他请求使用 wrapper 来记录状态码
		rw := &responseWriterWrapper{ResponseWriter: w, status: 200}
		http.DefaultServeMux.ServeHTTP(rw, r)
		log.Printf("🔍 [%s] Response: %d for %s %s", r.Proto, rw.status, r.Method, r.URL.Path)
	})

	// 初始化 HTTP/3 Server
	// 注意：webtransport.ConfigureHTTP3Server 会设置 AdditionalSettings 和 EnableDatagrams
	// 所以我们先创建基础配置，再调用它来配置 WebTransport 支持
	h3Server := &http3.Server{
		Addr:      ":" + port,
		Handler:   loggingHandler,
		TLSConfig: tlsConfig,
	}

	// 关键！使用 webtransport.ConfigureHTTP3Server 来正确配置 HTTP/3 服务器
	// 这个函数会：
	// 1. 设置 AdditionalSettings[settingsEnableWebtransport] = 1 (HTTP/3 层支持 WebTransport)
	// 2. 设置 EnableDatagrams = true (支持 HTTP/3 Datagrams)
	// 3. 设置 ConnContext 回调，在每个连接的 context 中注入 QUIC 连接
	webtransport.ConfigureHTTP3Server(h3Server)

	log.Printf("🔧 HTTP/3 Server configured: EnableDatagrams=%v, AdditionalSettings=%v",
		h3Server.EnableDatagrams, h3Server.AdditionalSettings)

	handlers.WTServer = &webtransport.Server{
		H3: h3Server,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	// 2. 启动 HTTP/3 (UDP)
	go func() {
		defer wg.Done()
		log.Printf("🔊 Starting HTTP/3 (QUIC) server on UDP :%s...", port)
		// 使用 webtransport-go 的 ListenAndServeTLS，让它处理必要的握手细节
		// 但我们提前配置了 settings，希望能被正确合并/使用
		if err := handlers.WTServer.ListenAndServeTLS(certFile, keyFile); err != nil {
			log.Printf("❌ HTTP/3 Server error: %v", err)
		}
	}()

	// 3. 启动 HTTPS (TCP)
	go func() {
		defer wg.Done()
		if err := http.ListenAndServeTLS(":"+port, certFile, keyFile, nil); err != nil {
			log.Printf("❌ HTTPS Server error: %v", err)
		}
	}()

	// 4. 启动 HTTP -> HTTPS 重定向服务 (端口 3101)
	// 用户需在 Docker 中映射 80:3101
	go func() {
		redirectPort := "3101"
		fmt.Printf("🔀 Redirect Server running on :%s (HTTP -> HTTPS)\n", redirectPort)
		http.ListenAndServe(":"+redirectPort, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			target := "https://" + r.Host + r.URL.Path
			if len(r.URL.RawQuery) > 0 {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusMovedPermanently)
		}))
	}()

	wg.Wait()
}

// 生成自签名证书 (ECDSA P-256, 用于 WebTransport serverCertificateHashes)
func generateSelfSignedCert(certFile, keyFile string) error {
	// WebTransport 要求：必须使用 ECDSA P-256，不能用 RSA
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"QuicLink Dev"},
		},
		NotBefore: time.Now(),
		NotAfter:  time.Now().Add(10 * 24 * time.Hour), // 浏览器限制：自签名证书搭配 Hash 校验有效期不能超过 14 天

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

	// 写入 key.pem (ECDSA 格式)
	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}
	keyOut, err := os.Create(keyFile)
	if err != nil {
		return err
	}
	defer keyOut.Close()
	if err := pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes}); err != nil {
		return err
	}

	return nil
}

// 计算证书指纹 (SHA-256)
func computeCertHash(certFile string) error {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return err
	}

	block, _ := pem.Decode(certPEM)
	if block == nil {
		return fmt.Errorf("failed to parse certificate PEM")
	}

	hash := sha256.Sum256(block.Bytes)
	CertHash = base64.StdEncoding.EncodeToString(hash[:])
	fmt.Printf("🔒 Certificate Hash: %s\n", CertHash)
	return nil
}

var CertHash string
