import { NextResponse } from "next/server"

// An unknown /api/* path used to fall through to the App Router's HTML
// not-found rendering, which surfaces as a 500 to API callers. Route
// resolution prefers static and dynamic segments over this catch-all, so
// every real endpoint still wins; only genuinely unmatched API paths land
// here and get a proper JSON 404.
function unmatched() {
  return NextResponse.json({ error: "Not found" }, { status: 404 })
}

export {
  unmatched as GET,
  unmatched as POST,
  unmatched as PUT,
  unmatched as PATCH,
  unmatched as DELETE,
  unmatched as HEAD,
  unmatched as OPTIONS,
}
