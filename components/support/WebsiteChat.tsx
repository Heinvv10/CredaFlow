"use client"

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { TurnstileWidget } from "@/components/turnstile-widget"
import { useWebsiteChat, whatsAppFallbackText } from "@/components/support/useWebsiteChat"
import { waHref } from "@/lib/support/whatsapp-intents"
import { ChatText } from "@/components/support/ChatText"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { chatConsentText, MAX_CHAT_MESSAGE_CHARS, presenceEvent } from "@/lib/website-chat/constants"

const inputClass =
  "w-full rounded-md border border-[var(--cf-border-subtle)] bg-transparent px-3 py-2 text-sm text-[var(--cf-text)]"
const errorClass = "mt-1 text-xs text-red-500"
const primaryClass =
  "rounded-md bg-[var(--cf-brand)] text-sm font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)] disabled:opacity-60"
const statusClass = "border-t border-[var(--cf-border-subtle)] px-4 py-2 text-xs text-[var(--cf-text-secondary)]"
const lineClass = {
  // The visitor's own words sit in a tinted bubble so they do not read as bare text on the panel.
  // The tint is the border token: a low-alpha wash in both themes, so --cf-text keeps its contrast.
  visitor: "ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-[var(--cf-border-subtle)] px-3 py-2 text-[var(--cf-text)]",
  assistant: "mr-8 break-words text-[var(--cf-text-secondary)]",
  staff: "mr-8 break-words border-l-2 border-[var(--cf-brand)] pl-2 text-[var(--cf-text)]",
  // A staff member joining or leaving is news about the chat, not that person talking.
  presence: "text-center text-xs text-[var(--cf-text-secondary)]",
} as const

