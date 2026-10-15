import { StatusPill } from "@/components/app-shell/StatusPill"
import { ASSET_FINANCE_ROLES, DEFAULT_ACCOUNTS } from "@/lib/accounting/accounts"

/** Which asset-finance accounts the confirmed mapping covers: a month that posts one it does not cover is refused. */
export function ConfirmedRoles({ confirmed, mappingConfirmed }: { confirmed: string[]; mappingConfirmed: boolean }) {
  const missing = ASSET_FINANCE_ROLES.filter((role) => !mappingConfirmed || !confirmed.includes(role))
  const covered = ASSET_FINANCE_ROLES.length - missing.length
  return (
    <div className="space-y-2" aria-label="Asset-finance accounts confirmed">
      <p className="flex flex-wrap items-center gap-2 text-[var(--cf-text)]">
        Asset-finance accounts:
        <StatusPill tone={missing.length === 0 ? "success" : "warning"}>{covered} of {ASSET_FINANCE_ROLES.length} confirmed</StatusPill>
      </p>
      {missing.length > 0 && (
        <p className="break-words text-xs text-[var(--cf-text-muted)]">
          Not yet confirmed: {missing.map((role) => DEFAULT_ACCOUNTS[role].name).join(", ")}. A month that posts one of these closes only after the mapping is confirmed again.
        </p>
      )}
    </div>
  )
}
