"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { CannedReplyDTO } from "../../inbox/types"

export function CannedRepliesTab({ initial }: { initial: CannedReplyDTO[] }) {
  const [items, setItems] = useState<CannedReplyDTO[]>(initial)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const res = await fetch("/api/inbox/canned-replies")
    setItems(await res.json())
  }

  async function add() {
    if (title.trim() === "" || body.trim() === "") return
    setBusy(true)
    try {
      await fetch("/api/inbox/canned-replies", { method: "POST", body: JSON.stringify({ title, body }) })
      setTitle(""); setBody("")
      await refresh()
    } finally { setBusy(false) }
  }

  async function remove(id: string) {
    setBusy(true)
    try { await fetch(`/api/inbox/canned-replies/${id}`, { method: "DELETE" }); await refresh() } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="space-y-2 rounded-md border border-gray-200 p-4">
        <Input placeholder="Title (e.g. Greeting)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea placeholder="Reply body…" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
        <Button size="sm" onClick={add} disabled={busy || title.trim() === "" || body.trim() === ""}>Add canned reply</Button>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-gray-400">No canned replies yet.</p>
        ) : (
          items.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-3 rounded-md border border-gray-200 px-4 py-2">
              <div className="min-w-0">
                <p className="font-medium text-gray-900">{r.title}</p>
                <p className="truncate text-sm text-gray-500">{r.body}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => remove(r.id)} disabled={busy}>Delete</Button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
