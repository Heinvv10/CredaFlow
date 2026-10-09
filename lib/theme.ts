export type Theme = "light" | "dark"

export const DEFAULT_THEME: Theme = "dark"
export const THEME_STORAGE_KEY = "lms-theme"

type StorageReader = {
  getItem(key: string): string | null
}

type StorageWriter = {
  setItem(key: string, value: string): void
}

type ThemeRoot = {
  dataset: Record<string, string> | DOMStringMap
  classList: Pick<DOMTokenList, "toggle">
  style: Pick<CSSStyleDeclaration, "colorScheme">
}

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark"
}

export function readStoredTheme(storage?: StorageReader | null): Theme {
  if (!storage) return DEFAULT_THEME

  try {
    const value = storage.getItem(THEME_STORAGE_KEY)
    return isTheme(value) ? value : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function writeStoredTheme(storage: StorageWriter | null | undefined, theme: Theme) {
  if (!storage) return

  try {
    storage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Browsers can block storage in privacy-restricted contexts. The active
    // page still changes theme; only persistence is unavailable.
  }
}

export function applyTheme(root: ThemeRoot, theme: Theme) {
  root.dataset.theme = theme
  root.classList.toggle("dark", theme === "dark")
  root.style.colorScheme = theme
}

// Runs before React hydrates so a saved light preference never flashes the
// server-default dark palette. Keep this dependency-free: it executes in the
// document head before the client bundle is available.
export const THEME_INIT_SCRIPT = `(()=>{const r=document.documentElement;let t="${DEFAULT_THEME}";try{const s=localStorage.getItem("${THEME_STORAGE_KEY}");if(s==="light"||s==="dark")t=s}catch{}r.dataset.theme=t;r.classList.toggle("dark",t==="dark");r.style.colorScheme=t})()`
