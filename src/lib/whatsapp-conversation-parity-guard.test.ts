import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("paridade de conversas entre providers WhatsApp", () => {
  it("obriga todo adapter atual a normalizar eco de mensagem própria", () => {
    const providers = read("supabase/functions/_shared/whatsapp-providers.ts");
    for (const parser of [
      "parseZApiOwnMessageEcho",
      "parseWahaOwnMessageEcho",
      "parseOfficialOwnMessageEcho",
      "parseUazApiOwnMessageEcho",
    ]) {
      expect(providers).toContain(parser);
    }
  });

  it("processa eco humano pelo registry, dedupe e RPC atômica sem exceção Z-API", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    const start = webhook.indexOf("async function handleOwnMessageEcho");
    const end = webhook.indexOf("function identityShape", start);
    const handler = webhook.slice(start, end);

    expect(webhook).toContain("const ownMessageEchoes = parseOwnMessageEchoes(provider, payload)");
    expect(handler).toContain('"claim_processed_whatsapp_message"');
    expect(handler).toContain('rpc("record_whatsapp_human_message"');
    expect(handler).toContain("p_unit_id: unitId");
    expect(handler).toContain('source === "provider_api"');
    expect(handler).toContain('author: "human"');
    expect(handler).not.toContain('provider !== "zapi"');
  });

  it("isola a correlação do eco da API por unidade, provider e canal", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    const handlerStart = webhook.indexOf("async function handleOwnMessageEcho");
    const start = webhook.indexOf('from("notifications_sent")', handlerStart);
    const block = webhook.slice(start, start + 500);
    expect(block).toContain('.eq("unit_id", unitId)');
    expect(block).toContain('.eq("whatsapp_provider", provider)');
    expect(block).toContain('.eq("whatsapp_channel_id", channelId)');
    expect(block).toContain('.eq("provider_message_id", messageId)');
  });

  it("preserva autoria, timestamp original e fence humano antes do envio da IA", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    expect(webhook).toContain('author: "customer"');
    expect(webhook).toContain('author: "automation"');
    expect(webhook).toContain('author: "ai"');
    expect(webhook).toContain("timestamp: inbound.timestamp");
    expect(webhook).toContain("timestamp: media.timestamp");
    expect(webhook).toContain("eventId: `wa-in:${provider}:${inbound.providerMessageId}`");
    expect(webhook).toContain("required: true");
    expect(webhook).toContain('"success_history_degraded"');
    const fence = webhook.indexOf("const sendAutomatic = async");
    const finalSend = webhook.indexOf("const sendRes = await sendAutomatic", fence);
    expect(fence).toBeGreaterThan(0);
    expect(finalSend).toBeGreaterThan(fence);
    const afterFence = webhook.slice(fence);
    expect(afterFence.match(/sendOutbound\(provider, credentials/g)).toHaveLength(1);
    expect(afterFence).toContain('select("status, ai_lock_token")');
  });

  it("cutover exige prova persistida do contrato de conversa", () => {
    const migration = read("supabase/migrations/20260905143453_whatsapp_conversation_provider_parity.sql");
    const manager = read("supabase/functions/manage-channels/index.ts");
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    expect(migration).toContain("whatsapp_conversation_parity_unverified");
    expect(migration).toContain("before insert or update of is_active");
    expect(manager).toContain('manual_echo_verification_source: "managed_configuration"');
    expect(webhook).toContain('manual_echo_verification_source: "provider_callback"');
    expect(manager).toContain("TARGET_CONVERSATION_PARITY_UNVERIFIED");
    expect(manager.match(/manual_echo_verified_at: null/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(migration).toContain("alter column is_active set default false");
    expect(manager).toContain("is_active: false");
    expect(webhook).toContain("metaPayloadMatchesChannel(payload, credentials)");
    expect(webhook).toContain("declaredProviderIdentityMatchesChannel(provider, payload, credentials)");
    const identityCore = read("supabase/functions/_shared/whatsapp-echo-identity-core.ts");
    expect(identityCore.match(/credentials\.session_name\?\.trim\(\) \|\| "default"/g)).toHaveLength(2);
    expect(webhook).toContain('from "../_shared/whatsapp-echo-identity-core.ts"');
    // A decisão de identidade não volta a ser escrita onde o vitest não alcança.
    expect(webhook).not.toMatch(
      /function (manualEchoMatchesConfiguredChannel|declaredProviderIdentityMatchesChannel|metaPayloadMatchesChannel|metaPhoneNumberIds)\b/,
    );
    expect(webhook).toContain("manualEchoMatchesConfiguredChannel(");
    expect(webhook).toContain("hasManualEcho && !manualEchoMatchesChannel");
    expect(webhook).toContain("splitMetaWebhookPayload(payload)");
    expect(webhook).toContain("handleWebhookRequest(new Request");
    expect(webhook).toContain('"get_or_create_whatsapp_conversation"');
    expect(migration).toContain("pg_advisory_xact_lock");
  });

  it("toda recusa 401 do webhook grava o nome da guarda em meta.reason", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    const calls = webhook.match(/finish\("webhook_unauthorized"[^)]*\)/g) ?? [];
    const reasons = calls.map((call) => call.match(/\{ reason: "([a-z_]+)" \}/)?.[1] ?? "SEM_REASON");
    expect(reasons.sort()).toEqual([
      "declared_identity_mismatch",
      "instance_mismatch",
      "manual_echo_identity_mismatch",
      "meta_identity_mismatch",
      "provider_token_mismatch",
      "signature_invalid",
    ]);
  });

  it("falha transitória libera somente o claim cercado para reentrega", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    const migration = read("supabase/migrations/20260905143453_whatsapp_conversation_provider_parity.sql");
    expect(webhook).toContain('rpc("release_processed_whatsapp_message_claim"');
    expect(webhook).toContain('throw new Error("processed_message_inflight")');
    expect(webhook).toContain("!externalSideEffectStarted");
    expect(migration).toContain("and processing_claim_id = p_claim_id");
    expect(migration).toContain("and completed_at is null");
  });

  it("envio manual do painel renova handoff pela mesma RPC atômica", () => {
    const manual = read("supabase/functions/send-manual-message/index.ts");
    const hook = read("src/hooks/useSendManualMessage.ts");
    const screen = read("src/pages/gestao/Conversas.tsx");
    expect(manual).toContain('rpc("record_whatsapp_human_message"');
    expect(manual).toContain("CONVERSATION_RECONCILIATION_REQUIRED");
    expect(manual).not.toContain('.update({ status: "human_active"');
    expect(hook).toContain("return data as ManualMessageSendResult");
    expect(screen).toContain("result.local_success === false");
    expect(screen).toContain("histórico não foi confirmado");
  });

  it("writer automático usa resolver serializado e propaga persistência parcial", () => {
    const writer = read("supabase/functions/_shared/conversation-log.ts");
    const send = read("supabase/functions/send-whatsapp/index.ts");
    expect(writer).toContain('"get_or_create_whatsapp_conversation"');
    expect(writer).not.toContain('from("conversations").insert');
    expect(writer).toContain("Promise<AppendOutboundResult>");
    expect(send).toContain("conversationHistoryPersisted");
    expect(send).toContain("CONVERSATION_RECONCILIATION_REQUIRED");
  });

  it("mantém UazAPI recebendo eco manual e exclui somente eco da API", () => {
    const client = read("supabase/functions/_shared/uazapi-client.ts");
    expect(client).toContain('excludeMessages: ["wasSentByApi"]');
    expect(client).not.toContain('"fromMeYes"');
  });

  it("resolve corrida de customer novo pela fonte canônica", () => {
    const resolver = read("supabase/functions/_shared/resolve-customer.ts");
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    expect(resolver).toContain('insErr?.code === "23505"');
    expect(resolver).toContain('from("customers")');
    expect(webhook).toContain("resolveOrCreateCustomer(supabase");
  });

  it("migration mantém timeline monotônica e handoff atômico protegido", () => {
    const migration = read("supabase/migrations/20260905143453_whatsapp_conversation_provider_parity.sql");
    expect(migration).toContain("greatest(last_message_at, v_message_at)");
    expect(migration).toContain("create or replace function public.record_whatsapp_human_message");
    expect(migration).toContain("status = 'human_active'");
    expect(migration).toContain("and unit_id = p_unit_id");
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("item->>'event_id' = v_event_id");
    expect(webhookRetryWriter()).toContain("attempt < 2");
  });

  it("documenta o gate permanente nos dois manuais do repositório", () => {
    const claude = read("CLAUDE.md");
    const agents = read("AGENTS.md");
    for (const doc of [claude, agents]) {
      expect(doc).toContain("Meta");
      expect(doc).toContain("Coexistence");
      expect(doc).toContain("message.any");
      expect(doc).toContain("wasSentByApi");
    }
  });
});

function webhookRetryWriter(): string {
  const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
  const start = webhook.indexOf("async function appendConversationMessageRpc");
  const end = webhook.indexOf("type ConversationMessageAuthor", start);
  return webhook.slice(start, end);
}
