import { Lock } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { EmptyState } from "@/components/app-shell/EmptyState"

// Where lib/auth-guards.ts sends a staff role that may not open a page. Inside
// the staff app, with its navigation, so the user is never dropped on the
// lender's public website. It shows nothing but this message, so it has no
// role gate of its own (one would loop back here for a role it refused); the
// dashboard layout still requires a staff session.
export default function NoAccessPage() {
  return (
    <>
      <Header title="You don't have access" />
      <div className="p-4 lg:p-8">
        <EmptyState
          icon={Lock}
          title="You don't have access to that page"
          description="Your role can't open it. If you need it for your work, ask an administrator to review your role."
          action={{ label: "Go to the dashboard", href: "/dashboard" }}
        />
      </div>
    </>
  )
}
