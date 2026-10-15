import { Badge } from "@/components/ui/badge"

const VARIANT = { ACTIVE: "success", SUSPENDED: "danger", PROVISIONING: "warning" } as const

export function TenantStatusBadge({ status }: { status: keyof typeof VARIANT }) {
  return <Badge variant={VARIANT[status]}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>
}
