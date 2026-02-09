package config

import (
	"encoding/json"
	"log"
	"os"
)

type Config struct {
	AppMode       string `json:"app_mode"`       // "public" or "private"
	AdminPassword string `json:"admin_password"` // 私有模式必填
	UseHTTPS      bool   `json:"use_https"`      // 是否使用 HTTPS (默认 true)
	Port          int    `json:"port"`           // 服务端口 (默认 8080)
	RoomTTLHours  int    `json:"room_ttl_hours"` // Public 模式房间存活时间 (默认 48)
	CertFile      string `json:"cert_file"`      // TLS 证书路径 (默认 cert.pem)
	KeyFile       string `json:"key_file"`       // TLS 私钥路径 (默认 key.pem)

	Limits struct {
		MaxUploadSizeMB      int64 `json:"max_upload_size_mb"`
		FileRetentionMinutes int   `json:"file_retention_minutes"`
		AllowP2PRelay        bool  `json:"allow_p2p_relay"`
	} `json:"limits"`
}

var Current *Config

func LoadConfig() {
	file, err := os.Open("config.json")
	if err != nil {
		// 如果没找到配置文件，生成一个默认的
		log.Println("⚠️ config.json not found, creating default...")
		createDefaultConfig()
		file, _ = os.Open("config.json")
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	Current = &Config{}
	err = decoder.Decode(Current)
	if err != nil {
		log.Fatal("❌ Config format error:", err)
	}

	// 安全检查
	if Current.AppMode == "private" && Current.AdminPassword == "" {
		log.Fatal("❌ Private mode requires 'admin_password' in config.json!")
	}

	// 默认值处理
	if Current.Port == 0 {
		Current.Port = 3100
	}
	if Current.RoomTTLHours == 0 {
		Current.RoomTTLHours = 48 // 默认 2 天
	}
	if Current.CertFile == "" {
		Current.CertFile = "cert.pem"
	}
	if Current.KeyFile == "" {
		Current.KeyFile = "key.pem"
	}

	protocol := "HTTP"
	if Current.UseHTTPS {
		protocol = "HTTPS"
	}
	log.Printf("⚙️  Loaded Config | Mode: %s | %s | Port: %d | Upload: %dMB | RoomTTL: %dh",
		Current.AppMode, protocol, Current.Port, Current.Limits.MaxUploadSizeMB, Current.RoomTTLHours)
}

func createDefaultConfig() {
	defaultCfg := Config{
		AppMode:      "public",
		UseHTTPS:     true, // 默认启用 HTTPS
		Port:         3100,
		RoomTTLHours: 48, // 默认 2 天
		CertFile:     "cert.pem",
		KeyFile:      "key.pem",
		Limits: struct {
			MaxUploadSizeMB      int64 `json:"max_upload_size_mb"`
			FileRetentionMinutes int   `json:"file_retention_minutes"`
			AllowP2PRelay        bool  `json:"allow_p2p_relay"`
		}{
			MaxUploadSizeMB:      10,
			FileRetentionMinutes: 10,
			AllowP2PRelay:        false,
		},
	}
	file, _ := os.Create("config.json")
	defer file.Close()
	json.NewEncoder(file).Encode(defaultCfg)
}
