import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

const noStoreHeaders = { "Cache-Control": "no-store" }

function deployMetadata() {
  return {
    mode: process.env.APP_MODE || "all",
    commit:
      process.env.GIT_SHA ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
      "unknown",
    builtAt: process.env.BUILD_TIME || process.env.BUILT_AT || "unknown",
    checkedAt: new Date().toISOString(),
  }
}

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json(
      { status: "ok", ...deployMetadata() },
      { headers: noStoreHeaders },
    )
  } catch {
    return NextResponse.json(
      { status: "error", ...deployMetadata() },
      { status: 503, headers: noStoreHeaders },
    )
  }
}
