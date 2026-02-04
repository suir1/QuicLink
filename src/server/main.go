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

	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

func main() {
	// 加载配置
	config.LoadConfig()

	port := fmt.Sprintf("%d", config.Current.Port)

	// 检查并生成证书 (仅 HTTPS 模式需要)
	certFile := "cert.pem"
	keyFile := "key.pem"
	if config.Current.UseHTTPS {
		if _, err := os.Stat(certFile); os.IsNotExist(err) {
			fmt.Println("🔒 Generating self-signed certificate...")
			if err := generateSelfSignedCert(certFile, keyFile); err != nil {
				log.Fatalf("Failed to generate cert: %v", err)
			}
		}

		// 计算证书 Hash
		if err := computeCertHash(certFile); err != nil {
			log.Printf("⚠️ Failed to compute cert hash: %v", err)
		}
	}

	// 静态文件
	fs := http.FileServer(http.Dir("./dist"))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", fmt.Sprintf(`h3=":%s"; ma=2592000`, port))
		}
		fs.ServeHTTP(w, r)
	}))
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir(handlers.UploadDir))))

	// API
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", fmt.Sprintf(`h3=":%s"; ma=2592000`, port))
		}
		handlers.HandleWebSocket(w, r)
	})
	http.HandleFunc("/upload", func(w http.ResponseWriter, r *http.Request) {
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", fmt.Sprintf(`h3=":%s"; ma=2592000`, port))
		}
		handlers.HandleUpload(w, r)
	})

	// WebTransport endpoint (仅 HTTPS 模式)
	http.HandleFunc("/wt", func(w http.ResponseWriter, r *http.Request) {
		if !config.Current.UseHTTPS {
			http.Error(w, "WebTransport requires HTTPS mode", http.StatusBadRequest)
			return
		}
		w.Header().Add("Alt-Svc", fmt.Sprintf(`h3=":%s"; ma=2592000`, port))
		handlers.HandleWebTransport(w, r)
	})

	http.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		if config.Current.UseHTTPS {
			w.Header().Add("Alt-Svc", fmt.Sprintf(`h3=":%s"; ma=2592000`, port))
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
	handlers.WTServer = &webtransport.Server{
		H3: &http3.Server{
			Addr:            ":" + port,
			Handler:         http.DefaultServeMux,
			TLSConfig:       tlsConfig,
			EnableDatagrams: true,
		},
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	// 2. 启动 HTTP/3 (UDP)
	go func() {
		defer wg.Done()
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
