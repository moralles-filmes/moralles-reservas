import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("guardrails de wiring WhatsApp multi-provider", () => {
  it("registry canônico inclui UazAPI sem remover os providers legados", () => {
    const core = read("supabase/functions/_shared/whatsapp-provider-core.ts");
    expect(core).toContain('["zapi", "waha", "official", "uazapi"]');
    expect(core).toContain("automaticProvisioning: true");
    expect(core).toContain("manualCredentials: false");
  });

  it("UazAPI outbound exige token efêmero e usa endpoint oficial", () => {
    const core = read("supabase/functions/_shared/whatsapp-provider-core.ts");
    expect(core).toMatch(/instance_token/);
    expect(core).toContain("/send/text");
    expect(core).not.toMatch(/fetchWithRetry[\s\S]{0,500}sendUazApiText/);
  });

  it("webhook deduplica por provider e bloqueia canal inativo antes da IA", () => {
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    expect(webhook).toContain('"claim_processed_whatsapp_message"');
    expect(webhook).toContain("p_provider: provider");
    expect(webhook).toContain("p_message_id: inbound.providerMessageId");
    expect(webhook).toContain('"complete_processed_whatsapp_message"');
    expect(webhook).toContain("inactive_channel_event_ignored");
    expect(webhook.indexOf("inactive_channel_event_ignored"))
      .toBeLessThan(webhook.indexOf("const runOnce = () => runAgentLoop("));
  });

  it("envio prefere ativo e fallback legado aceita somente NULL", () => {
    const send = read("supabase/functions/_shared/whatsapp-send.ts");
    expect(send).toContain('.eq("is_active", true)');
    expect(send).toContain('.is("is_active", null)');
    expect(send).toContain("whatsapp_channel_inactive");
  });

  it("confirmação delega a seleção do canal ao resolvedor central", () => {
    const confirmation = read("supabase/functions/send-confirmation/index.ts");
    expect(confirmation).toContain("sendWhatsApp(customer.phone, message, {");
    expect(confirmation).toContain("unit_id,");
    expect(confirmation).not.toContain('from("whatsapp_channels")');
  });

  it("bootstrap do preflight contém a tabela legada alterada pela migration", () => {
    const bootstrap = read("supabase/tests/local-preflight/00-bootstrap.sql");
    expect(bootstrap).toContain("create table if not exists notifications_sent");
    expect(bootstrap).toContain("provider_message_id text");
    expect(bootstrap).toContain("unit_id uuid references units(id)");
  });

  it("listagem de organizações deriva o rótulo pelo registry", () => {
    const organizations = read("supabase/functions/manage-organizations/index.ts");
    const page = read("src/pages/platform/Empresas.tsx");
    expect(organizations).toContain("getWhatsAppProvider");
    expect(organizations).toContain("default_whatsapp_provider_label");
    expect(page).toContain("org.default_whatsapp_provider_label");
  });

  it("diagnóstico frontend reconhece todos os providers do canal", () => {
    const health = read("src/hooks/useWhatsAppHealth.ts");
    expect(health).toContain('"zapi" | "uazapi" | "waha" | "official"');
  });

  it("token UazAPI é resolvido pelo Vault e nunca pelo JSONB", () => {
    const credentials = read("supabase/functions/_shared/whatsapp-channel-credentials.ts");
    const migration = read("supabase/migrations/20260817170753_whatsapp_multiprovider_uazapi.sql");
    expect(credentials).toContain('rpc("get_whatsapp_channel_instance_token"');
    expect(migration).toContain("whatsapp_channels_uazapi_credentials_empty_check");
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("vault.decrypted_secrets");
  });

  it("provisionamento usa claim com fence e reconcilia antes de create", () => {
    const lifecycle = read("supabase/functions/manage-channels/index.ts");
    expect(lifecycle).toContain('"claim_whatsapp_channel_provisioning"');
    expect(lifecycle).toContain("p_claim_id: claim.claim_id");
    expect(lifecycle.indexOf("client.listInstances()"))
      .toBeLessThan(lifecycle.indexOf("client.provision("));
  });

  it("owner/gerente recebe apenas actions client-safe e operador é negado", () => {
    const lifecycle = read("supabase/functions/manage-channels/index.ts");
    for (const action of ["list_client", "connect", "refresh_qr", "status", "disconnect", "restart"]) {
      expect(lifecycle).toContain(`"${action}"`);
    }
    expect(lifecycle).toContain('.in("role", ["owner", "gerente"])');
    expect(lifecycle).toContain("Apenas proprietários e gerentes da unidade");
  });

  it("cutover exige alvo conectado e intenção quando já existe ativo", () => {
    const migration = read("supabase/migrations/20260817170753_whatsapp_multiprovider_uazapi.sql");
    expect(migration).toContain("target_channel_not_connected");
    expect(migration).toContain("activation_not_requested");
    expect(migration).toContain("whatsapp_channels_one_active_per_unit_idx");
  });
});
