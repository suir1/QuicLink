# Makefile for QuicLink Project

# Configuration
# Usage: make deploy-vps VPS_HOST=<ip>
VPS_HOST ?= 64.186.238.105
VPS_USER ?= root
VPS_DIR ?= /root/quiclink
VPS_KEY ?= ~/.ssh/id_rsa.pem

# Paths
SERVER_SRC := src/server
WEB_SRC := src/web
DESKTOP_SRC := src/desktop

# Binary names
SERVER_BIN := quiclink-server
DESKTOP_APP_NAME := QuicLink.app
DESKTOP_BUILD_NAME := desktop.app

.PHONY: all help deploy-vps build-server build-web build-desktop clean

help:
	@echo "Available commands:"
	@echo "  make deploy-vps VPS_HOST=<ip>  - Build server(linux) & web, then rsync to VPS /root"
	@echo "  make start-vps                 - Start remote server (background)"
	@echo "  make stop-vps                  - Stop remote server"
	@echo "  make build-desktop             - Build desktop app and move to ~/Downloads"
	@echo "  make clean                     - Clean build artifacts"

# ==========================================
# VPS Deployment
# ==========================================

deploy-vps: build-server build-web rsync-vps

build-server:
	@echo "🚧 Building Server for Linux (amd64)..."
	cd $(SERVER_SRC) && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../../bin/$(SERVER_BIN) .
	@echo "✅ Server build complete."

build-web:
	@echo "🚧 Building Web Frontend..."
	cd $(WEB_SRC) && npm install && npm run build
	@echo "✅ Web build complete."

rsync-vps:
	@echo "🚀 Deploying to VPS ($(VPS_HOST))..."
	# Ensure remote directory exists
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "mkdir -p $(VPS_DIR)/dist $(VPS_DIR)/uploads"
	# Rsync server binary
	rsync -avz --progress -e "ssh -i $(VPS_KEY)" bin/$(SERVER_BIN) $(VPS_USER)@$(VPS_HOST):$(VPS_DIR)/
	# Apply setcap to allow binding to privileged ports (e.g. 443)
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "setcap cap_net_bind_service=+ep $(VPS_DIR)/$(SERVER_BIN)"
	# Rsync start script
	rsync -avz --progress -e "ssh -i $(VPS_KEY)" scripts/start_vps.sh $(VPS_USER)@$(VPS_HOST):$(VPS_DIR)/
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "chmod +x $(VPS_DIR)/start_vps.sh"
	# Rsync web dist files
	rsync -avz --progress -e "ssh -i $(VPS_KEY)" $(WEB_SRC)/dist/ $(VPS_USER)@$(VPS_HOST):$(VPS_DIR)/dist/
	# Copy server config example if config.json doesn't exist remotely (optional safety)
	# rsync -avz --ignore-existing -e "ssh -i $(VPS_KEY)" $(SERVER_SRC)/config.example.json $(VPS_USER)@$(VPS_HOST):$(VPS_DIR)/config.json
	@echo "✅ Deployment complete!"

start-vps:
	@echo "🚀 Starting remote server..."
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "$(VPS_DIR)/start_vps.sh"

stop-vps:
	@echo "🛑 Stopping remote server..."
	ssh -i $(VPS_KEY) $(VPS_USER)@$(VPS_HOST) "pkill -f $(SERVER_BIN) || echo '⚠️ No running process found.'"

# ==========================================
# Desktop Build
# ==========================================

build-desktop:
	@echo "🚧 Building Desktop App (macOS)..."
	cd $(DESKTOP_SRC) && wails build -platform darwin/universal
	@echo "📦 Moving to ~/Downloads..."
	rm -rf ~/Downloads/$(DESKTOP_APP_NAME)
	# Wails output is commonly in build/bin
	mv $(DESKTOP_SRC)/build/bin/$(DESKTOP_BUILD_NAME) ~/Downloads/$(DESKTOP_APP_NAME)
	@echo "✅ Desktop app is ready at ~/Downloads/$(DESKTOP_APP_NAME)"

clean:
	rm -rf bin/$(SERVER_BIN)
	rm -rf $(WEB_SRC)/dist
	rm -rf $(DESKTOP_SRC)/build/bin
