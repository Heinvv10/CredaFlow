"use client"

import { useCallback, useEffect, useState } from "react"
import type { EligibilityLifeScope, EligibilityRuleType } from "@prisma/client"
import { toast } from "@/lib/toast"
import { formatZAR } from "@/lib/utils"
import { mandatoryRuleStatus } from "@/lib/insurance/eligibility/mandatory-status"
import {
  loadEligibilityRules,
  numberOrNull,
  readApiError,
  toRands,
  type EligibilityRuleRow,
} from "@/lib/settings-insurance-config"

const inputCls =
  "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"

/**
 * Every rule type, with the UNIT its number is in. The column is one
 * `Decimal(14, 2)` for all of them, so nothing but this label tells an operator
 * whether 180 is days or rands — and a waiting period captured in months is an
 * insurer term this system would then screen every life against.
 */
const RULE_TYPES: { value: EligibilityRuleType; label: string; unit: "years" | "days" | "rands" | "lives" }[] = [
  { value: "MIN_ENTRY_AGE", label: "Minimum entry age", unit: "years" },
  { value: "MAX_ENTRY_AGE", label: "Maximum entry age", unit: "years" },
  { value: "MIN_COVER", label: "Minimum cover", unit: "rands" },
  { value: "MAX_COVER", label: "Maximum cover", unit: "rands" },
  { value: "MAX_TOTAL_COVER", label: "Maximum total cover", unit: "rands" },
  { value: "WAITING_PERIOD_DAYS", label: "Waiting period", unit: "days" },
  { value: "MAX_LIVES_OF_TYPE", label: "Maximum lives of type", unit: "lives" },
  { value: "COOLING_OFF_DAYS", label: "Cooling-off period", unit: "days" },
]

const LIFE_SCOPES: { value: EligibilityLifeScope; label: string }[] = [
  { value: "ALL_LIVES", label: "All lives" },
  { value: "MAIN_MEMBER", label: "Main member" },
  { value: "SPOUSE", label: "Spouse" },
  { value: "CHILD", label: "Child" },
  { value: "EXTENDED_FAMILY", label: "Extended family" },
]

function ruleMeta(ruleType: EligibilityRuleType) {
  return RULE_TYPES.find((r) => r.value === ruleType)
}

function formatValue(rule: EligibilityRuleRow): string {
  if (rule.numericValue === null) return "—"
  const value = toRands(rule.numericValue)
  const unit = ruleMeta(rule.ruleType)?.unit
  if (unit === "rands") return formatZAR(Math.round(value * 100))
  return `${value} ${unit ?? ""}`.trim()
}

interface RuleForm {
  ruleType: EligibilityRuleType
  lifeScope: EligibilityLifeScope
  numericValue: string
  textValue: string
  active: boolean
}

// Both selects start on a real enum member. A `<select>` whose value matches no
// option renders option[0] while the form holds something else — a defect that
// has reached production in this repo twice.
const BLANK: RuleForm = {
  ruleType: "MIN_ENTRY_AGE",
  lifeScope: "ALL_LIVES",
  numericValue: "",
  textValue: "",
  active: true,
}

