package config

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
)

// AppConfig holds the application configuration
type AppConfig struct {
	DownloadDir string `json:"downloadDir"`
}

var (
	configDir  string
	configFile string
	Current    *AppConfig
)

func init() {
	userConfig, err := os.UserConfigDir()
	if err != nil {
		log.Printf("❌ Failed to get user config dir: %v", err)
		userConfig = os.TempDir()
	}
	configDir = filepath.Join(userConfig, "QuicLink")
	configFile = filepath.Join(configDir, "config.json")

	// Ensure config dir exists
	os.MkdirAll(configDir, 0755)

	// Default config
	home, _ := os.UserHomeDir()
	defaultDownloadDir := filepath.Join(home, "Downloads", "QuicLink")

	Current = &AppConfig{
		DownloadDir: defaultDownloadDir,
	}
}

// LoadConfig loads the configuration from disk
func LoadConfig() {
	data, err := os.ReadFile(configFile)
	if err != nil {
		log.Printf("⚠️ Config file not found, using defaults")
		return // Use defaults
	}

	if err := json.Unmarshal(data, Current); err != nil {
		log.Printf("❌ Failed to parse config: %v", err)
	} else {
		log.Printf("⚙️ Loaded Config: DownloadDir=%s", Current.DownloadDir)
	}

	// Ensure download dir exists
	os.MkdirAll(Current.DownloadDir, 0755)
}

// SaveConfig saves the configuration to disk
func SaveConfig() error {
	data, err := json.MarshalIndent(Current, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configFile, data, 0644)
}

// SetDownloadDir updates the download directory and saves config
func SetDownloadDir(path string) error {
	Current.DownloadDir = path
	return SaveConfig()
}
