import Link from "next/link"
import { XCircle } from "lucide-react"
import { getLenderIdentity } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = {
  title: "Payment Failed",
}

export default async function PaymentFailurePage() {
  const identity = await getLenderIdentity(await getResolvedTenantId())
  return (
    <div className="max-w-md mx-auto px-6 py-16 text-center">
      <XCircle className="h-16 w-16 mx-auto mb-6" style={{ color: "#DC2626" }} />
      <h1 className="text-2xl font-bold text-gray-900 mb-3">Payment Failed</h1>
      <p className="text-gray-600 leading-relaxed mb-8">
        Your payment could not be completed. No funds have been deducted. Please try again or
        use an alternative payment method.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          href="/portal/payment"
          className="inline-block px-6 py-3 rounded-lg font-semibold text-white text-sm"
          style={{ backgroundColor: "#4F46E5" }}
        >
          Try Again
        </Link>
        <a
          href={`mailto:${identity.publicEmail}`}
          className="inline-block px-6 py-3 rounded-lg font-semibold text-gray-700 text-sm border border-gray-200 hover:bg-gray-50"
        >
          Contact Support
        </a>
      </div>
      <p className="text-[11px] text-gray-400 mt-6">
        If you continue to experience issues, contact us at {identity.publicEmail} or {identity.publicPhone}.
      </p>
    </div>
  )
}
