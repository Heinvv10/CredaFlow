import LoginForm from "@/components/auth/LoginForm"

// The operator console's sign-in (OPERATOR_APP_HOST only: lib/proxy/operator-host.ts).
// No lender brand: the console belongs to no lender.
export const dynamic = "force-dynamic"

export const metadata = { title: "Operator sign-in" }

export default function OperatorLoginPage() {
  return <LoginForm variant="operator" brandName="CredaFlow" crossLink={null} />
}
