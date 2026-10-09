"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LayoutDashboard, Users, Coins, FileText } from "lucide-react"
import type { ReactNode } from "react"

// Panels are passed in as already-rendered server output so the tab shell stays
// presentational. Counts live in the labels, matching clients/[id].
export function AgentHubTabs({ defaultTab, agentCount, queueCount, overview, agents, commission, statements }: {
  defaultTab: string
  agentCount: number
  queueCount: number
  overview: ReactNode
  agents: ReactNode
  commission: ReactNode
  statements: ReactNode
}) {
  return (
    <Tabs defaultValue={defaultTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="overview" className="flex items-center gap-2"><LayoutDashboard className="h-4 w-4" />Overview</TabsTrigger>
        <TabsTrigger value="agents" className="flex items-center gap-2"><Users className="h-4 w-4" />Agents ({agentCount})</TabsTrigger>
        <TabsTrigger value="commission" className="flex items-center gap-2"><Coins className="h-4 w-4" />Commission ({queueCount})</TabsTrigger>
        <TabsTrigger value="statements" className="flex items-center gap-2"><FileText className="h-4 w-4" />Statements</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">{overview}</TabsContent>
      <TabsContent value="agents">{agents}</TabsContent>
      <TabsContent value="commission">{commission}</TabsContent>
      <TabsContent value="statements">{statements}</TabsContent>
    </Tabs>
  )
}
