import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.quiclink.app',
  appName: 'QuicLink',
  webDir: '../web/dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https'
  }
}

export default config
