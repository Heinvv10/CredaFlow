import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

// The lender operates only in South Africa. Formatting with the runtime's
// LOCAL timezone (what date-fns' `format()` and bare `toLocale*()` calls do)
// means a server (commonly UTC in Docker) and a browser (SAST, UTC+2) render
// the same Date to DIFFERENT text — a React #418 hydration mismatch on any
// "use client" component that formats a date in its render body. Pinning an
// explicit IANA zone makes the output identical on server and client.
export const SAST_TIME_ZONE = "Africa/Johannesburg"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatZAR(cents: number): string {
  return `R ${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`
}

/**
 * Abbreviated rand from CENTS for compact KPI cards (Rx.xm / Rxk), full
 * formatZAR below R1,000. Converts cents → rands BEFORE abbreviating — the
 * reports overview previously divided cents by 1e6 directly, overstating Book /
 * Disbursements / trend 100×.
 */
export function formatZARCompact(cents: number): string {
  const rands = cents / 100
  if (rands >= 1_000_000) return `R${(rands / 1_000_000).toFixed(1)}m`
  if (rands >= 1_000) return `R${(rands / 1_000).toFixed(0)}k`
  return formatZAR(cents)
}

/**
 * Mask all but the last 4 digits of a SA ID (or any identifier), e.g.
 * "7501015000081" → "*********0081". Used wherever an ID is shown back to the
 * owner so it is never displayed in full. Strings of length <= 4 are returned
 * unchanged (nothing to mask).
 */
export function maskIdNumber(id: string): string {
  if (id.length <= 4) return id
  return "*".repeat(id.length - 4) + id.slice(-4)
}

/**
 * Mask an email's local part, keeping the first + last character and the whole
 * domain, e.g. "naledi@example.com" → "n****i@example.com".
 * Used when an email is shown back to a DIFFERENT party (the account owner)
 * as a "was this you?" hint, so the address is never disclosed in full.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@")
  if (at < 1) return "***"
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 1) return `*${domain}`
  if (local.length === 2) return `${local[0]}*${domain}`
  return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}${domain}`
}

/**
 * Escape the five HTML-significant characters so an untrusted or
 * user-influenced string can be safely interpolated into hand-built HTML
 * (e.g. a transactional email body). Ampersand is replaced first so the
 * entities introduced by the later replacements are not double-escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SAST_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d)
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: SAST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d)
  return `${formatDate(d)} ${time}`
}

/**
 * Convert a term stored in days to a human-readable string.
 * Loans use days internally (30 days = 1 month).
 * Examples: 30 → "1 month", 90 → "3 months", 1800 → "60 months"
 */
export function formatTermDays(days: number): string {
  const months = Math.round(days / 30)
  if (months < 1) return `${days} day${days !== 1 ? "s" : ""}`
  return `${months} month${months !== 1 ? "s" : ""}`
}

export function generateReference(prefix: string): string {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `${prefix}-${timestamp}-${random}`
}
