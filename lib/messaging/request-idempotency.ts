const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseMessageOperationId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const operationId = value.trim()
  return OPERATION_ID_PATTERN.test(operationId) ? operationId.toLowerCase() : null
}

export function messageOperationIdempotencyKey(
  scope: string,
  operationId: string | undefined,
): string | undefined {
  if (operationId === undefined) return undefined
  const parsed = parseMessageOperationId(operationId)
  if (!parsed) throw new Error("Invalid message operation id")
  return `${scope}:${parsed}`
}
