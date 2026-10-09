import PortalRegisterForm from "./PortalRegisterForm"
import { WebsiteAnalytics } from "@/components/analytics/WebsiteAnalytics"

export const metadata = { title: "Create client portal account" }

export default function PortalRegisterPage() {
  return (
    <>
      {/* Register is the pre-auth tail of the public acquisition funnel, so it
          loads the same analytics bootstrap as the marketing site (this route
          sits outside the (website) group and would otherwise have no _paq).
          customUrl pins the reported URL to the bare path: this route is reached
          via /portal/register?email=…&reference=… deep links, and that email is
          PII that must never reach a third-party analytics tracker. */}
      <WebsiteAnalytics customUrl="/portal/register" />
      <PortalRegisterForm />
    </>
  )
}
