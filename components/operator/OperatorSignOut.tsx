"use client"

import { signOut } from "next-auth/react"
import { Button } from "@/components/ui/button"

export function OperatorSignOut() {
  return (
    <Button size="sm" variant="outline" onClick={() => signOut({ callbackUrl: "/operator/login" })}>
      Sign out
    </Button>
  )
}
