/** Tons das pílulas de status e situação. Mora na lib para o núcleo puro não depender de componente. */
export type StatusTone =
  | "free"
  | "reserved"
  | "arriving"
  | "seated"
  | "late"
  | "pending"
  | "destructive"
  | "muted"
  | "success";
