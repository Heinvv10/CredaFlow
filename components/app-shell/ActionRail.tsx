import { DataPanel } from "@/components/app-shell/DataPanel"
import { cn } from "@/lib/utils"

type ActionRailItem = {
  label: string
  detail?: string
  tone?: "neutral" | "success" | "warning" | "danger" | "info"
}

type ActionRailProps = {
  title?: string
  description?: string
  primary?: React.ReactNode
  secondary?: React.ReactNode
  blockers?: ActionRailItem[]
  audit?: ActionRailItem[]
}

const toneClass = {
  neutral: "border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)]",
  success: "border-[rgba(63,191,127,0.34)] text-[var(--cf-success)]",
  warning: "border-[rgba(217,154,58,0.36)] text-[var(--cf-warning)]",
  danger: "border-[rgba(208,92,75,0.36)] text-[var(--cf-danger)]",
  info: "border-[rgba(111,159,203,0.34)] text-[var(--cf-info)]",
}

export function ActionRail({
  title = "Decision rail",
  description = "Next safe actions for this case.",
  primary,
  secondary,
  blockers = [],
  audit = [],
}: ActionRailProps) {
  return (
    <DataPanel title={title} description={description} variant="raised" density="compact">
      <div className="space-y-4">
        {primary && <div className="grid gap-2">{primary}</div>}
        {secondary && <div className="grid gap-2">{secondary}</div>}
        {blockers.length > 0 && (
          <RailList title="Blockers" items={blockers} />
        )}
        {audit.length > 0 && (
          <RailList title="Audit trail" items={audit} subtle />
        )}
      </div>
    </DataPanel>
  )
}

function RailList({ title, items, subtle = false }: { title: string; items: ActionRailItem[]; subtle?: boolean }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-brand)]">{title}</p>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div
            key={`${item.label}-${index}`}
            className={cn(
              "border-l-2 bg-[var(--cf-surface-soft)] px-3 py-2",
              toneClass[item.tone ?? "neutral"],
              subtle && "bg-transparent"
            )}
          >
            <p className="text-xs font-semibold">{item.label}</p>
            {item.detail && <p className="mt-0.5 text-[11px] leading-4 text-[var(--cf-text-muted)]">{item.detail}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
