export interface QuicLinkNativePlugin {
  startLanHost(): Promise<{ started: boolean }>
  stopLanHost(): Promise<{ stopped: boolean }>
  getLanHostStatus(): Promise<{ running: boolean }>
}
