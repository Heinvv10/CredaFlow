"use client"

import { useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusTab, type ChannelSettings } from "./StatusTab"
import { CloudApiTab } from "./CloudApiTab"
import { WhatsAppBridgeTab } from "./WhatsAppBridgeTab"
import { TemplatesTab, type WabaTemplateStatus } from "./TemplatesTab"
import type { WaBridgeSlot } from "@/lib/whatsapp-bridge-admin"

// Must stay in step with the TabsTrigger values below.
export const TAB_VALUES = ["status", "cloud", "bridge", "templates"] as const
export type WhatsAppTab = (typeof TAB_VALUES)[number]

/** ?tab=<value> deep-links a tab. Unknown values fall back to the default
 *  rather than rendering an empty panel. */
export function resolveWhatsAppTab(requested: string | null): WhatsAppTab {
  return (TAB_VALUES as readonly string[]).includes(requested ?? "")
    ? (requested as WhatsAppTab)
    : "status"
}

interface Props {
  waEnabled: boolean
  waSenderUrl: string | null
  wabaTemplates?: WabaTemplateStatus[]
  wabaPhoneNumberId?: string | null
  providers: string[]
  channel: ChannelSettings
  waBridgeNumbers: WaBridgeSlot[] | null
}

export function WhatsAppSettingsClient({
  waEnabled, waSenderUrl, wabaTemplates = [], wabaPhoneNumberId, providers, channel, waBridgeNumbers,
}: Props) {
  const initialTab = resolveWhatsAppTab(useSearchParams()?.get("tab") ?? null)

  return (
    <Tabs defaultValue={initialTab}>
      <TabsList>
        <TabsTrigger value="status">Status</TabsTrigger>
        <TabsTrigger value="cloud">Cloud API</TabsTrigger>
        <TabsTrigger value="bridge">Bridge</TabsTrigger>
        <TabsTrigger value="templates">Templates</TabsTrigger>
      </TabsList>

      <TabsContent value="status" className="pt-4">
        <StatusTab waEnabled={waEnabled} waSenderUrl={waSenderUrl} providers={providers} initial={channel} />
      </TabsContent>
      <TabsContent value="cloud" className="pt-4">
        <CloudApiTab waProvider={channel.waProvider} wabaPhoneNumberId={wabaPhoneNumberId} />
      </TabsContent>
      <TabsContent value="bridge" className="pt-4">
        <WhatsAppBridgeTab initial={waBridgeNumbers} />
      </TabsContent>
      <TabsContent value="templates" className="pt-4">
        <TemplatesTab wabaTemplates={wabaTemplates} />
      </TabsContent>
    </Tabs>
  )
}
