import ResetPasswordForm from "@/components/auth/ResetPasswordForm"

// The page an operator user's invite or reset link opens. The token in the
// link is the credential (/api/auth/reset-password); there is no
// self-service request for a new one.
export const dynamic = "force-dynamic"

export const metadata = { title: "Set your password" }

export default function OperatorSetPasswordPage() {
  return <ResetPasswordForm brandName="CredaFlow operator console" loginHref="/operator/login" requestNewHref={null} />
}
