"use client"

import { useCallback, useState } from "react"
import { AccountingSettingsPanel } from "./AccountingSettingsPanel"
import { AccountingExportPanel } from "./AccountingExportPanel"
import { AccountMappingEditor } from "./AccountMappingEditor"

/** Settings, mapping and the preview share one invalidation boundary. The server still authorizes every close. */
export function AccountingWorkspace({ initialPeriod, canAdmin, locked, xeroConnected, isaflowConnected }: { initialPeriod: string; canAdmin: boolean; locked: boolean; xeroConnected: boolean; isaflowConnected: boolean }) {
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false)
  const [closing, setClosing] = useState(false)
  const [period, setPeriod] = useState(initialPeriod)
  const [hasClosed, setHasClosed] = useState(locked)
  const start = useCallback(() => { setPending(true); setRevision(r => r + 1) }, [])
  const end = useCallback(() => { setPending(false); setRevision(r => r + 1) }, [])
  const saved = useCallback((goLiveMonth?: string) => { if (goLiveMonth) setPeriod(goLiveMonth) }, [])
  const closed = useCallback(() => setHasClosed(true), [])
  return <>
    <AccountingSettingsPanel canEdit={canAdmin} locked={hasClosed} revision={revision} mutationPending={pending || closing} onMutationStart={start} onMutationEnd={end} onSaved={saved} />
    <AccountingExportPanel initialPeriod={period} canClose={canAdmin} xeroConnected={xeroConnected} isaflowConnected={isaflowConnected} revision={revision} settingsBusy={pending} onClosed={closed} onMutationStart={() => setClosing(true)} onMutationEnd={() => setClosing(false)} />
    <AccountMappingEditor canEdit={canAdmin} mutationPending={pending || closing} onMutationStart={start} onMutationEnd={end} />
  </>
}
