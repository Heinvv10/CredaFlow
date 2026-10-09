/**
 * The visitor's chat token and whether the panel is open, kept in this tab's sessionStorage so a refresh or a page change
 * carries the chat on. Storage can be missing or throw (private windows, blocked site data), so
 * every access is guarded: without it the chat still works, it just lasts as long as the page.
 */
const KEY = "cf-website-chat"

export function storedChatToken(): string | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY)
    const token: unknown = raw ? JSON.parse(raw).token : null
    return typeof token === "string" && token !== "" ? token : null
  } catch {
    return null // unreadable storage is no stored chat
  }
}

export function storeChatToken(token: string): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify({ token, open: true }))
  } catch {
    // Not kept: the chat goes on, and ends with the page.
  }
}

/** Whether the panel was left open. A value stored before the flag existed reads as open. */
export function storedChatOpen(): boolean {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY)
    return (raw ? JSON.parse(raw).open : true) !== false
  } catch {
    return true
  }
}

/** Records that the visitor closed or reopened the panel; the chat itself is untouched. Nothing stored, nothing to record. */
export function storeChatOpen(open: boolean): void {
  try {
    const token = storedChatToken()
    if (token) globalThis.sessionStorage?.setItem(KEY, JSON.stringify({ token, open }))
  } catch {
    // Not kept: the panel opens as it did before.
  }
}

export function forgetChatToken(): void {
  try {
    globalThis.sessionStorage?.removeItem(KEY)
  } catch {
    // Storage that cannot be written holds nothing of ours to remove.
  }
}
