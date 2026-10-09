/**
 * What the public website shows while the tenant's lender identity is not
 * configured: no lender name, number or contact detail, because the only
 * values that could be shown would be another lender's.
 */
export function WebsiteNotConfigured() {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-[#11141b] px-4 text-white">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold">This website is not set up yet</h1>
        <p className="mt-3 text-sm leading-relaxed text-white/70">
          The credit provider&apos;s details have not been configured. Please check back later.
        </p>
      </div>
    </main>
  )
}
