import { useSyncExternalStore } from 'react'
import type { Locale } from './i18n.ts'

/** The slice of the host's locale runtime this plugin needs. */
interface LocaleSource {
  getLocale(): { active: string }
  subscribe(onChange: () => void): () => void
}

let source: LocaleSource | undefined

/** Called once from `apply`; the card reads through the hook below. */
export function bindLocale(runtime: LocaleSource): void {
  source = runtime
}

/** Stable identity, as `useSyncExternalStore` requires. */
function subscribe(onChange: () => void): () => void {
  return source?.subscribe(onChange) ?? (() => {})
}

/**
 * Returns a primitive, so the store comparison is by value — returning a fresh
 * object here would re-render forever.
 */
function snapshot(): Locale {
  return source?.getLocale().active === 'zh' ? 'zh' : 'en'
}

/** Active locale, re-rendering the caller when the host switches language. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
