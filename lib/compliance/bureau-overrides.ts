import { AppStatus, Prisma } from "@prisma/client"

const APP_STATUS_VALUES = new Set<AppStatus>(Object.values(AppStatus))

export type BureauOverrideFilter = {
  from: Date | null
  to: Date | null
  status: AppStatus | null
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isFinite(d.getTime()) ? d : null
}

export function parseFilter(searchParams: URLSearchParams): BureauOverrideFilter {
  const fromRaw = parseDate(searchParams.get("from"))
  // `from` is inclusive on the calendar day: truncate to UTC midnight so any mid-day timestamp
  // (e.g. hand-crafted URL) doesn't silently exclude overrides stamped earlier that day.
  const from =
    fromRaw === null
      ? null
      : new Date(Date.UTC(fromRaw.getUTCFullYear(), fromRaw.getUTCMonth(), fromRaw.getUTCDate()))

  const toRaw = parseDate(searchParams.get("to"))
  // `to` is inclusive on the calendar day: truncate to UTC midnight first, then +24h so any
  // mid-day timestamp (e.g. hand-crafted URL) still lands at the correct exclusive bound.
  const to =
    toRaw === null
      ? null
      : new Date(
          Date.UTC(toRaw.getUTCFullYear(), toRaw.getUTCMonth(), toRaw.getUTCDate()) +
            24 * 60 * 60 * 1000,
        )

  const statusRaw = searchParams.get("status")
  const status =
    statusRaw && APP_STATUS_VALUES.has(statusRaw as AppStatus) ? (statusRaw as AppStatus) : null

  return { from, to, status }
}

export function buildWhere(
  tenantId: string,
  filter: BureauOverrideFilter,
): Prisma.LoanApplicationWhereInput {
  const bureauOverrideAt: Prisma.DateTimeNullableFilter = { not: null }
  if (filter.from) bureauOverrideAt.gte = filter.from
  if (filter.to) bureauOverrideAt.lt = filter.to

  const where: Prisma.LoanApplicationWhereInput = {
    tenantId,
    bureauOverrideAt,
  }
  if (filter.status) where.status = filter.status
  return where
}
