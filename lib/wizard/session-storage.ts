export interface WizardStore<T> {
  load(): T | null
  save(data: T): void
  clear(): void
}

export function sessionWizardStore<T>(key: string): WizardStore<T> {
  const safeSession = (): Storage | null => {
    try {
      // Works in both browser (window.sessionStorage) and test environments
      // where sessionStorage is stubbed on globalThis via vi.stubGlobal.
      // Returns null in SSR (globalThis.sessionStorage is undefined).
      const s = globalThis.sessionStorage
      return s ?? null
    } catch {
      return null
    }
  }

  return {
    load() {
      const s = safeSession()
      if (!s) return null
      const raw = s.getItem(key)
      if (raw == null) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        return null
      }
    },
    save(data) {
      const s = safeSession()
      if (!s) return
      s.setItem(key, JSON.stringify(data))
    },
    clear() {
      const s = safeSession()
      if (!s) return
      s.removeItem(key)
    },
  }
}
