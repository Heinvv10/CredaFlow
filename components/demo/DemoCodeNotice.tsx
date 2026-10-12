// Shown on the code-entry step when a DEMO_MODE deployment returned the
// one-time code (lib/config/demo-mode.ts demoCodeReveal). The parent renders
// it only when the server sent a code, so it never appears outside a demo.

/**
 * The demo code in a code-request response body, or "" when there is none.
 * Callers set their state from every response, so a later response without a
 * code clears one shown earlier.
 */
export function demoCodeFrom(data: unknown): string {
  const code = (data as { demoCode?: unknown } | null)?.demoCode
  return typeof code === "string" ? code : ""
}

export function DemoCodeNotice({ code }: { code: string }) {
  return (
    <div
      role="note"
      data-demo-code
      className="border border-[var(--cf-warning)] bg-[var(--cf-bg-raised)] px-4 py-3 text-sm text-[var(--cf-text)]"
    >
      Demo environment: your code is{" "}
      <strong className="font-mono tracking-widest">{code}</strong>
    </div>
  )
}
