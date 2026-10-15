"use client"

export type OtpChannelChoice = "EMAIL" | "WHATSAPP"

/**
 * "Send my code by email / WhatsApp". Rendered only when the server found the
 * lender runs WhatsApp Cloud; SMS is never offered (off by policy).
 */
export function OtpChannelPicker({
  value,
  onChange,
  name = "otpChannel",
}: {
  value: OtpChannelChoice
  onChange: (value: OtpChannelChoice) => void
  name?: string
}) {
  const options: { value: OtpChannelChoice; label: string }[] = [
    { value: "EMAIL", label: "Email" },
    { value: "WHATSAPP", label: "WhatsApp" },
  ]
  return (
    <fieldset className="text-sm">
      <legend className="font-semibold text-[var(--cf-text-secondary)]">Send my code by</legend>
      <div className="mt-2 flex gap-4">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-[var(--cf-text)]">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="accent-[var(--cf-brand)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
