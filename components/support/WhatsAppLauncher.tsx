"use client"

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react"
import { MessageCircle, X } from "lucide-react"

import { trackEvent } from "@/lib/analytics/events"
import { waHref, type SupportIntent } from "@/lib/support/whatsapp-intents"
import { cn } from "@/lib/utils"

type WhatsAppLauncherProps = {
  intents: readonly SupportIntent[]
  /** The lender's `publicWhatsappE164`. Null: no WhatsApp entries are shown. */
  whatsappE164: string | null
  /** Positioning override. The portal passes a larger bottom offset to clear
   *  its mobile bottom nav (PortalSidebar.tsx:91, h-16 at z-50). */
  className?: string
  /** Optional first menu item that opens the on-site chat instead of WhatsApp. */
  chatAction?: { label: string; onSelect: () => void }
}

export function WhatsAppLauncher({ intents: allIntents, whatsappE164, className, chatAction }: WhatsAppLauncherProps) {
  const intents = whatsappE164
    ? allIntents.map((intent) => ({ ...intent, href: waHref(whatsappE164, intent.message) }))
    : []
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([])
  const offset = chatAction ? 1 : 0
  const itemCount = intents.length + offset

  // Roving tabindex (WAI-ARIA menu pattern): focus follows `activeIndex`
  // onto the active item itself, not the panel container. Optional-chained:
  // react-test-renderer has no host instances and returns null here.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  function toggle() {
    // `open` is the value captured by this handler's closure, so it is stale
    // the moment state changes. The next value is computed once and used for
    // both the state update and the analytics call, so the two cannot disagree.
    const next = !open
    setOpen(next)
    if (next) {
      setActiveIndex(0)
      trackEvent("support", "whatsapp_launcher_open")
    }
  }

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function moveActive(next: number) {
    setActiveIndex(((next % itemCount) + itemCount) % itemCount)
  }

  function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        moveActive(activeIndex + 1)
        break
      case "ArrowUp":
        event.preventDefault()
        moveActive(activeIndex - 1)
        break
      case "Home":
        event.preventDefault()
        setActiveIndex(0)
        break
      case "End":
        event.preventDefault()
        setActiveIndex(itemCount - 1)
        break
      case "Escape":
        close()
        break
      case "Tab":
        // Let the browser's own Tab handling move focus onward — the menu
        // just closes, it doesn't steal focus back to the trigger.
        setOpen(false)
        break
    }
  }

  // Nothing to offer: no WhatsApp number and no on-site chat.
  if (itemCount === 0) return null

  return (
    <div
      data-testid="whatsapp-launcher"
      className={cn(
        "fixed right-4 bottom-6 z-40 flex flex-col items-end gap-3 print:hidden",
        className,
      )}
    >
      {open && (
        <div
          id={panelId}
          role="menu"
          aria-label={chatAction ? "Chat to us" : "Chat to us on WhatsApp"}
          onKeyDown={handlePanelKeyDown}
          className="w-64 overflow-hidden rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] shadow-xl backdrop-blur"
        >
          {/* role="presentation": the only children `role="menu"` accepts are
              menuitem/group/separator, so this heading must not be exposed. */}
          <p
            role="presentation"
            className="border-b border-[var(--cf-border-subtle)] px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]"
          >
            Chat to us
          </p>
          {chatAction && (
            <button
              type="button"
              ref={(el) => { itemRefs.current[0] = el }}
              role="menuitem"
              tabIndex={activeIndex === 0 ? 0 : -1}
              onClick={() => { trackEvent("support", "website_chat_open"); chatAction.onSelect(); setOpen(false) }}
              className="block w-full border-b border-[var(--cf-border-subtle)] px-4 py-3 text-left text-sm font-semibold text-[var(--cf-brand)] transition-colors hover:bg-[var(--cf-surface-hover)]"
            >
              {chatAction.label}
            </button>
          )}
          {intents.map((intent, index) => (
            <a
              key={intent.id}
              ref={(el) => {
                itemRefs.current[index + offset] = el
              }}
              role="menuitem"
              tabIndex={index + offset === activeIndex ? 0 : -1}
              href={intent.href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => {
                trackEvent("support", "whatsapp_intent", intent.id)
                close()
              }}
              className="block border-b border-[var(--cf-border-subtle)] px-4 py-3 text-sm text-[var(--cf-text-secondary)] transition-colors last:border-b-0 hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text)]"
            >
              {intent.label}
            </a>
          ))}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        // Only while open: the panel is unmounted when closed, so a permanent
        // aria-controls would point at an IDREF that resolves to nothing.
        aria-controls={open ? panelId : undefined}
        className="flex items-center gap-2 rounded-full bg-[var(--cf-brand)] px-4 py-3 text-sm font-semibold text-[var(--cf-on-brand)] shadow-lg transition-transform hover:scale-105 hover:bg-[var(--cf-brand-alt)]"
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
        {open ? "Close" : chatAction ? "Chat to us" : "WhatsApp"}
      </button>
    </div>
  )
}
