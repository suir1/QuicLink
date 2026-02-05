#!/bin/bash

echo "🚀 Starting QuicLink Deployment..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker could not be found. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "⚠️ docker-compose not found, trying 'docker compose'..."
    if ! docker compose version &> /dev/null; then
        echo "❌ Docker Compose not found."
        exit 1
    fi
    DOCKER_COMPOSE_CMD="docker compose"
else
    DOCKER_COMPOSE_CMD="docker-compose"
fi

# Create uploads directory if not exists
mkdir -p uploads

# Build and Start
echo "📦 Building and starting containers..."
$DOCKER_COMPOSE_CMD up -d --build

# Check status
if [ $? -eq 0 ]; then
    echo "✅ Deployment Successful!"
    echo "🌍 Server running at: http://localhost:8080 (or your VPS IP)"
    echo "📜 Logs:"
    $DOCKER_COMPOSE_CMD logs -f --tail=20
else
    echo "❌ Deployment Failed."
fi
