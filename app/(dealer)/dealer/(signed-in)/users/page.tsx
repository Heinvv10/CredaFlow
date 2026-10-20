import { DealerPageTitle } from "@/components/dealer/DealerShell"
import { DealerUsersPanel } from "@/components/dealer/DealerUsersPanel"
import { requireDealerPage } from "@/lib/dealer/page-guard"
import { listDealerUsers } from "@/lib/dealer/users"

export const dynamic = "force-dynamic"

// DEALER_ADMIN only: the dealer's users. A sales user sees 404.
export default async function DealerUsersPage() {
  const actor = await requireDealerPage({ admin: true })
  const users = await listDealerUsers(actor)
  return (
    <>
      <DealerPageTitle title="Users" subtitle="Add your sales team and pass each person their one-time link. Deactivating a user signs them out at once." />
      <DealerUsersPanel users={users} selfId={actor.dealerUserId} />
    </>
  )
}
