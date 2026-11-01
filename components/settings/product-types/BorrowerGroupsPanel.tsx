"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, controlClass } from "@/components/settings/decision-rules/types"

interface GroupRow {
  id: string
  name: string
  members: Array<{ id: string; name: string; idNumber: string }>
}

const idNumbers = (text: string) => text.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)

function GroupCard({ group }: { group: GroupRow }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(group.members.map((m) => m.idNumber).join("\n"))
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    const res = await api(`/api/products/groups/${group.id}`, "PUT", { memberIdNumbers: idNumbers(text) })
    if (!res.ok) return setError(res.error ?? "Could not save.")
    setEditing(false)
    router.refresh()
  }

  return (
    <Card>
      <CardHeader><CardTitle>{group.name}</CardTitle><CardDescription>{group.members.length} members</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        <ul className="text-sm">{group.members.map((m) => <li key={m.id}>{m.name} <span className="text-[var(--cf-text-muted)]">({m.idNumber})</span></li>)}</ul>
        {editing && <textarea aria-label={`Members of ${group.name}`} rows={4} className={`${controlClass} h-auto w-full py-2`} value={text} onChange={(e) => setText(e.target.value)} />}
        {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
        <Button size="sm" variant="ghost" onClick={() => (editing ? void save() : setEditing(true))}>{editing ? "Save members" : "Change members"}</Button>
      </CardContent>
    </Card>
  )
}

/** Lending groups and their members, named by the ID numbers of the lender's existing clients. */
export function BorrowerGroupsPanel({ groups }: { groups: GroupRow[] }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [members, setMembers] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setError(null)
    const res = await api("/api/products/groups", "POST", { name, memberIdNumbers: idNumbers(members) })
    if (!res.ok) return setError(res.error ?? "Could not create the group.")
    setName("")
    setMembers("")
    router.refresh()
  }

  return (
    <>
      <Card>
        <CardHeader><CardTitle>New lending group</CardTitle><CardDescription>At least two members, each an existing client.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1"><Label htmlFor="bg-name">Group name</Label><Input id="bg-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="bg-members">Members&apos; ID numbers, one per line</Label><textarea id="bg-members" rows={3} className={`${controlClass} h-auto w-full py-2`} value={members} onChange={(e) => setMembers(e.target.value)} /></div>
          {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
          <Button onClick={create}>Create group</Button>
        </CardContent>
      </Card>
      {groups.map((group) => <GroupCard key={group.id} group={group} />)}
    </>
  )
}
