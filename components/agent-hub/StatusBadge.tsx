// Deliberately separate from the shadcn Badge (@/components/ui/badge): the
// two are NOT interchangeable despite sharing the same status-color CSS
// variables — different element, font size, weight, casing, and
// border/background opacity. A straight swap would silently restyle every
// status badge on this page. This is a leaf module so AgentsTab.tsx and
// CommissionTab.tsx both depend on it rather than one depending on the
// other.
export function StatusBadge({ tone, children }: { tone: "green" | "amber" | "red"; children: string }) {
  const cls = tone === "green" ? "border-emerald-500/30 bg-emerald-500/10 text-[var(--cf-success)]" : tone === "amber" ? "border-amber-500/30 bg-amber-500/10 text-[var(--cf-warning)]" : "border-red-500/30 bg-red-500/10 text-[var(--cf-danger)]"
  return <span className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-wide ${cls}`}>{children}</span>
}
