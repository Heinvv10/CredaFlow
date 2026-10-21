/** Whether `error` is the database guard's refusal with this exact sentence (SQLSTATE 23514, raised by a trigger). */
export function isDbRefusal(error: unknown, sentence: string): boolean {
  return error instanceof Error && error.message.includes(sentence)
}
