"use client"

import { useMemo, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { buildReferralLink } from "@/lib/agent-hub/referral-link"
import { matchesAgentSearch } from "@/lib/agent-hub/agent-search"
import { StatusBadge } from "./StatusBadge"

type ReferralCode = {
  id: string
  code: string
  label: string | null
  campaign: string | null
  status: string
}

type Agent = {
  id: string
  displayName: string
  legalName: string | null
  phone: string | null
  email: string | null
  channel: string
  status: string
  commissionBps: number | null
  referralCodes: ReferralCode[]
}

async function jsonFetch(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

export function AgentsTab({ agents }: { agents: Agent[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newAgent, setNewAgent] = useState({ displayName: "", code: "", phone: "", email: "", channel: "FIELD", notes: "" })
  const [newCode, setNewCode] = useState({ agentId: agents[0]?.id ?? "", code: "", label: "", campaign: "" })
  const [copied, setCopied] = useState<string | null>(null)
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [showIssueCode, setShowIssueCode] = useState(false)
  const [search, setSearch] = useState("")

  const filteredAgents = useMemo(() => agents.filter((agent) => matchesAgentSearch(agent, search)), [agents, search])

  // Staff previously only saw the raw code string and hand-built share links.
  // Copies the product-neutral /site/apply link (attribution survives whatever
  // the agent's prospect ends up applying for).
  // Falls back to surfacing the URL if the Clipboard API is unavailable
  // (insecure context / permission denied).
  async function copyLink(code: string) {
    let url: string
    try {
      url = buildReferralLink(code)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the referral link.")
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(code)
      setTimeout(() => setCopied((current) => (current === code ? null : current)), 2000)
    } catch {
      setError(`Copy blocked by the browser — link: ${url}`)
    }
  }

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    setMessage(null)
    setError(null)
    try {
      await fn()
      setMessage(`${label} completed`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`)
    } finally {
      setBusy(null)
    }
  }

  function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    return run("Create agent", async () => {
      await jsonFetch("/api/agent-hub/agents", { method: "POST", body: JSON.stringify(newAgent) })
      setNewAgent({ displayName: "", code: "", phone: "", email: "", channel: "FIELD", notes: "" })
      setShowAddAgent(false)
    })
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    return run("Issue code", async () => {
      await jsonFetch("/api/agent-hub/referral-codes", { method: "POST", body: JSON.stringify(newCode) })
      setNewCode((prev) => ({ ...prev, code: "", label: "" }))
      setShowIssueCode(false)
    })
  }

  return (
    <div className="space-y-6">
      {(message || error) ? (
        <div className={`rounded-xl border p-4 text-sm font-semibold ${error ? "border-red-500/30 bg-red-500/10 text-[var(--cf-danger)]" : "border-emerald-500/30 bg-emerald-500/10 text-[var(--cf-success)]"}`}>
          {error ?? message}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setShowAddAgent((v) => !v)} className="rounded-lg border border-amber-400/30 px-4 py-2 text-sm font-semibold text-[var(--cf-warning)]">
          {showAddAgent ? "Cancel add agent" : "+ Add agent"}
        </button>
        <button type="button" onClick={() => setShowIssueCode((v) => !v)} className="rounded-lg border border-amber-400/30 px-4 py-2 text-sm font-semibold text-[var(--cf-warning)]">
          {showIssueCode ? "Cancel issue code" : "+ Issue code"}
        </button>
      </div>

      {showAddAgent || showIssueCode ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {showAddAgent ? (
            <form onSubmit={submitAgent} className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-5">
              <h2 className="font-semibold text-[var(--cf-text)]">Create approved agent + first code</h2>
              <p className="mt-1 text-xs text-gray-500">Use only after manual approval. Enter a referral code (kept tenant-unique and uppercase). To auto-generate a code instead, create the agent, then issue a code from the panel on the right.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <Field label="Display name" value={newAgent.displayName} onChange={(value) => setNewAgent((prev) => ({ ...prev, displayName: value }))} required />
                <Field label="Referral code" value={newAgent.code} onChange={(value) => setNewAgent((prev) => ({ ...prev, code: value.toUpperCase() }))} required />
                <Field label="Phone" value={newAgent.phone} onChange={(value) => setNewAgent((prev) => ({ ...prev, phone: value }))} />
                <Field label="Email" type="email" value={newAgent.email} onChange={(value) => setNewAgent((prev) => ({ ...prev, email: value }))} />
                <Select label="Channel" value={newAgent.channel} onChange={(value) => setNewAgent((prev) => ({ ...prev, channel: value }))} options={["FIELD", "SOCIAL", "STAFF", "PARTNER"]} />
                <Field label="Notes" value={newAgent.notes} onChange={(value) => setNewAgent((prev) => ({ ...prev, notes: value }))} />
              </div>
              <button disabled={busy !== null} className="mt-4 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-50">Create agent</button>
            </form>
          ) : null}

          {showIssueCode ? (
            <form onSubmit={submitCode} className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-5">
              <h2 className="font-semibold text-[var(--cf-text)]">Issue extra referral code</h2>
              <p className="mt-1 text-xs text-gray-500">For campaign-specific links or replacement codes. Leave code blank to auto-generate a unique code.</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Agent</span>
                  <select value={newCode.agentId} onChange={(event) => setNewCode((prev) => ({ ...prev, agentId: event.target.value }))} className="mt-1 w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]" required>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
                  </select>
                </label>
                <Field label="New code (optional)" value={newCode.code} onChange={(value) => setNewCode((prev) => ({ ...prev, code: value.toUpperCase() }))} />
                <Field label="Label" value={newCode.label} onChange={(value) => setNewCode((prev) => ({ ...prev, label: value }))} />
                <Field label="Campaign" value={newCode.campaign} onChange={(value) => setNewCode((prev) => ({ ...prev, campaign: value }))} />
              </div>
              <button disabled={busy !== null || !newCode.agentId} className="mt-4 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black disabled:opacity-50">Issue code</button>
            </form>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]">
        <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
          <h2 className="font-semibold text-[var(--cf-text)]">Operational controls</h2>
          <p className="mt-1 text-xs text-gray-500">Pause codes before retiring agents. Do not mark payable until the lead passed quality and payout checks.</p>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, email, phone, or code…"
            className="mt-3 w-full max-w-sm rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)] outline-none focus:border-amber-500"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[var(--cf-surface-soft)] text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-5 py-3">Agent</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Codes</th>
                <th className="px-5 py-3">Agent action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--cf-border-subtle)]">
              {filteredAgents.map((agent) => (
                <tr key={agent.id} className="align-top text-[var(--cf-text-secondary)]">
                  <td className="px-5 py-4"><div className="font-semibold text-[var(--cf-text)]">{agent.displayName}</div><div className="text-xs text-gray-500">{agent.channel} · {agent.email || agent.phone || "no contact"}</div></td>
                  <td className="px-5 py-4"><StatusBadge tone={agent.status === "ACTIVE" ? "green" : agent.status === "SUSPENDED" ? "amber" : "red"}>{agent.status}</StatusBadge></td>
                  <td className="px-5 py-4">
                    <div className="grid gap-2">
                      {agent.referralCodes.map((code) => (
                        <div key={code.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-2">
                          <span className="font-mono text-[var(--cf-warning)]">{code.code}</span>
                          <StatusBadge tone={code.status === "ACTIVE" ? "green" : code.status === "PAUSED" ? "amber" : "red"}>{code.status}</StatusBadge>
                          <button type="button" onClick={() => copyLink(code.code)} className="rounded border border-amber-400/30 px-2 py-1 text-xs text-[var(--cf-warning)]">{copied === code.code ? "Copied!" : "Copy link"}</button>
                          <button type="button" onClick={() => run(`Pause ${code.code}`, () => jsonFetch(`/api/agent-hub/referral-codes/${code.id}`, { method: "PATCH", body: JSON.stringify({ status: "PAUSED" }) }))} className="rounded border border-[var(--cf-border-subtle)] px-2 py-1 text-xs text-[var(--cf-text-secondary)]">Pause</button>
                          <button type="button" onClick={() => run(`Activate ${code.code}`, () => jsonFetch(`/api/agent-hub/referral-codes/${code.id}`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) }))} className="rounded border border-[var(--cf-border-subtle)] px-2 py-1 text-xs text-[var(--cf-text-secondary)]">Activate</button>
                          <button type="button" onClick={() => run(`Retire ${code.code}`, () => jsonFetch(`/api/agent-hub/referral-codes/${code.id}`, { method: "PATCH", body: JSON.stringify({ status: "RETIRED" }) }))} className="rounded border border-red-500/30 px-2 py-1 text-xs text-[var(--cf-danger)]">Retire</button>
                        </div>
                      ))}
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => run(`Suspend ${agent.displayName}`, () => jsonFetch(`/api/agent-hub/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ status: "SUSPENDED" }) }))} className="rounded border border-amber-500/30 px-2 py-1 text-xs text-[var(--cf-warning)]">Suspend</button>
                        <button type="button" onClick={() => run(`Activate ${agent.displayName}`, () => jsonFetch(`/api/agent-hub/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ status: "ACTIVE" }) }))} className="rounded border border-emerald-500/30 px-2 py-1 text-xs text-[var(--cf-success)]">Activate</button>
                      </div>
                      <CommissionRateEditor agentId={agent.id} initialBps={agent.commissionBps} busy={busy !== null} onSave={(bps) => run(`Set rate ${agent.displayName}`, () => jsonFetch(`/api/agent-hub/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ commissionBps: bps }) }))} />
                    </div>
                  </td>
                </tr>
              ))}
              {filteredAgents.length === 0 ? <tr><td colSpan={4} className="px-5 py-10 text-center text-gray-500">{agents.length === 0 ? "No agents yet." : "No agents match this search."}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Field({ label, value, onChange, required = false, type = "text" }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-gray-500">{label}</span>
      <input type={type} required={required} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)] outline-none focus:border-amber-500" />
    </label>
  )
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-gray-500">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]">
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

function CommissionRateEditor({ agentId, initialBps, busy, onSave }: { agentId: string; initialBps: number | null; busy: boolean; onSave: (bps: number | null) => void }) {
  const [pct, setPct] = useState(initialBps == null ? "" : String(initialBps / 100))
  const trimmed = pct.trim()
  const bps = trimmed === "" ? null : Math.round(Number(trimmed) * 100)
  const invalid = trimmed !== "" && (!Number.isFinite(Number(trimmed)) || Number(trimmed) < 0 || Number(trimmed) > 100)
  return (
    <div className="flex items-center gap-2" key={agentId}>
      <span className="text-[0.68rem] uppercase tracking-wide text-gray-500">Rate %</span>
      <input value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" placeholder="default"
        className="w-16 rounded border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-2 py-1 text-xs text-[var(--cf-text)] outline-none focus:border-amber-500" />
      <button type="button" disabled={busy || invalid} onClick={() => onSave(bps)}
        className="rounded border border-[var(--cf-border-subtle)] px-2 py-1 text-xs text-[var(--cf-text-secondary)] disabled:opacity-50">Save</button>
    </div>
  )
}
