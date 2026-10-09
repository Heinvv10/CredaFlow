import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const stitchId = url.searchParams.get("id")
  const status = url.searchParams.get("status")

  if (stitchId) {
    const newStatus =
      status === "complete" ? "COMPLETED" : status === "failed" ? "FAILED" : "UNKNOWN"

    await prisma.stitchPaymentRequest
      .update({ where: { stitchId }, data: { status: newStatus } })
      .catch(() => {})
  }

  const redirectPath =
    status === "complete" ? "/portal/payment/success" : "/portal/payment/failure"

  // Emit a RELATIVE Location. A route handler's `req.url` is the container's
  // internal bind address (http://0.0.0.0:3300), so an absolute URL built from
  // it sends the payer's browser to an unreachable host after payment (PORT-01b;
  // same fix as app/api/auth/expired/route.ts). A relative path is resolved by
  // the browser against the public origin instead.
  return new NextResponse(null, { status: 307, headers: { Location: redirectPath } })
}
