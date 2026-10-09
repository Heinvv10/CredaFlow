"use client"

import { PageHeader } from "@/components/app-shell/PageHeader"
import type { Crumb } from "@/lib/nav/breadcrumbs"

interface HeaderProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  breadcrumbs?: Crumb[]
}

/**
 * No bell here, deliberately. The real NotificationBell lives in AppTopbar,
 * which wraps every page this Header appears on, so a second one was always a
 * duplicate — and it was inert: no onClick, no href, and an unconditional
 * danger dot that claimed unread notifications whether or not any existed.
 */
export function Header({ title, subtitle, actions, breadcrumbs }: HeaderProps) {
  return (
    <PageHeader
      eyebrow="Workspace"
      title={title}
      description={subtitle}
      breadcrumbs={breadcrumbs}
      actions={actions}
    />
  )
}
