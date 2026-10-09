import { inp, lbl } from "./constants"
import type { PolicyDraftData } from "./types"

interface Props {
  data: PolicyDraftData
  set: (k: keyof PolicyDraftData, v: string) => void
}

export function MotorRiskFields({ data, set }: Props) {
  if (data.type !== "SHORT_TERM_MOTOR") return null

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        Motor Vehicle Details
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={lbl}>Registration Number</label>
          <input
            className={inp}
            placeholder="CA 123-456"
            value={data.vehicleRegNumber}
            onChange={(e) => set("vehicleRegNumber", e.target.value)}
          />
        </div>
        <div>
          <label className={lbl}>Vehicle Value (R)</label>
          <input
            className={inp}
            type="text"
            inputMode="decimal"
            placeholder="250000"
            value={data.vehicleValue}
            onChange={(e) =>
              set("vehicleValue", e.target.value.replace(",", "."))
            }
          />
        </div>
      </div>
      <div>
        <label className={lbl}>Vehicle Use</label>
        <select
          className={`${inp} bg-white`}
          value={data.vehicleUse}
          onChange={(e) => set("vehicleUse", e.target.value)}
        >
          <option value="PRIVATE">Private</option>
          <option value="BUSINESS">Business</option>
          <option value="COMMUTE">Commute</option>
        </select>
      </div>
    </div>
  )
}

export function PropertyRiskFields({ data, set }: Props) {
  if (data.type !== "SHORT_TERM_HOME" && data.type !== "SHORT_TERM_CONTENTS") {
    return null
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        Property Details
      </p>
      <div>
        <label className={lbl}>Property Address</label>
        <input
          className={inp}
          placeholder="123 Main St, Cape Town"
          value={data.propertyAddress}
          onChange={(e) => set("propertyAddress", e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={lbl}>Construction Type</label>
          <select
            className={`${inp} bg-white`}
            value={data.constructionType}
            onChange={(e) => set("constructionType", e.target.value)}
          >
            <option value="BRICK">Brick</option>
            <option value="TIMBER">Timber</option>
            <option value="MIXED">Mixed</option>
          </select>
        </div>
        <div>
          <label className={lbl}>Property Value (R)</label>
          <input
            className={inp}
            type="text"
            inputMode="decimal"
            placeholder="1500000"
            value={data.propertyValue}
            onChange={(e) =>
              set("propertyValue", e.target.value.replace(",", "."))
            }
          />
        </div>
      </div>
    </div>
  )
}
