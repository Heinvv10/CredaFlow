"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}

/**
 * False on the server and during hydration, true on every client render after
 * it. Gate anything read from the browser (localStorage, window.location, the
 * clock) on it so the first client render matches the server's HTML.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false)
}
