import Link from "next/link"
import { headers } from "next/headers"
import { ArrowRight } from "lucide-react"
import { normaliseHost, staffAppHost } from "@/lib/config/deployment-urls"

// Root not-found handler. Catches every unmatched URL across the apex
// (e.g. a mistyped marketing link), which a not-found.tsx scoped inside the
// (website) route group would not — that only fires for notFound() calls
// within the group. It renders no site chrome: the nav and footer print the
// tenant's identity, which this handler (reached on any host, before any
// tenant is known) does not have.
//
// On the staff workspace host (STAFF_APP_HOST) the same handler answers for an
// unmatched staff URL, so it shows a way back to the dashboard instead of the
// public site's "Apply online" / "Check if I qualify" links.
export default async function NotFound() {
  const staffHost = staffAppHost()
  const host = normaliseHost((await headers()).get("host") ?? "")
  const isStaffHost = staffHost !== null && host === staffHost
  return (
    <div className="flex min-h-screen flex-col bg-[#11141b] text-white">
      <main className="flex flex-1 items-center justify-center px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
            Page not found
          </p>
          <h1 className="text-white">
            <span className="mt-6 block text-7xl font-semibold tracking-tight sm:text-8xl">404</span>
            <span className="mt-6 block text-3xl font-semibold tracking-tight sm:text-4xl">
              We couldn&apos;t find that page.
            </span>
          </h1>
          <p className="mt-5 text-lg leading-8 text-white/66">
            {isStaffHost
              ? "The page you were looking for may have moved or no longer exists."
              : "The page you were looking for may have moved or no longer exists. Here are a few good places to pick up from."}
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href={isStaffHost ? "/dashboard" : "/"}
              className="inline-flex items-center justify-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-semibold text-[#11141b] transition-colors hover:bg-[#c7d2fe]"
            >
              {isStaffHost ? "Back to dashboard" : "Back to home"}
              <ArrowRight className="h-4 w-4" />
            </Link>
            {!isStaffHost && (<>
            <Link
              href="/site/apply"
              className="inline-flex items-center justify-center border border-[#a5b4fc]/70 px-5 py-3 text-sm font-semibold text-[#a5b4fc] transition-colors hover:bg-[#a5b4fc]/10"
            >
              Apply online
            </Link>
            <Link
              href="/site/qualify"
              className="inline-flex items-center justify-center px-5 py-3 text-sm font-medium text-white/72 transition-colors hover:text-white"
            >
              Check if I qualify
            </Link>
            </>)}
          </div>
        </div>
      </main>
    </div>
  )
}
