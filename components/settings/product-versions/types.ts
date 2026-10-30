import type { ProductEngineOverview } from "@/lib/product-engine/overview"
import type { ChangeRow } from "@/components/settings/decision-rules/types"

export type { ChangeRow }
export { api, controlClass } from "@/components/settings/decision-rules/types"

export type EngineOverview = Omit<ProductEngineOverview, "requests"> & { requests: ChangeRow[]; canManage: boolean; canApprove: boolean }
export type ProductRow = EngineOverview["products"][number]
export type VersionRow = EngineOverview["versions"][number]
export type RuleRow = EngineOverview["rules"][number]
