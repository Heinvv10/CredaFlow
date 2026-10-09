"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react"
import { Toaster } from "sonner"
import {
  applyTheme,
  DEFAULT_THEME,
  isTheme,
  type Theme,
  writeStoredTheme,
} from "@/lib/theme"

const THEME_CHANGE_EVENT = "lms-theme-change"

type ThemeContextValue = {
  theme: Theme
  setTheme(theme: Theme): void
  toggleTheme(): void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function subscribe(onStoreChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange)
  return () => window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange)
}

function getThemeSnapshot(): Theme {
  const value = document.documentElement.dataset.theme
  return isTheme(value) ? value : DEFAULT_THEME
}

function getServerThemeSnapshot(): Theme {
  return DEFAULT_THEME
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(
    subscribe,
    getThemeSnapshot,
    getServerThemeSnapshot,
  )

  const setTheme = useCallback((nextTheme: Theme) => {
    applyTheme(document.documentElement, nextTheme)
    writeStoredTheme(window.localStorage, nextTheme)
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark")
  }, [setTheme, theme])

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [setTheme, theme, toggleTheme],
  )

  return (
    <ThemeContext.Provider value={value}>
      {children}
      <Toaster theme={theme} richColors closeButton />
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
