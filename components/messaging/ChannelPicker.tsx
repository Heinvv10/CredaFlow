export type Channel = "EMAIL" | "WHATSAPP" | "SMS"
export type ChannelAvail = { enabled: boolean; reason?: string }
export type ChannelAvailability = Record<Channel, ChannelAvail>

export const CHANNEL_ORDER: Channel[] = ["EMAIL", "WHATSAPP", "SMS"]
const CHANNEL_LABELS: Record<Channel, string> = { EMAIL: "Email", WHATSAPP: "WhatsApp", SMS: "SMS" }

export function ChannelPicker(props: {
  availability: ChannelAvailability | null
  channel: Channel | null
  onChange: (c: Channel) => void
}) {
  if (!props.availability) return <p className="text-xs text-gray-400">Loading available channels…</p>
  const availability = props.availability
  return (
    <div>
      <label className="block text-sm font-medium text-[#1b1d24] mb-1">Channel</label>
      <div className="grid grid-cols-3 gap-2">
        {CHANNEL_ORDER.map((c) => {
          const avail = availability[c] ?? { enabled: false }
          const selected = props.channel === c
          return (
            <button
              key={c}
              type="button"
              disabled={!avail.enabled}
              onClick={() => props.onChange(c)}
              className={`rounded-lg border-2 px-2 py-2 text-left text-xs transition-colors ${
                selected ? "border-[#4F46E5] bg-amber-50" : "border-gray-200 hover:border-gray-300"
              } ${!avail.enabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            >
              <p className="font-semibold text-[#1b1d24]">{CHANNEL_LABELS[c]}</p>
              {!avail.enabled && avail.reason && <p className="mt-0.5 text-[10px] text-gray-400">{avail.reason}</p>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
