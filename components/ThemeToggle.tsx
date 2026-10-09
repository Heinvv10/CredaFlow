"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "@/components/ThemeProvider"
import { cn } from "@/lib/utils"

type ThemeToggleProps = {
  className?: string
  showLabel?: boolean
}

export function ThemeToggle({ className, showLabel = false }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme()
  const targetTheme = theme === "dark" ? "light" : "dark"
  const label = `Switch to ${targetTheme} mode`

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-2.5 text-[var(--cf-text-secondary)] transition-colors hover:bg-[var(--cf-bg-raised)] hover:text-[var(--cf-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cf-bg)]",
        className,
      )}
      aria-label={label}
      aria-pressed={theme === "light"}
      title={label}
    >
      {theme === "dark"
        ? <Sun className="h-4 w-4" aria-hidden="true" />
        : <Moon className="h-4 w-4" aria-hidden="true" />}
      {showLabel && (
        <span className="text-xs font-medium capitalize">{targetTheme}</span>
      )}
    </button>
  )
}
