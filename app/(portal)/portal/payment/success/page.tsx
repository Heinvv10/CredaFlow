import Link from "next/link"
import { CheckCircle } from "lucide-react"

export const metadata = {
  title: "Payment Initiated",
}

export default function PaymentSuccessPage() {
  return (
    <div className="max-w-md mx-auto px-6 py-16 text-center">
      <CheckCircle className="h-16 w-16 mx-auto mb-6" style={{ color: "#15803D" }} />
      <h1 className="text-2xl font-bold text-gray-900 mb-3">Payment Initiated</h1>
      <p className="text-gray-600 leading-relaxed mb-2">
        Your payment has been submitted via Stitch. It will be allocated to your loan account once the
        bank transfer is confirmed — this typically takes a few minutes.
      </p>
      <p className="text-sm text-gray-500 mb-8">
        You will receive an email confirmation once the payment is received.
      </p>
      <Link
        href="/portal"
        className="inline-block px-6 py-3 rounded-lg font-semibold text-white text-sm"
        style={{ backgroundColor: "#4F46E5" }}
      >
        Back to Overview
      </Link>
    </div>
  )
}
