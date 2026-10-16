import { InfoStrip } from "@/components/app-shell/InfoStrip"
import { formatZAR } from "@/lib/utils"
import { controlLabel, refusalCopy } from "./accounting-text"

export interface ControlRow {
  control: string
  key: string
  /** The contract's reference when the server could name it. */
  reference?: string | null
  journalCents: number
  bookCents: number
}

/** Why a month cannot close, in plain words, with the server's sentence as the detail. */
export function RefusalNotice({ refusal }: { refusal: { code: string; message: string } }) {
  const copy = refusalCopy(refusal.code)
  return (
    <InfoStrip variant="warning">
      <p className="font-semibold" data-refusal={refusal.code}>{copy.title}</p>
      {copy.advice && <p className="mt-1">{copy.advice}</p>}
      <p className="mt-1 break-words text-xs opacity-90">{refusal.message}</p>
    </InfoStrip>
  )
}

/** The asset-finance checks that differ: the journal's figure against the contract records'. */
export function ControlsList({ controls }: { controls: ControlRow[] }) {
  if (controls.length === 0) return null
  return (
    <div className="rounded-md border border-[var(--cf-border-subtle)] p-3 text-sm" aria-label="Asset-finance checks that differ">
      <p className="font-semibold text-[var(--cf-danger)]">{controls.length === 1 ? "1 asset-finance check differs" : `${controls.length} asset-finance checks differ`}</p>
      <ul className="mt-2 space-y-2">
        {controls.slice(0, 10).map((c) => (
          <li key={`${c.control}-${c.key}`} className="min-w-0 text-xs text-[var(--cf-text-secondary)]">
            <span className="block font-medium text-[var(--cf-text)]">{controlLabel(c.control)}</span>
            <span className="block break-words">{c.reference ?? c.key}: journal {formatZAR(c.journalCents)}, contract records {formatZAR(c.bookCents)}</span>
          </li>
        ))}
      </ul>
      {controls.length > 10 && <p className="mt-2 text-xs text-[var(--cf-text-muted)]">and {controls.length - 10} more</p>}
    </div>
  )
}
