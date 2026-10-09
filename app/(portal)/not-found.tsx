import Link from "next/link"
import { ArrowLeft } from "lucide-react"

// Portal-scoped 404. Rendered inside the portal shell (via app/(portal)/layout.tsx)
// for signed-in clients, so a mistyped /portal/* URL no longer falls through to
// the marketing 404 with "Login / Apply Now". Triggered by notFound() from the
// /portal/* catch-all route.
export default function PortalNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="text-sm font-semibold uppercase tracking-[0.28em]" style={{ color: "#4338CA" }}>
        Page not found
      </p>
      <p className="mt-6 text-7xl font-bold text-gray-900">404</p>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">We couldn&apos;t find that page</h1>
      <p className="mt-3 text-gray-500">
        The page you were looking for may have moved or no longer exists.
      </p>
      <Link
        href="/portal"
        className="mt-8 inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold text-white"
        style={{ backgroundColor: "#4338CA" }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to my portal
      </Link>
    </div>
  )
}
