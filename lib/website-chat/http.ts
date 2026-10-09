/** Parse a request body as a plain JSON object, or null if it is anything else. */
export async function readJsonObject(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null)
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
}

/** POPIA: never log a whole error object; Prisma errors carry visitor names, phones and message text. */
export function safeErrorInfo(error: unknown): { message?: string; name?: string; code?: unknown } {
  const code = (error as { code?: unknown } | null)?.code
  // Prisma messages embed the query arguments (names, phones), so log only the class and code.
  if (error instanceof Error && error.name.startsWith("PrismaClient")) return { name: error.name, code }
  const message = error instanceof Error ? error.message : String(error)
  return code === undefined ? { message } : { message, code }
}
