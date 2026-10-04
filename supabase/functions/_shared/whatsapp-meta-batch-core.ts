import { canonicalBrPhone } from "./phone.ts";
import { isTemplateEventField } from "./whatsapp-template-events-core.ts";

/** Divide um webhook Meta em unidades que não se ocultam por early-return. */
export function splitMetaWebhookPayloadCore(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [payload];
  const root = payload as Record<string, unknown>;
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const parts: unknown[] = [];
  let managementSkipped = false;

  const addPart = (
    entry: Record<string, unknown>,
    change: Record<string, unknown>,
    value: Record<string, unknown>,
  ) => parts.push({ ...root, entry: [{ ...entry, changes: [{ ...change, value }] }] });

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as Record<string, unknown>;
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const rawChange of changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const change = rawChange as Record<string, unknown>;
      // Management is validated/persisted before ACK; it never reaches chat dispatch.
      if (isTemplateEventField(change.field)) {
        managementSkipped = true;
        continue;
      }
      const rawValue = change.value;
      if (!rawValue || typeof rawValue !== "object") {
        addPart(entry, change, {});
        continue;
      }
      const value = rawValue as Record<string, unknown>;
      const { messages, message_echoes: messageEchoes, statuses, ...shared } = value;
      let categorized = false;

      if (Array.isArray(statuses) && statuses.length > 0) {
        addPart(entry, change, { ...shared, statuses });
        categorized = true;
      }
      if (Array.isArray(messageEchoes) && messageEchoes.length > 0) {
        addPart(entry, change, { ...shared, message_echoes: messageEchoes });
        categorized = true;
      }
      if (Array.isArray(messages) && messages.length > 0) {
        for (const message of messages) {
          const messageRecord = message && typeof message === "object"
            ? message as Record<string, unknown>
            : {};
          const sender = canonicalBrPhone(String(messageRecord.from ?? ""));
          const contacts = Array.isArray(shared.contacts)
            ? shared.contacts.filter((contact) => {
              if (!contact || typeof contact !== "object") return false;
              return canonicalBrPhone(String((contact as Record<string, unknown>).wa_id ?? "")) === sender;
            })
            : [];
          addPart(entry, change, { ...shared, contacts, messages: [message] });
        }
        categorized = true;
      }
      if (!categorized) addPart(entry, change, value);
    }
  }
  return parts.length > 0 || managementSkipped ? parts : [payload];
}