export function EligibilityRulesManager({
  productId,
  canWrite,
}: {
  productId: string
  canWrite: boolean
}) {
  const [rules, setRules] = useState<EligibilityRuleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<RuleForm>(BLANK)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setRules(await loadEligibilityRules(productId))
      setLoadError(null)
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // productId, lifeScope and ruleType are the rule's identity — they form
      // the unique key, and the PATCH route refuses to move a rule across them.
      // An edit therefore sends only the value fields, and the two identity
      // selects are disabled while editing.
      const body = editingId
        ? {
            numericValue: numberOrNull(form.numericValue),
            textValue: form.textValue.trim() === "" ? null : form.textValue,
            active: form.active,
          }
        : {
            productId,
            ruleType: form.ruleType,
            lifeScope: form.lifeScope,
            numericValue: numberOrNull(form.numericValue),
            textValue: form.textValue.trim() === "" ? null : form.textValue,
            active: form.active,
          }

      const res = await fetch(
        editingId ? `/api/insurance/eligibility-rules/${editingId}` : "/api/insurance/eligibility-rules",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      )
      if (!res.ok) {
        setError(await readApiError(res))
        return
      }
      toast.success(editingId ? "Rule updated" : "Rule added")
      setEditingId(null)
      setForm(BLANK)
      await refresh()
    } catch {
      setError("The request could not be sent. Check the connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  async function remove(rule: EligibilityRuleRow) {
    const label = ruleMeta(rule.ruleType)?.label ?? rule.ruleType
    if (!confirm(`Delete the ${label} rule for ${rule.lifeScope}?`)) return
    setError(null)
    try {
      const res = await fetch(`/api/insurance/eligibility-rules/${rule.id}`, { method: "DELETE" })
      if (!res.ok) {
        setError(await readApiError(res))
        return
      }
      if (editingId === rule.id) {
        setEditingId(null)
        setForm(BLANK)
      }
      toast.success("Rule deleted")
      await refresh()
    } catch {
      setError("The request could not be sent. Check the connection and try again.")
    }
  }

  function startEdit(rule: EligibilityRuleRow) {
    setEditingId(rule.id)
    setError(null)
    setForm({
      ruleType: rule.ruleType,
      lifeScope: rule.lifeScope,
      numericValue: rule.numericValue === null ? "" : String(toRands(rule.numericValue)),
      textValue: rule.textValue ?? "",
      active: rule.active,
    })
  }

  if (loading) {
    return <div className="p-12 text-center text-gray-400 text-sm">Loading eligibility rules…</div>
  }

  // The same resolution `canSellProduct` uses, so this panel and the readiness
  // panel under Settings → Insurance Module cannot disagree about which
  // mandatory terms are captured.
  const mandatory = mandatoryRuleStatus(rules)
  const missing = mandatory.filter((status) => status.reason !== null)

  return (
    <div className="space-y-6">
      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      <div
        className={`rounded-xl border p-4 ${
          missing.length === 0 ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"
        }`}
      >
        <h3 className="text-sm font-semibold text-[#1b1d24]">Mandatory insurer terms</h3>
        {missing.length === 0 ? (
          <p className="text-sm text-gray-700 mt-1">
            {`All ${mandatory.length} mandatory rule types are captured for every life type a quote can carry.`}
          </p>
        ) : (
          <>
            <p className="text-sm text-gray-700 mt-1">
              {`${missing.length} of ${mandatory.length} mandatory rule types are still missing. Until every one is captured for every life type, this product cannot be quoted or sold.`}
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm text-amber-900 space-y-1">
              {missing.map((status) => (
                <li key={status.ruleType}>{status.reason}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {canWrite && (
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-[#1b1d24]">
              {editingId ? "Edit rule" : "Add rule"}
            </h4>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null)
                  setForm(BLANK)
                  setError(null)
                }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel edit
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Rule</span>
              <select
                value={form.ruleType}
                onChange={(e) => set("ruleType", e.target.value as EligibilityRuleType)}
                disabled={editingId !== null}
                className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-500`}
              >
                {RULE_TYPES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Applies to</span>
              <select
                value={form.lifeScope}
                onChange={(e) => set("lifeScope", e.target.value as EligibilityLifeScope)}
                disabled={editingId !== null}
                className={`${inputCls} disabled:bg-gray-100 disabled:text-gray-500`}
              >
                {LIFE_SCOPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">
                {`Value (${ruleMeta(form.ruleType)?.unit ?? ""})`}
              </span>
              <input
                value={form.numericValue}
                onChange={(e) => set("numericValue", e.target.value)}
                className={inputCls}
                inputMode="decimal"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">
                Note from the insurer&apos;s schedule
              </span>
              <input
                value={form.textValue}
                onChange={(e) => set("textValue", e.target.value)}
                className={inputCls}
                placeholder="optional"
              />
            </label>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-4 py-2 bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
            >
              {saving ? "Saving…" : editingId ? "Save rule" : "Add rule"}
            </button>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set("active", e.target.checked)}
                className="rounded border-gray-300 text-amber-600 focus:ring-amber-300"
              />
              <span>In force</span>
            </label>
            <p className="text-xs text-gray-400">
              A rule that is not in force is ignored by screening, exactly as if it were absent.
            </p>
          </div>
          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {error}
            </p>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {rules.length === 0 ? (
          <p className="p-12 text-center text-sm text-gray-400">
            No eligibility rules captured for this product.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50/50 border-b border-gray-100">
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400">Rule</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400">Applies to</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase text-gray-400">Value</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400 hidden lg:table-cell">Note</th>
                <th className="px-4 py-3 text-center text-[11px] font-semibold uppercase text-gray-400">In force</th>
                {canWrite && <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase text-gray-400">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-gray-50 hover:bg-amber-50/20">
                  <td className="px-4 py-3 font-medium text-[#1b1d24]">
                    {ruleMeta(rule.ruleType)?.label ?? rule.ruleType}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {LIFE_SCOPES.find((s) => s.value === rule.lifeScope)?.label ?? rule.lifeScope}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatValue(rule)}</td>
                  <td className="px-4 py-3 text-gray-500 hidden lg:table-cell">
                    {rule.textValue ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                        rule.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {rule.active ? "Yes" : "No"}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => startEdit(rule)}
                        className="text-xs font-medium text-[#4F46E5] hover:underline mr-3"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(rule)}
                        className="text-xs font-medium text-gray-400 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
