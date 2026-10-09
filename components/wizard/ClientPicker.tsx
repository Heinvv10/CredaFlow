import type { Client } from "./types"

const INP =
  "w-full bg-[var(--cf-bg-raised)] border border-[var(--cf-border-subtle)] rounded-lg px-3 py-2.5 text-sm text-[var(--cf-text)] focus:outline-none focus:ring-2 focus:ring-[var(--cf-brand)]/30 focus:border-[var(--cf-brand)]"
const LBL = "block text-xs font-semibold text-[var(--cf-text-secondary)] mb-1.5"

interface Props {
  clients: Client[]
  selectedClientId: string
  clientSearch: string
  setClientSearch: (v: string) => void
  onSelect: (clientId: string) => void
}

export function ClientPicker({
  clients,
  selectedClientId,
  clientSearch,
  setClientSearch,
  onSelect,
}: Props) {
  const selectedClient = clients.find((c) => c.id === selectedClientId) ?? null

  const filteredClients =
    clientSearch.trim().length < 2
      ? []
      : clients
          .filter((c) => {
            const q = clientSearch.toLowerCase()
            return (
              c.email.toLowerCase().includes(q) ||
              c.firstName.toLowerCase().includes(q) ||
              c.lastName.toLowerCase().includes(q)
            )
          })
          .slice(0, 8)

  return (
    <div className="bg-[var(--cf-bg-panel)] border border-[var(--cf-border-subtle)] rounded-2xl p-5 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        Client
      </p>

      {selectedClient ? (
        <div className="flex items-center justify-between p-3 bg-[var(--cf-bg-raised)] border border-[var(--cf-brand)]/30 rounded-xl">
          <div>
            <p className="font-semibold text-sm text-[var(--cf-text)]">
              {selectedClient.firstName} {selectedClient.lastName}
            </p>
            <p className="text-xs text-[var(--cf-text-muted)]">{selectedClient.email}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect("")
              setClientSearch("")
            }}
            className="text-xs text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] underline"
          >
            Change
          </button>
        </div>
      ) : (
        <div className="relative">
          <label className="block">
            <span className={LBL}>Search client by name or email *</span>
            <input
              className={INP}
              placeholder="Type at least 2 characters…"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              autoComplete="off"
            />
          </label>
          {filteredClients.length > 0 && (
            <div className="absolute z-10 mt-1 w-full bg-[var(--cf-bg-panel)] border border-[var(--cf-border-subtle)] rounded-xl shadow-lg overflow-hidden">
              {filteredClients.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="w-full text-left px-4 py-2.5 hover:bg-[var(--cf-bg-raised)] transition-colors"
                  onClick={() => {
                    onSelect(c.id)
                    setClientSearch("")
                  }}
                >
                  <p className="text-sm font-medium text-[var(--cf-text)]">
                    {c.firstName} {c.lastName}
                  </p>
                  <p className="text-xs text-[var(--cf-text-muted)]">{c.email}</p>
                </button>
              ))}
            </div>
          )}
          {clientSearch.trim().length >= 2 && filteredClients.length === 0 && (
            <p className="text-xs text-[var(--cf-text-muted)] mt-1">No clients found</p>
          )}
        </div>
      )}
    </div>
  )
}
