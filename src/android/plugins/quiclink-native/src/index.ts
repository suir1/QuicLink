import { registerPlugin } from '@capacitor/core'

import type { QuicLinkNativePlugin } from './definitions'

const QuicLinkNative = registerPlugin<QuicLinkNativePlugin>('QuicLinkNative')

export * from './definitions'
export { QuicLinkNative }
