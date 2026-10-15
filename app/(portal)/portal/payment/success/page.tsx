import Link from "next/link"
import { CheckCircle } from "lucide-react"
import { getT } from "@/lib/i18n/server"

export const metadata = {
  title: "Payment Initiated",
}

export default async function PaymentSuccessPage() {
  const t = await getT("portalPayment")
  return (
    <div className="max-w-md mx-auto px-6 py-16 text-center">
      <CheckCircle className="h-16 w-16 mx-auto mb-6" style={{ color: "#15803D" }} />
      <h1 className="text-2xl font-bold text-gray-900 mb-3">{t("initiatedTitle")}</h1>
      <p className="text-gray-600 leading-relaxed mb-2">
        {t("initiatedBody")}
      </p>
      <p className="text-sm text-gray-500 mb-8">
        {t("initiatedEmail")}
      </p>
      <Link
        href="/portal"
        className="inline-block px-6 py-3 rounded-lg font-semibold text-white text-sm"
        style={{ backgroundColor: "#4F46E5" }}
      >
        {t("backToOverview")}
      </Link>
    </div>
  )
}
