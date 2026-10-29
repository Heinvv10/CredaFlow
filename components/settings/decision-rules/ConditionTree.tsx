"use client"

import { Button } from "@/components/ui/button"
import type { Condition, Group, Node, Operator, Scalar } from "@/lib/decisioning/types"
import { ListField, NumberField } from "./fields"
import { controlClass, type FactOption } from "./types"

const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "is", neq: "is not", gt: "is above", gte: "is at least", lt: "is below", lte: "is at most",
  between: "is between", in: "is one of", notIn: "is none of", isNull: "is missing", notNull: "is present",
}
const OPERATORS_BY_TYPE: Record<string, Operator[]> = {
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "notIn", "isNull", "notNull"],
  string: ["eq", "neq", "in", "notIn", "isNull", "notNull"],
  boolean: ["eq", "neq", "isNull", "notNull"],
}

const isCondition = (node: Node): node is Condition => "field" in node

function defaultCondition(fact: FactOption): Condition {
  return fact.type === "boolean" ? { field: fact.name, op: "eq", value: true }
    : fact.type === "number" ? { field: fact.name, op: "lt", value: 0 }
    : { field: fact.name, op: "eq", value: fact.values?.[0] ?? "" }
}

function parseScalar(text: string, type: string): Scalar {
  return type === "number" ? Number(text) : text
}

function ValueInput({ condition, fact, onChange }: { condition: Condition; fact: FactOption; onChange: (c: Condition) => void }) {
  const { op } = condition
  if (op === "isNull" || op === "notNull") return null
  if (fact.type === "boolean") {
    return (
      <select aria-label="Value" className={controlClass} value={String(condition.value)} onChange={(e) => onChange({ ...condition, value: e.target.value === "true" })}>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    )
  }
  if (op === "between") {
    const [low, high] = Array.isArray(condition.value) ? condition.value : [0, 0]
    return (
      <span className="flex items-center gap-1">
        <NumberField label="Low" className="w-28" value={Number(low)} onChange={(n) => onChange({ ...condition, value: [n, Number(high)] })} />
        <span className="text-xs text-[var(--cf-text-muted)]">and</span>
        <NumberField label="High" className="w-28" value={Number(high)} onChange={(n) => onChange({ ...condition, value: [Number(low), n] })} />
      </span>
    )
  }
  if (op === "in" || op === "notIn") {
    const list = Array.isArray(condition.value) ? condition.value : []
    return (
      <ListField
        label="Values" className="w-64" value={list} placeholder={fact.values ? fact.values.join(", ") : "comma separated"}
        parse={(text) => parseScalar(text, fact.type)} onChange={(value) => onChange({ ...condition, value })}
      />
    )
  }
  if (fact.values) {
    return (
      <select aria-label="Value" className={controlClass} value={String(condition.value ?? "")} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
        {fact.values.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }
  if (fact.type === "number") {
    return <NumberField label="Value" className="w-40" value={Number(condition.value ?? 0)} onChange={(n) => onChange({ ...condition, value: n })} />
  }
  return (
    <input aria-label="Value" className={`${controlClass} w-40`} type="text" value={String(condition.value ?? "")} onChange={(e) => onChange({ ...condition, value: e.target.value })} />
  )
}

function ConditionRow({ condition, facts, onChange, onRemove }: { condition: Condition; facts: FactOption[]; onChange: (c: Condition) => void; onRemove: () => void }) {
  const fact = facts.find((f) => f.name === condition.field) ?? facts[0]
  const ops = OPERATORS_BY_TYPE[fact.type]
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Fact" className={controlClass} value={fact.name} onChange={(e) => onChange(defaultCondition(facts.find((f) => f.name === e.target.value) ?? fact))}>
        {facts.map((f) => <option key={f.name} value={f.name}>{f.label}{f.unit ? ` (${f.unit})` : ""}</option>)}
      </select>
      <select
        aria-label="Operator" className={controlClass} value={condition.op}
        onChange={(e) => {
          const op = e.target.value as Operator
          const value = op === "between" ? [0, 0] : op === "in" || op === "notIn" ? [] : op === "isNull" || op === "notNull" ? undefined : fact.type === "boolean" ? true : fact.type === "number" ? 0 : fact.values?.[0] ?? ""
          onChange({ field: condition.field, op, ...(value === undefined ? {} : { value }) })
        }}
      >
        {ops.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>
      <ValueInput condition={condition} fact={fact} onChange={onChange} />
      <Button type="button" variant="ghost" size="sm" aria-label="Remove condition" onClick={onRemove}>Remove</Button>
    </div>
  )
}

interface Props {
  node: Node
  facts: FactOption[]
  onChange: (node: Node) => void
  /** Present on a nested group: removes it from its parent. */
  onRemove?: () => void
  depth?: number
}

/** A rule's condition: a condition, or an all/any group of them, nested up to five deep. */
export function ConditionTree({ node, facts, onChange, onRemove, depth = 0 }: Props) {
  if (isCondition(node)) {
    return <ConditionRow condition={node} facts={facts} onChange={onChange} onRemove={onRemove ?? (() => undefined)} />
  }
  const group = node as Group
  const mode = group.all ? "all" : "any"
  const children = (group.all ?? group.any ?? []) as Node[]
  const set = (next: Node[], nextMode = mode) => onChange(nextMode === "all" ? { all: next } : { any: next })
  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
      <div className="flex items-center gap-2 text-sm">
        <span>Match</span>
        <select aria-label="Group type" className={controlClass} value={mode} onChange={(e) => set(children, e.target.value as "all" | "any")}>
          <option value="all">all of</option>
          <option value="any">any of</option>
        </select>
        <span>these</span>
        {onRemove && <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove group</Button>}
      </div>
      <div className="space-y-2 pl-3">
        {children.map((child, i) => (
          <ConditionTree
            key={i} node={child} facts={facts} depth={depth + 1}
            onChange={(next) => set(children.map((c, j) => (j === i ? next : c)))}
            onRemove={children.length > 1 ? () => set(children.filter((_, j) => j !== i)) : undefined}
          />
        ))}
      </div>
      <div className="flex gap-2 pl-3">
        <Button type="button" variant="outline" size="sm" onClick={() => set([...children, defaultCondition(facts[0])])}>Add condition</Button>
        {depth < 4 && <Button type="button" variant="outline" size="sm" onClick={() => set([...children, { all: [defaultCondition(facts[0])] }])}>Add group</Button>}
      </div>
    </div>
  )
}
