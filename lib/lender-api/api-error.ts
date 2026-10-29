import { NextResponse } from "next/server"

/** The /api/v1 error body: `{ error: { code, message } }`. */
export function apiError(status: number, code: string, message: string, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers })
}
