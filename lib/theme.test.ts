import { describe, expect, it, vi } from "vitest"
import {
  applyTheme,
  readStoredTheme,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  writeStoredTheme,
} from "./theme"

function rootStub() {
  return {
    dataset: {} as Record<string, string>,
    classList: {
      toggle: vi.fn(),
    },
    style: {
      colorScheme: "",
    },
  }
}

describe("theme preference", () => {
  it("accepts only an explicit light or dark preference", () => {
    const storage = {
      getItem: vi.fn()
        .mockReturnValueOnce("light")
        .mockReturnValueOnce("dark")
        .mockReturnValueOnce("sepia")
        .mockReturnValueOnce(null),
    }

    expect(readStoredTheme(storage)).toBe("light")
    expect(readStoredTheme(storage)).toBe("dark")
    expect(readStoredTheme(storage)).toBe("dark")
    expect(readStoredTheme(storage)).toBe("dark")
    expect(storage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY)
  })

  it("falls back to dark if browser storage is unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked")
      }),
    }

    expect(readStoredTheme(storage)).toBe("dark")
  })

  it("applies the theme to the root colour scheme and Tailwind class", () => {
    const root = rootStub()

    applyTheme(root, "light")
    expect(root.dataset.theme).toBe("light")
    expect(root.style.colorScheme).toBe("light")
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", false)

    applyTheme(root, "dark")
    expect(root.dataset.theme).toBe("dark")
    expect(root.style.colorScheme).toBe("dark")
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true)
  })

  it("persists a valid preference without failing when storage is blocked", () => {
    const storage = { setItem: vi.fn() }
    writeStoredTheme(storage, "light")
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light")

    expect(() => writeStoredTheme({
      setItem: () => {
        throw new Error("blocked")
      },
    }, "dark")).not.toThrow()
  })

  it("applies a saved preference before the client bundle hydrates", () => {
    const root = rootStub()
    const runInitScript = new Function(
      "document",
      "localStorage",
      THEME_INIT_SCRIPT,
    )

    runInitScript(
      { documentElement: root },
      { getItem: () => "light" },
    )

    expect(root.dataset.theme).toBe("light")
    expect(root.style.colorScheme).toBe("light")
    expect(root.classList.toggle).toHaveBeenCalledWith("dark", false)
  })
})
