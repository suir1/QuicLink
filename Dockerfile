# Stage 1: Build Web Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/web
COPY src/web/package*.json ./
RUN npm install
COPY src/web/ .
# Remove local .env file to prevent baking in VITE_VPS_HOST
RUN rm -f .env
RUN npm run build

# Stage 2: Build Go Backend
FROM golang:1.24-alpine AS backend-builder
WORKDIR /app/server
COPY src/server/go.mod src/server/go.sum ./
# Install git for fetching private modules (common issue) and set Proxy
RUN apk add --no-cache git
ENV GOPROXY=https://goproxy.io,direct
RUN go mod download
COPY src/server/ .
RUN CGO_ENABLED=0 GOOS=linux go build -o quiclink-server .

# Stage 3: Runtime
FROM alpine:latest
WORKDIR /app

# Install certificates for HTTPS/WebTransport
RUN apk --no-cache add ca-certificates tzdata

# Copy binary from backend builder
COPY --from=backend-builder /app/server/quiclink-server .

# Copy static files from frontend builder
# Server looks for "./dist" by default (see main.go)
COPY --from=frontend-builder /app/web/dist ./dist

# Copy default config (will be overridden by volume)
COPY src/server/config.example.json ./config.json

# Create uploads directory
RUN mkdir uploads

# Expose ports
# Expose ports
EXPOSE 3100
EXPOSE 3101
EXPOSE 443

# Run
CMD ["./quiclink-server"]
