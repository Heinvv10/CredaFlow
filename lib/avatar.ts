// Avatar colors matching the brand palette
const AVATAR_COLORS = [
  "#4338ca", // gold (brand primary)
  "#047857", // green
  "#1d4ed8", // blue
  "#6d28d9", // purple
  "#b91c1c", // red
  "#0f766e", // teal
  "#b45309", // orange
  "#4338ca", // indigo
]

export function getAvatarColor(name: string): string {
  const charCode = name.charCodeAt(0)
  return AVATAR_COLORS[charCode % AVATAR_COLORS.length]
}

export function getInitials(firstName: string, lastName: string): string {
  return (firstName[0] + lastName[0]).toUpperCase()
}

export function getInitialsFromName(name: string | null, fallback: string): string {
  if (name) {
    const parts = name.trim().split(" ")
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return parts[0].slice(0, 2).toUpperCase()
  }
  return fallback.slice(0, 2).toUpperCase()
}
