import { NextResponse } from "next/server"

/**
 * Where Stitch sends the payer's browser after payment. Display only: it
 * writes nothing. The query string is the browser's, so anyone can call this
 * with any id and status; a status written from here would let a caller mark
 * another client's request COMPLETED, and the signed webhook would then see
 * the request already settled and book no Payment for money Stitch did move.
 * Settlement happens only in the signed webhook (../webhook/route.ts).
 */
export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status")

  // The success page says the payment is submitted and will be allocated once
  // confirmed — true whether or not the webhook has arrived yet.
  const redirectPath =
    status === "complete" ? "/portal/payment/success" : "/portal/payment/failure"

  // Emit a RELATIVE Location. A route handler's `req.url` is the container's
  // internal bind address (http://0.0.0.0:3300), so an absolute URL built from
  // it sends the payer's browser to an unreachable host after payment (PORT-01b;
  // same fix as app/api/auth/expired/route.ts). A relative path is resolved by
  // the browser against the public origin instead.
  return new NextResponse(null, { status: 307, headers: { Location: redirectPath } })
}
