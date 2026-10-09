export interface PortalPollingDocument {
  id: string
  extractionStatus: string
}

export interface PortalPollingState {
  documents: PortalPollingDocument[]
}

type TimerHandle = ReturnType<typeof setTimeout>
type Schedule = (callback: () => void, delayMs: number) => TimerHandle
type Cancel = (timer: TimerHandle) => void
type DeleteRequest = (
  input: string,
  init: { method: "DELETE" },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

export function extractionIsInProgress(document: PortalPollingDocument): boolean {
  return document.extractionStatus === "pending" ||
    document.extractionStatus === "processing"
}

export async function deletePortalDocumentAndReconcile(args: {
  documentId: string
  request: DeleteRequest
  reconcile: () => void
}): Promise<{ ok: true } | { ok: false; error: string | null }> {
  const response = await args.request(
    `/api/documents/${args.documentId}`,
    { method: "DELETE" },
  )
  if (!response.ok) {
    // Surface the server's reason so the caller can tell the client WHY —
    // a silently dead Delete button reads as a broken app.
    let error: string | null = null
    try {
      const body = await response.json() as { error?: unknown } | null
      error = body && typeof body.error === "string" && body.error.trim() !== ""
        ? body.error
        : null
    } catch {
      error = null
    }
    return { ok: false, error }
  }

  // Keep documents and the derived KYC checklist on one authoritative
  // response. Reconciliation retries transient failures instead of applying a
  // partial local deletion that would leave the two projections contradictory.
  args.reconcile()
  return { ok: true }
}

/**
 * Owns extraction polling independently of React render timing.
 *
 * Failed refreshes are retried, active IDs are deduplicated, terminal/missing
 * documents stop polling, and dispose() guarantees that no timer survives an
 * unmount.
 */
export class PortalDocumentPoller {
  private readonly activeIds = new Set<string>()
  private timer: TimerHandle | null = null
  private refreshInFlight = false
  private reconciliationRequested = 0
  private reconciliationCompleted = 0
  private disposed = false

  constructor(
    private readonly refresh: () => Promise<PortalPollingState | null>,
    private readonly intervalMs = 3_000,
    // Browser timer functions are receiver-sensitive Web APIs. Storing the
    // native functions directly and later invoking `this.schedule(...)`
    // supplies the poller as their receiver, which Chromium rejects with
    // `TypeError: Illegal invocation`. Arrow wrappers keep the native call on
    // globalThis while preserving injectable timers for deterministic tests.
    private readonly schedule: Schedule = (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    private readonly cancel: Cancel = (timer) =>
      globalThis.clearTimeout(timer),
  ) {}

  sync(documents: readonly PortalPollingDocument[]): void {
    const nextActiveIds = new Set(
      documents
        .filter(extractionIsInProgress)
        .map(({ id }) => id),
    )
    const discoveredWork = [...nextActiveIds].some(
      (documentId) => !this.activeIds.has(documentId),
    )

    this.activeIds.clear()
    for (const documentId of nextActiveIds) {
      this.activeIds.add(documentId)
    }

    if (!this.hasWork()) {
      this.cancelScheduledRefresh()
    } else if (discoveredWork) {
      this.refreshNow()
    }
  }

  start(documentId: string): void {
    if (this.disposed || this.activeIds.has(documentId)) return
    this.activeIds.add(documentId)
    this.refreshNow()
  }

  /**
   * Discover documents created by an upload before their IDs exist in local
   * state. A null/failed refresh is retried until one successful response
   * reconciles the list and starts normal serialized polling.
   */
  reconcile(): void {
    if (this.disposed) return
    this.reconciliationRequested += 1
    this.refreshNow()
  }

  isActive(documentId: string): boolean {
    return this.activeIds.has(documentId)
  }

  isReconciling(): boolean {
    return this.reconciliationCompleted < this.reconciliationRequested
  }

  dispose(): void {
    this.disposed = true
    this.cancelScheduledRefresh()
    this.activeIds.clear()
    this.reconciliationCompleted = this.reconciliationRequested
  }

  private hasWork(): boolean {
    return this.activeIds.size > 0 || this.isReconciling()
  }

  private cancelScheduledRefresh(): void {
    if (this.timer === null) return
    this.cancel(this.timer)
    this.timer = null
  }

  private refreshNow(): void {
    if (this.disposed || this.refreshInFlight || !this.hasWork()) return
    this.cancelScheduledRefresh()
    void this.runRefresh()
  }

  private scheduleRefresh(): void {
    if (
      this.disposed ||
      this.refreshInFlight ||
      !this.hasWork() ||
      this.timer !== null
    ) {
      return
    }
    this.timer = this.schedule(() => {
      this.timer = null
      this.refreshNow()
    }, this.intervalMs)
  }

  private replaceActiveDocuments(
    documents: readonly PortalPollingDocument[],
  ): void {
    this.activeIds.clear()
    for (const document of documents) {
      if (extractionIsInProgress(document)) {
        this.activeIds.add(document.id)
      }
    }
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed || this.refreshInFlight || !this.hasWork()) return
    this.refreshInFlight = true
    const reconciliationTarget = this.reconciliationRequested
    let state: PortalPollingState | null
    try {
      state = await this.refresh()
    } catch {
      state = null
    }
    this.refreshInFlight = false

    if (this.disposed) {
      return
    }
    if (!state) {
      this.scheduleRefresh()
      return
    }

    this.replaceActiveDocuments(state.documents)
    this.reconciliationCompleted = Math.max(
      this.reconciliationCompleted,
      reconciliationTarget,
    )

    if (this.isReconciling()) {
      // An upload/delete completed while this request was already in flight.
      // Refresh again before entering the normal polling interval so that the
      // later mutation cannot be lost behind the older response.
      this.refreshNow()
      return
    }
    this.scheduleRefresh()
  }
}
