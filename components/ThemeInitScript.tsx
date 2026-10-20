"use client"

import { THEME_INIT_SCRIPT } from "@/lib/theme"

/**
 * The theme init script, in the server HTML only: the browser runs it while
 * parsing <head>, before the client bundle, so a saved light preference never
 * flashes the dark default. On the client this renders nothing: React 19
 * skips the server's extra <head> node when hydrating, and a client render of
 * the root layout (a notFound() response does one) no longer creates an inline
 * <script>, which React warns about and never runs.
 */
export function ThemeInitScript() {
  if (typeof window !== "undefined") return null
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
}
