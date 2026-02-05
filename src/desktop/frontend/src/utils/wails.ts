/**
 * Wails Integration Utility
 * Provides type-safe access to Go backend methods when running in Wails desktop app.
 */

// Check if running in Wails environment
export const isWails = (): boolean => {
    return typeof window !== 'undefined' && 'go' in window
}

// Type definitions for Wails runtime
declare global {
    interface Window {
        go: {
            main: {
                App: {
                    // Clipboard methods
                    GetClipboard(): Promise<string>
                    SetClipboard(text: string): Promise<void>
                    SendClipboard(): Promise<void>

                    // WebSocket Signaling
                    Connect(host: string, roomID: string, password?: string): Promise<void>
                    Disconnect(): Promise<void>
                    GetConnectionStatus(): Promise<boolean>
                    SendGenericMessage(msgType: string, payload: Record<string, unknown>): Promise<void>

                    // P2P WebTransport
                    ConnectP2P(host: string, roomID: string): Promise<void>
                    DisconnectP2P(): Promise<void>
                    GetP2PStatus(): Promise<boolean>
                    ShareFileP2P(id: string, name: string, size: number, mimeType: string): Promise<void>
                    SendP2PHello(): Promise<void>

                    // Utility
                    Greet(name: string): Promise<string>
                }
            }
        }
        runtime: {
            EventsOn(eventName: string, callback: (...args: unknown[]) => void): () => void
            EventsOff(eventName: string): void
            EventsEmit(eventName: string, ...args: unknown[]): void
        }
    }
}

// Wails API wrapper with type safety
export const wails = {
    // Clipboard
    async getClipboard(): Promise<string> {
        if (!isWails()) return ''
        return window.go.main.App.GetClipboard()
    },

    async setClipboard(text: string): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.SetClipboard(text)
    },

    async sendClipboard(): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.SendClipboard()
    },

    // Signaling (WebSocket)
    async connect(host: string, roomID: string, password?: string): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.Connect(host, roomID, password || '') // Go bindings likely expect string for now, will verify main.go
    },

    async disconnect(): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.Disconnect()
    },

    async getConnectionStatus(): Promise<boolean> {
        if (!isWails()) return false
        return window.go.main.App.GetConnectionStatus()
    },

    async sendGenericMessage(msgType: string, payload: Record<string, unknown>): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.SendGenericMessage(msgType, payload)
    },

    // P2P (WebTransport)
    async connectP2P(host: string, roomID: string): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.ConnectP2P(host, roomID)
    },

    async disconnectP2P(): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.DisconnectP2P()
    },

    async getP2PStatus(): Promise<boolean> {
        if (!isWails()) return false
        return window.go.main.App.GetP2PStatus()
    },

    async shareFileP2P(id: string, name: string, size: number, mimeType: string): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.ShareFileP2P(id, name, size, mimeType)
    },

    async sendP2PHello(): Promise<void> {
        if (!isWails()) return
        return window.go.main.App.SendP2PHello()
    },

    // Events
    on(eventName: string, callback: (...args: unknown[]) => void): () => void {
        if (!isWails()) return () => { }
        return window.runtime.EventsOn(eventName, callback)
    },

    off(eventName: string): void {
        if (!isWails()) return
        window.runtime.EventsOff(eventName)
    },

    emit(eventName: string, ...args: unknown[]): void {
        if (!isWails()) return
        window.runtime.EventsEmit(eventName, ...args)
    }
}

export default wails
