"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

type ApplicationCancelButtonProps = {
  applicationId: string
}

export function ApplicationCancelButton({ applicationId }: ApplicationCancelButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function cancelApplication() {
    if (!confirm("Cancel this application? It will remain in the audit trail as cancelled.")) return
    setLoading(true)
    try {
      const res = await fetch(`/api/applications/${applicationId}`, { method: "DELETE" })
      const data = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? "Failed to cancel application")
      toast.success("Application cancelled")
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to cancel application")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button type="button" variant="outline" onClick={cancelApplication} disabled={loading}>
      <XCircle className="h-4 w-4" />
      {loading ? "Cancelling..." : "Cancel Application"}
    </Button>
  )
}
