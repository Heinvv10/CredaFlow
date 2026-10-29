"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DECLINE_CATEGORY_LABELS } from "@/lib/applications/decline-category"
import type { BandAction, Characteristic, GradeBand, Scorecard, ScorecardBin } from "@/lib/decisioning/types"
import { controlClass, type FactOption } from "./types"

const CATEGORIES = Object.entries(DECLINE_CATEGORY_LABELS).filter(([key]) => key !== "OTHER" && key !== "WITHDRAWN")
const emptyCard = (fact: FactOption): Scorecard => ({
  baseScore: 0,
  characteristics: [{ field: fact.name, missingPoints: 0, bins: [{ min: 0, points: 0 }] }],
  bands: [{ minScore: 100, grade: "A", action: "ALLOW" }, { minScore: 0, grade: "B", action: "REFER" }],
})

function BinRow({ bin, fact, onChange, onRemove }: { bin: ScorecardBin; fact: FactOption; onChange: (b: ScorecardBin) => void; onRemove: () => void }) {
  const kind = bin.equals !== undefined ? "equals" : bin.in !== undefined ? "in" : "range"
  const switchKind = (next: string) =>
    onChange(next === "range" ? { min: 0, points: bin.points } : next === "equals" ? { equals: fact.type === "boolean" ? true : fact.type === "number" ? 0 : fact.values?.[0] ?? "", points: bin.points } : { in: [], points: bin.points })
  const scalar = (text: string) => (fact.type === "number" ? Number(text) : fact.type === "boolean" ? text === "true" : text)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Bin test" className={controlClass} value={kind} onChange={(e) => switchKind(e.target.value)}>
        {fact.type === "number" && <option value="range">range</option>}
        <option value="equals">equals</option>
        {fact.type !== "boolean" && <option value="in">one of</option>}
      </select>
      {kind === "range" && (
        <>
          <Input aria-label="From (inclusive)" type="number" placeholder="from" className="w-28" value={bin.min ?? ""} onChange={(e) => onChange({ ...bin, min: e.target.value === "" ? undefined : Number(e.target.value) })} />
          <Input aria-label="Up to (exclusive)" type="number" placeholder="up to" className="w-28" value={bin.max ?? ""} onChange={(e) => onChange({ ...bin, max: e.target.value === "" ? undefined : Number(e.target.value) })} />
        </>
      )}
      {kind === "equals" && (fact.type === "boolean"
        ? <select aria-label="Value" className={controlClass} value={String(bin.equals)} onChange={(e) => onChange({ ...bin, equals: e.target.value === "true" })}><option value="true">yes</option><option value="false">no</option></select>
        : <Input aria-label="Value" className="w-40" value={String(bin.equals ?? "")} onChange={(e) => onChange({ ...bin, equals: scalar(e.target.value) })} />)}
      {kind === "in" && <Input aria-label="Values" className="w-64" placeholder={fact.values?.join(", ") ?? "comma separated"} value={(bin.in ?? []).join(", ")} onChange={(e) => onChange({ ...bin, in: e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map(scalar) })} />}
      <Label className="text-xs">points</Label>
      <Input aria-label="Points" type="number" className="w-24" value={bin.points} onChange={(e) => onChange({ ...bin, points: Number(e.target.value) })} />
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
    </div>
  )
}

function CharacteristicBlock({ item, facts, onChange, onRemove }: { item: Characteristic; facts: FactOption[]; onChange: (c: Characteristic) => void; onRemove: () => void }) {
  const fact = facts.find((f) => f.name === item.field) ?? facts[0]
  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Characteristic" className={controlClass} value={item.field} onChange={(e) => onChange({ field: e.target.value as Characteristic["field"], missingPoints: item.missingPoints, bins: [{ min: 0, points: 0 }] })}>
          {facts.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
        </select>
        <Label className="text-xs">points when missing or unmatched</Label>
        <Input aria-label="Missing points" type="number" className="w-24" value={item.missingPoints} onChange={(e) => onChange({ ...item, missingPoints: Number(e.target.value) })} />
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove characteristic</Button>
      </div>
      <div className="space-y-2 pl-3">
        {item.bins.map((bin, i) => (
          <BinRow key={i} bin={bin} fact={fact} onChange={(b) => onChange({ ...item, bins: item.bins.map((x, j) => (j === i ? b : x)) })} onRemove={() => onChange({ ...item, bins: item.bins.filter((_, j) => j !== i) })} />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...item, bins: [...item.bins, { min: 0, points: 0 }] })}>Add bin</Button>
      </div>
    </div>
  )
}

