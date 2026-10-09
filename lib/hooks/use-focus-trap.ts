"use client"

import { useEffect, useRef, type RefObject } from "react"

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Traps Tab focus inside the returned ref while it's mounted.
 * Tab/Shift+Tab cycle within the container; Escape calls onEscape.
 * Focus moves to the first focusable element on mount and restores
 * to the previously-focused element on unmount.
 *
 * onEscape may be an inline arrow — it's stored in a ref so changes
 * don't retrigger the setup effect (which would steal focus on every
 * parent re-render).
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  onEscape?: () => void,
): RefObject<T | null> {
  const ref = useRef<T>(null)
  const onEscapeRef = useRef(onEscape)

  useEffect(() => {
    onEscapeRef.current = onEscape
  })

  useEffect(() => {
    const container = ref.current
    if (!container) return

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hidden && el.getClientRects().length > 0,
      )

    const previouslyFocused = document.activeElement as HTMLElement | null
    focusables()[0]?.focus()

    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onEscapeRef.current?.()
        return
      }
      if (e.key !== "Tab") return
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const current = document.activeElement as HTMLElement | null
      if (e.shiftKey && current === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && current === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", handler)
    return () => {
      document.removeEventListener("keydown", handler)
      previouslyFocused?.focus?.()
    }
    // Setup must run once: re-running tears the trap down and resteals focus
    // on every parent re-render. onEscape is read via a ref instead.
  }, [])

  return ref
}
