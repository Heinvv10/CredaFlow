/**
 * Field readers shared by the asset-register and supplier input parsers. Each
 * reads one key of a request body into `out`, or records why it can't in
 * `errors`. An absent key is left out of `out` (a PATCH leaves it unchanged);
 * an explicit `null` or empty string clears an optional field.
 */

export type Fields = Record<string, unknown>
export type Errors = Record<string, string>

/** Largest value a Postgres INTEGER (Prisma `Int`) column holds. */
export const MAX_INT = 2_147_483_647

export function asRecord(body: unknown): Fields | null {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Fields) : null
}

export function readText(
  body: Fields, key: string, out: Fields, errors: Errors,
  opts: { required: boolean; nullable: boolean; max: number; upper?: boolean },
): void {
  if (!(key in body)) {
    if (opts.required) errors[key] = "is required"
    return
  }
  const raw = body[key]
  if (raw === null || raw === "") {
    if (opts.nullable) out[key] = null
    else errors[key] = "is required"
    return
  }
  if (typeof raw !== "string") {
    errors[key] = "must be text"
    return
  }
  const value = opts.upper ? raw.trim().toUpperCase() : raw.trim()
  if (value.length === 0) {
    if (opts.nullable) out[key] = null
    else errors[key] = "is required"
    return
  }
  if (value.length > opts.max) {
    errors[key] = `must be at most ${opts.max} characters`
    return
  }
  out[key] = value
}

export function readInt(
  body: Fields, key: string, out: Fields, errors: Errors,
  opts: { required: boolean; nullable: boolean; min: number; max: number },
): void {
  if (!(key in body)) {
    if (opts.required) errors[key] = "is required"
    return
  }
  const raw = body[key]
  if (raw === null || raw === "") {
    if (opts.nullable) out[key] = null
    else errors[key] = "is required"
    return
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < opts.min || raw > opts.max) {
    errors[key] = `must be a whole number from ${opts.min} to ${opts.max}`
    return
  }
  out[key] = raw
}

export function readEnum<T extends string>(
  body: Fields, key: string, out: Fields, errors: Errors,
  opts: { required: boolean; values: readonly T[] },
): void {
  if (!(key in body)) {
    if (opts.required) errors[key] = "is required"
    return
  }
  const match = opts.values.find((candidate) => candidate === body[key])
  if (!match) {
    errors[key] = `must be one of ${opts.values.join(", ")}`
    return
  }
  out[key] = match
}

export function readBool(body: Fields, key: string, out: Fields, errors: Errors): void {
  if (!(key in body)) return
  if (typeof body[key] !== "boolean") {
    errors[key] = "must be true or false"
    return
  }
  out[key] = body[key]
}
