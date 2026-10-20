"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, SelectField, TextField, sendJson } from "@/components/asset-finance/register-form-controls"
import { OneTimeLink } from "./OneTimeLink"

type Role = "DEALER_ADMIN" | "DEALER_SALES"

/** Adds a dealer user (the first one is its dealer admin) and shows its one-time set-password link. */
export function DealerUserForm({ dealerId, first }: { dealerId: string; first: boolean }) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>(first ? "DEALER_ADMIN" : "DEALER_SALES")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    setError(null)
    setFields({})
    setLink(null)
    const result = await sendJson(`/api/asset-finance/dealers/${dealerId}/users`, "POST", { email, name, role })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      setFields(result.fields)
      return
    }
    const body = result.body as { setPasswordUrl: string; expiresAt: string }
    setLink({ url: body.setPasswordUrl, expiresAt: body.expiresAt })
    setEmail(""); setName("")
    router.refresh()
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--cf-border-subtle)] p-4">
      <h3 className="text-sm font-semibold text-[var(--cf-text)]">{first ? "Add the first dealer admin" : "Add a dealer user"}</h3>
      {link && <OneTimeLink url={link.url} expiresAt={link.expiresAt} />}
      <FormError message={error} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <TextField id="du-name" label="Name" required value={name} onChange={setName} error={fields.name} />
        <TextField id="du-email" label="Email" type="email" required value={email} onChange={setEmail} error={fields.email} />
        <SelectField id="du-role" label="Role" value={role} onChange={setRole}
          options={{ DEALER_ADMIN: "Dealer admin (manages its users)", DEALER_SALES: "Sales" }} error={fields.role} />
      </div>
      <Button size="sm" onClick={submit} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        Add user
      </Button>
    </div>
  )
}
