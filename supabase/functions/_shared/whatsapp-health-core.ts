/** Diagnostic selection follows the operational binding; only then inspect onboarding. */
export function selectHealthChannel<T extends { is_active: boolean | null; status: string; created_at: string }>(rows: T[]): T | null {
  return rows.find((row) => row.is_active === true)
    ?? rows.find((row) => row.is_active === null && row.status === "connected")
    ?? [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
    ?? null;
}