export function WebsiteChat({ onClose, whatsappE164 }: { onClose: () => void; whatsappE164: string | null }) {
  const brand = useWebsiteIdentity().tradingName
  const { phase, mode, staffName, ref, lines, busy, notice, errors, start, send, endChat } = useWebsiteChat()
  const [form, setForm] = useState({ name: "", phone: "", email: "", consent: false })
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileKey, setTurnstileKey] = useState(0)
  const [draft, setDraft] = useState("")
  const logRef = useRef<HTMLDivElement>(null)
  const lineCount = lines.length

  // Also when the mode changes: the fallback block or a status line mounts under the log
  // and shrinks it, which would otherwise leave the newest line hidden below the fold.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lineCount, mode])

  async function submitForm(e: FormEvent) {
    e.preventDefault()
    // Turnstile tokens are single-use and the server verifies them before field
    // validation, so after any failed start the visitor needs a fresh challenge.
    if ((await start(form, turnstileToken)) === "failed") {
      setTurnstileToken(null)
      setTurnstileKey((k) => k + 1)
    }
  }

  async function sendDraft() {
    if (!draft.trim() || busy) return
    setDraft("")
    await send(draft)
  }

  async function submitMessage(e: FormEvent) {
    e.preventDefault()
    await sendDraft()
  }

  // Enter sends, as Send does; Shift+Enter is a new line. Enter that ends an IME composition is the IME's.
  async function messageKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    await sendDraft()
  }

  const withStaff = mode === "staff"
  // Handed back with a question maybe still open: the assistant does not answer what was asked of the person.
  const last = lines[lines.length - 1]
  const backWithBot = mode === "bot" && last?.from === "staff" && presenceEvent(last.text, last.name, brand) === "left"
  const title = withStaff ? `${staffName ?? "A consultant"} from ${brand}` : `${brand} assistant`

  const fields = [
    { key: "name", id: "chat-name", label: "Name", type: "text", autoComplete: "name" },
    { key: "phone", id: "chat-phone", label: "Cell number", type: "tel", autoComplete: "tel" },
    { key: "email", id: "chat-email", label: "Email", type: "email", autoComplete: "email" },
  ] as const

  return (
    // Anchored above the launcher (bottom-24, 6rem) and growing upwards, it must stop below the site
    // header (components/website/NavBar.tsx: sticky top-0, h-16 plus a 1px border, z-50 over this
    // panel's z-40), or the title row and the close button slide under it on a short screen. The cap
    // is the visible height less 6rem below, 4rem + 1px of header and a gap: 10.5rem in all. From sm
    // the panel is at most 70% of the screen, and never more than that same room.
    <div
      data-testid="chat-panel"
      className="fixed right-4 bottom-24 z-40 flex max-h-[calc(100dvh-10.5rem)] sm:max-h-[min(70vh,calc(100dvh-10.5rem))] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] shadow-xl backdrop-blur print:hidden"
    >
      <div className="flex items-center justify-between border-b border-[var(--cf-border-subtle)] px-4 py-3">
        <span data-testid="chat-title" className="text-sm font-semibold text-[var(--cf-brand)]">{title}</span>
        <button type="button" aria-label="Close chat" onClick={onClose} className="text-[var(--cf-text-secondary)] hover:text-[var(--cf-text)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="border-b border-[var(--cf-border-subtle)] px-4 py-2 text-xs text-[var(--cf-text-secondary)]">
        {withStaff ? "You are chatting to a person." : "Automated assistant. General information only, not advice or a quote."}
      </p>

      {phase === "form" ? (
        <form onSubmit={submitForm} className="flex-1 space-y-3 overflow-y-auto p-4">
          {fields.map((f) => (
            <div key={f.key}>
              <label htmlFor={f.id} className="mb-1 block text-xs text-[var(--cf-text-secondary)]">{f.label}</label>
              <input
                id={f.id}
                name={f.key}
                type={f.type}
                autoComplete={f.autoComplete}
                required
                value={form[f.key]}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                aria-describedby={errors[f.key] ? `${f.id}-error` : undefined}
                className={inputClass}
              />
              {errors[f.key] && <p id={`${f.id}-error`} className={errorClass}>{errors[f.key]}</p>}
            </div>
          ))}
          <div>
            <label className="flex items-start gap-2 text-xs text-[var(--cf-text-secondary)]">
              <input
                type="checkbox"
                name="consent"
                checked={form.consent}
                onChange={(e) => setForm((prev) => ({ ...prev, consent: e.target.checked }))}
                aria-describedby={errors.consent ? "chat-consent-error" : undefined}
                className="mt-0.5"
              />
              <span data-testid="consent-text">{chatConsentText(brand)}</span>
            </label>
            {errors.consent && <p id="chat-consent-error" className={errorClass}>{errors.consent}</p>}
          </div>
          <TurnstileWidget
            key={turnstileKey}
            onToken={setTurnstileToken}
            onError={() => setTurnstileToken(null)}
            onExpired={() => setTurnstileToken(null)}
          />
          {errors.submit && <p className={errorClass}>{errors.submit}</p>}
          <button
            type="submit"
            disabled={busy}
            className={`${primaryClass} w-full px-4 py-2`}
          >
            Start chat
          </button>
        </form>
      ) : (
        <>
          <div ref={logRef} role="log" aria-live="polite" className="flex-1 space-y-2 overflow-y-auto p-4 text-sm">
            {lines.map((line) => {
              if (line.from === "visitor") return <p key={line.id} data-from="visitor" className={lineClass.visitor}>{line.text}</p>
              const presence = line.from === "staff" ? presenceEvent(line.text, line.name, brand) : null
              if (presence) return <p key={line.id} data-from="staff" data-presence={presence} className={lineClass.presence}>{line.text}</p>
              return (
                <div key={line.id} data-from={line.from} className={lineClass[line.from]}>
                  {line.from === "staff" && (
                    <span data-testid="staff-label" className="block text-[11px] font-semibold text-[var(--cf-brand)]">{line.name ?? "Consultant"}</span>
                  )}
                  <ChatText text={line.text} />
                </div>
              )
            })}
          </div>
          {mode === "waiting" && <p role="status" className={statusClass}>Connecting you to a consultant…</p>}
          {backWithBot && <p role="status" className={statusClass}>You&apos;re back with our automated assistant. Ask again if you still need help.</p>}
          {mode === "fallback" && (
            <div data-testid="chat-fallback" className="border-t border-[var(--cf-border-subtle)] px-4 py-1.5 text-xs text-[var(--cf-text-secondary)]">
              <p className="mb-1">No consultant is available right now.</p>
              {whatsappE164 && (
                <a
                  href={waHref(whatsappE164, whatsAppFallbackText(ref, lines))}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${primaryClass} block px-4 py-1.5 text-center`}
                >
                  Continue on WhatsApp
                </a>
              )}
              <p className="mt-1 text-[11px]">{`${whatsappE164 ? "or we'll" : "We'll"} call you on the number you gave us during business hours.`}</p>
            </div>
          )}
          {notice && <p className={statusClass}>{notice}</p>}
          <div className="border-t border-[var(--cf-border-subtle)] px-4 py-1 text-right">
            <button type="button" aria-label="End chat" onClick={endChat} className="text-[11px] text-[var(--cf-text-secondary)] underline hover:text-[var(--cf-text)]">
              End chat
            </button>
          </div>
          {phase === "chat" && (
            <form onSubmit={submitMessage} className="flex gap-2 border-t border-[var(--cf-border-subtle)] p-3">
              <textarea
                aria-label="Your message"
                rows={2}
                maxLength={MAX_CHAT_MESSAGE_CHARS}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={messageKeyDown}
                className={`${inputClass} flex-1 resize-none`}
              />
              <button type="submit" disabled={busy} className={`${primaryClass} self-end px-3 py-2`}>
                Send
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}
