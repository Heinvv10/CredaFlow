/**
 * The upload form's fields (POST /api/asset-finance/valuation-guides,
 * multipart): the guide's name, its effective date and the provider that
 * reads it (default csv). The file itself is read by the provider.
 */
import { toDayNumber } from "@/lib/asset-finance/dates"

export interface GuideUploadFields { name: string; effectiveOn: string; provider: string }

export function parseGuideUploadFields(form: FormData): { data: GuideUploadFields } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const raw = (key: string) => {
    const value = form.get(key)
    return typeof value === "string" ? value : ""
  }
  const name = raw("name").trim()
  if (name.length < 1 || name.length > 100) errors.name = "must be 1 to 100 characters"
  const effectiveOn = raw("effectiveOn")
  try {
    toDayNumber(effectiveOn, "effectiveOn")
  } catch {
    errors.effectiveOn = "must be a calendar date YYYY-MM-DD"
  }
  const provider = raw("provider") || "csv"
  if (Object.keys(errors).length > 0) return { errors }
  return { data: { name, effectiveOn, provider } }
}
