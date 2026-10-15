import { requireOperatorPage } from "@/lib/operator/console-auth"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { CreateLenderForm } from "@/components/operator/CreateLenderForm"
import { FEATURE_COLUMNS } from "@/scripts/lender/tenant-config"
import { LENDER_IDENTITY_FIELDS, STATUTORY_FIELDS } from "@/lib/config/identity-schema"
import { DEFAULT_TENANT_COLOURS } from "@/lib/theme/tenant-colours"

export const dynamic = "force-dynamic"

// Provision a lender (OPERATOR_ADMIN): the same fields, rules and create path
// as `npm run lender:bootstrap-tenant`, plus the first SUPER_ADMIN's invite.
export default async function NewLenderPage() {
  await requireOperatorPage({ admin: true })
  return (
    <>
      <OperatorPageTitle
        title="New lender"
        subtitle="Creates the lender, its branding and modules, and emails its first SUPER_ADMIN a link to set a password. You never see that password."
      />
      <CreateLenderForm
        features={Object.entries(FEATURE_COLUMNS).map(([key, [, on]]) => ({ key, on }))}
        identityFields={[...LENDER_IDENTITY_FIELDS]}
        statutoryFields={[...STATUTORY_FIELDS]}
        defaultColours={{ ...DEFAULT_TENANT_COLOURS }}
      />
    </>
  )
}
