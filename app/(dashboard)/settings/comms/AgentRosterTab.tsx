"use client"

import { useState } from "react"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import type { RosterMember } from "../../inbox/types"

export function AgentRosterTab({ initial }: { initial: RosterMember[] }) {
  const [members, setMembers] = useState<RosterMember[]>(initial)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function toggle(userId: string, isCommsAgent: boolean) {
    setBusyId(userId)
    setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, isCommsAgent } : m)))
    try {
      const res = await fetch("/api/inbox/roster", { method: "PATCH", body: JSON.stringify({ userId, isCommsAgent }) })
      if (!res.ok) setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, isCommsAgent: !isCommsAgent } : m)))
    } finally { setBusyId(null) }
  }

  return (
    <div className="space-y-2 pt-4">
      <p className="text-xs text-gray-400">Comms agents can open the inbox and be assigned conversations. Admins always have access.</p>
      {members.map((m) => (
        <div key={m.id} className="flex items-center justify-between rounded-md border border-gray-200 px-4 py-2">
          <div>
            <p className="font-medium text-gray-900">{m.name ?? m.email}</p>
            <p className="text-xs text-gray-400">{m.email} · <Badge className="bg-gray-100 text-gray-600">{m.role}</Badge></p>
          </div>
          <Switch checked={m.isCommsAgent} onCheckedChange={(v) => toggle(m.id, v)} disabled={busyId === m.id} />
        </div>
      ))}
    </div>
  )
}
