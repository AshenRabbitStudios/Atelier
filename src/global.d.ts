import type { AtelierAPI } from '@shared/events'

declare global {
  interface Window {
    atelier: AtelierAPI
  }
}

export {}
