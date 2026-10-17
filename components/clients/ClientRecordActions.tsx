import Link from "next/link"
import { Edit, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { hasMinRole, type UserRole } from "@/lib/permissions"

/** The same CREDIT_OFFICER floor used by client updates and application creation. */
export function ClientRecordActions({ role, clientId }: { role: UserRole | null; clientId: string }) {
  if (!role || !hasMinRole(role, "CREDIT_OFFICER")) return null
  return <>
    <Link href={`/applications/new?clientId=${clientId}`}><Button><Plus className="h-4 w-4 mr-2" />New Application</Button></Link>
    <Link href={`/clients/${clientId}/edit`}><Button variant="outline"><Edit className="h-4 w-4 mr-2" />Edit</Button></Link>
  </>
}
