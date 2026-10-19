import { DealerShell } from "@/components/dealer/DealerShell"
import { requireDealerPage } from "@/lib/dealer/page-guard"
import { loadDealerProfile } from "@/lib/dealer/users"

export const dynamic = "force-dynamic"

export const metadata = { title: "Dealer portal" }

// Every page below repeats requireDealerPage itself: a page renders in
// parallel with its layout, so this one gates the frame, not the data.
export default async function DealerPortalLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireDealerPage()
  const profile = await loadDealerProfile(actor)
  return (
    <DealerShell
      user={{ email: actor.email, name: profile?.name ?? actor.name ?? actor.email, admin: actor.dealerRole === "DEALER_ADMIN" }}
      dealerName={profile?.dealer.name ?? ""}
    >
      {children}
    </DealerShell>
  )
}
