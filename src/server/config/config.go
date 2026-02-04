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
		Current.Port = 8080
	}

	protocol := "HTTP"
	if Current.UseHTTPS {
		protocol = "HTTPS"
	}
	log.Printf("⚙️  Loaded Config | Mode: %s | %s | Port: %d | Upload: %dMB",
		Current.AppMode, protocol, Current.Port, Current.Limits.MaxUploadSizeMB)
}

func createDefaultConfig() {
	defaultCfg := Config{
		AppMode:  "public",
		UseHTTPS: true, // 默认启用 HTTPS
		Port:     8080,
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
