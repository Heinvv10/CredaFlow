export function parseCommissionBps(
  raw: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 10000) {
    return { ok: false }
  }
  return { ok: true, value: raw }
}
