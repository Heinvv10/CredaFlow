// THE canonical JSON serialisation for value-equality checks and persisted
// digests. PostgreSQL jsonb does not preserve key order (keys sort by length
// then bytewise), so JSON.stringify equality against a stored row fails even
// when every value is identical — that shape of bug breaks PASQ verification
// and has siblings elsewhere. Key order here is
// UTF-16 code-unit order (Array.prototype.sort default): locale-independent
// and stable across machines, which matters because these strings feed
// persisted sha256 digests. Never sort with localeCompare here.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