function BandRow({ band, onChange, onRemove }: { band: GradeBand; onChange: (b: GradeBand) => void; onRemove: () => void }) {
  const setAction = (action: BandAction) => {
    const { declineCategory: _c, ...rest } = band
    onChange({ ...rest, action, ...(action === "DECLINE" ? { declineCategory: "POLICY" as const } : {}) })
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="text-xs">score from</Label>
      <Input aria-label="Band minimum score" type="number" className="w-24" value={band.minScore} onChange={(e) => onChange({ ...band, minScore: Number(e.target.value) })} />
      <Label className="text-xs">grade</Label>
      <Input aria-label="Grade" className="w-20" value={band.grade} onChange={(e) => onChange({ ...band, grade: e.target.value.toUpperCase() })} />
      <select aria-label="Band action" className={controlClass} value={band.action} onChange={(e) => setAction(e.target.value as BandAction)}>
        <option value="ALLOW">allow</option>
        <option value="REFER">refer to staff</option>
        <option value="DECLINE">decline</option>
      </select>
      {band.action === "DECLINE" && (
        <select aria-label="Decline reason" className={controlClass} value={band.declineCategory ?? "POLICY"} onChange={(e) => onChange({ ...band, declineCategory: e.target.value as GradeBand["declineCategory"] })}>
          {CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      )}
      <Input aria-label="Pricing tier" placeholder="pricing tier" className="w-36" value={band.pricingTier ?? ""} onChange={(e) => onChange({ ...band, pricingTier: e.target.value || undefined })} />
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
    </div>
  )
}

interface Props {
  scorecard: Scorecard | null
  facts: FactOption[]
  disabled?: boolean
  onChange: (scorecard: Scorecard | null) => void
}

/** The scorecard: points per attribute bin, summed to a score, mapped to grade bands (grade, action, pricing tier). */
export function ScorecardEditor({ scorecard, facts, disabled, onChange }: Props) {
  if (!scorecard) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--cf-text-muted)]">No scorecard: this rule set grades nothing and decides on its rules alone.</p>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange(emptyCard(facts.find((f) => f.name === "bureauScore") ?? facts[0]))}>Add a scorecard</Button>
      </div>
    )
  }
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="card-base">Base score</Label>
        <Input id="card-base" type="number" className="w-28" value={scorecard.baseScore} onChange={(e) => onChange({ ...scorecard, baseScore: Number(e.target.value) })} />
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>Remove scorecard</Button>
      </div>
      <div className="space-y-3">
        <h4 className="text-sm font-semibold">Characteristics</h4>
        {scorecard.characteristics.map((item, i) => (
          <CharacteristicBlock key={i} item={item} facts={facts}
            onChange={(c) => onChange({ ...scorecard, characteristics: scorecard.characteristics.map((x, j) => (j === i ? c : x)) })}
            onRemove={() => onChange({ ...scorecard, characteristics: scorecard.characteristics.filter((_, j) => j !== i) })} />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...scorecard, characteristics: [...scorecard.characteristics, { field: facts[0].name, missingPoints: 0, bins: [{ min: 0, points: 0 }] }] })}>Add characteristic</Button>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">Grade bands (highest score first; the last band takes everything below)</h4>
        {scorecard.bands.map((band, i) => (
          <BandRow key={i} band={band}
            onChange={(b) => onChange({ ...scorecard, bands: scorecard.bands.map((x, j) => (j === i ? b : x)) })}
            onRemove={() => onChange({ ...scorecard, bands: scorecard.bands.filter((_, j) => j !== i) })} />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...scorecard, bands: [...scorecard.bands, { minScore: 0, grade: "Z", action: "ALLOW" }] })}>Add band</Button>
      </div>
    </fieldset>
  )
}
