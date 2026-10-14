"use client"

import { signOut } from "next-auth/react"
import { LogOut } from "lucide-react"

/**
 * What a session held at TOTP enrolment sees instead of AppShell: the page and
 * a way to sign out, with no sidebar, no counts and no navigation (proxy.ts
 * refuses every other page anyway).
 */
export function EnrolmentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen cf-app-surface">
      <header className="flex h-14 items-center justify-end border-b border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] px-5">
        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text)]"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </header>
      <main className="overflow-x-hidden">{children}</main>
    </div>
  )
}
