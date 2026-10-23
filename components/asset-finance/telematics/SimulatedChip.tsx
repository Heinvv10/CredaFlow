import { StatusPill } from "@/components/app-shell/StatusPill"

/** The amber label on anything a simulated tracker produced (SLICE5.md part B). */
export function SimulatedChip({ label = "Simulated" }: { label?: string }) {
  return <StatusPill tone="warning">{label}</StatusPill>
}
