import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { getT } from "@/lib/i18n/server"

// Portal-scoped 404. Rendered inside the portal shell (via app/(portal)/layout.tsx)
// for signed-in clients, so a mistyped /portal/* URL no longer falls through to
// the marketing 404 with "Login / Apply Now". Triggered by notFound() from the
// /portal/* catch-all route.
export default async function PortalNotFound() {
  const t = await getT("portalApplications")
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="text-sm font-semibold uppercase tracking-[0.28em]" style={{ color: "#4338CA" }}>
        {t("notFoundEyebrow")}
      </p>
      <p className="mt-6 text-7xl font-bold text-gray-900">404</p>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">{t("notFoundTitle")}</h1>
      <p className="mt-3 text-gray-500">
        {t("notFoundBody")}
      </p>
      <Link
        href="/portal"
        className="mt-8 inline-flex items-center gap-2 rounded-md px-5 py-2.5 text-sm font-semibold text-white"
        style={{ backgroundColor: "#4338CA" }}
      >
        <ArrowLeft className="h-4 w-4" />
        {t("notFoundBack")}
      </Link>
    </div>
  )
}
