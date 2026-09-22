import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("guardrails de wiring WhatsApp multi-provider", () => {
  it("registry canônico inclui UazAPI e Datafy sem remover os providers legados", () => {
    const core = read("supabase/functions/_shared/whatsapp-provider-core.ts");
    expect(core).toContain('["zapi", "waha", "official", "uazapi", "datafy"]');
    expect(core).toContain("automaticProvisioning: true");
    expect(core).toContain("manualCredentials: false");
  });

  it("callback e teste manual Z-API preservam o status observado até o banco", () => {
    const providers = read("supabase/functions/_shared/whatsapp-providers.ts");
    const webhook = read("supabase/functions/webhook-whatsapp/index.ts");
    const manageChannels = read("supabase/functions/manage-channels/index.ts");
    const channelsHook = read("src/hooks/useWhatsAppChannels.ts");
    const migration = read("supabase/migrations/20260901225539_generalize_whatsapp_channel_status.sql");
    expect(providers).toContain("parseConnectionCallback: parseZApiConnectionCallback");
    expect(providers).toContain("parseZApiConnectionStatus(response.status, body)");
    expect(providers).toContain("parseWahaConnectionStatus(response.status, body)");
    expect(webhook).toContain('rpc("record_whatsapp_channel_status"');
    expect(manageChannels).toContain("observedStatus = snapshot.status");
    expect(manageChannels).toContain('error: newStatus === "provider_error" || newStatus === "error" ? errorMsg : null');
    expect(channelsHook).toContain('data.status === "disconnected"');
    expect(migration).toContain("v_channel.provider, v_channel.status, p_status");
    expect(migration).not.toContain("channel_provider_not_uazapi");
  });

  it("listagem client-safe reconcilia provider manual antes de responder", () => {
    const manageChannels = read("supabase/functions/manage-channels/index.ts");
    expect(manageChannels).toContain("async function refreshManualProviderStatus");
    expect(manageChannels).toContain("MANUAL_STATUS_REFRESH_INTERVAL_MS = 30_000");
    expect(manageChannels).toContain('.is("last_health_check_at", null)');
    expect(manageChannels).toContain('.lt("last_health_check_at", staleBefore)');
    expect(manageChannels).toContain('rpc("record_whatsapp_channel_status"');
    expect(manageChannels).toContain("const projectedChannel = row ? mergeChannelProjection(channel, row) : channel");
    expect(manageChannels).toContain("channel: { ...projectedChannel, last_error: errorCode }");
    expect(manageChannels).toContain("const refreshed = await refreshManualProviderStatus(selected");
    expect(manageChannels.indexOf("const refreshed = await refreshManualProviderStatus(selected"))
      .toBeLessThan(manageChannels.indexOf("connection: clientConnection(selected"));
  });

  it("QR manual usa adapters server-side e binding exato de unit + channel", () => {
    const core = read("supabase/functions/_shared/whatsapp-provider-core.ts");
    const providers = read("supabase/functions/_shared/whatsapp-providers.ts");
    const manageChannels = read("supabase/functions/manage-channels/index.ts");
    expect(core).toContain("/token/${credentials.token}/qr-code");
    expect(core).toContain("/auth/qr?format=raw");
    expect(core).toContain('Accept: "application/json"');
    expect(providers).toContain("getQrCode: getZApiQrCode");
    expect(providers).toContain("getQrCode: getWahaQrCode");
    expect(manageChannels).toContain("requested = await loadChannel(unitId, requestedId)");
    expect(manageChannels).toContain("connection: await getManualProviderQr(channel)");
    expect(manageChannels).not.toContain("console.log(qrCode)");
    expect(manageChannels).toContain("function selectClientChannel");
    expect(manageChannels).toContain("selected?.id !== requested.id && !hasValidActivationRequest(requested)");
  });

  it("WAHA prepara sessão sem retry e limita fetch/redirect antes de obter QR", () => {
    const providers = read("supabase/functions/_shared/whatsapp-providers.ts");
    const legacyStatus = providers.slice(
      providers.indexOf("async function getWahaConnectionStatus"),
      providers.indexOf("async function getZApiQrCode"),
    );
    expect(providers).toContain("buildWahaStatusRequest(credentials)");
    expect(providers).toContain("const session = encodeURIComponent(session_name)");
    expect(legacyStatus).toContain("fetchConnectionStatus(");
    expect(legacyStatus).not.toContain("isSafeWahaBaseUrl");
    expect(legacyStatus).not.toContain("fetchSafeWahaQrJson");
    expect(providers).toContain("wahaSessionPreparationAction(status.nativeStatus)");
    expect(providers).toContain("while (decision !== \"ready\")");
    expect(providers).toContain("await new Promise((resolve) => setTimeout(resolve, 350))");
    expect(providers).toContain("decision = decideWahaQrFlow(status.nativeStatus)");
    expect(providers).toContain('redirect: "error"');
    expect(providers).toContain("total > maxBodyBytes");
    expect(providers.indexOf("const statusRequest = buildWahaStatusRequest(credentials)"))
      .toBeLessThan(providers.indexOf("const request = buildWahaQrRequest(credentials)"));
  });

  it("sem canal só anuncia QR quando o default tem provisionamento automático", () => {
    const manageChannels = read("supabase/functions/manage-channels/index.ts");
    expect(manageChannels).toContain("defaultProvider && supportsClientLifecycle(defaultProvider)");
    expect(manageChannels).toContain("supportsClientLifecycle(context.defaultProvider) ? context.defaultProvider : undefined");
  });

  it("polling de QR manual consulta status e nunca renova QR automaticamente", () => {
    const hook = read("src/hooks/useWhatsappConnection.ts");
    expect(hook).toContain('return "status"');
    expect(hook).toContain("reconcileWhatsappConnectionPoll");
    expect(hook).not.toContain('return "refresh_qr"');
  });

  it("capabilities client-safe separam QR, restart e disconnect", () => {
    const core = read("supabase/functions/_shared/whatsapp-provider-core.ts");
    const providers = read("supabase/functions/_shared/whatsapp-providers.ts");
    const manageChannels = read("supabase/functions/manage-channels/index.ts");
    expect(core).toMatch(/zapi:\s*\{[\s\S]*?qrConnection: true,[\s\S]*?disconnect: false,[\s\S]*?restart: false/);
    expect(core).toMatch(/official:\s*\{[\s\S]*?qrConnection: false/);
    expect(manageChannels).toContain("qr_available:");
    expect(manageChannels).toContain("restart_available:");
    expect(manageChannels).toContain("disconnect_available:");
    expect(providers).toContain("canRequestQr: (credentials) => !!credentials.instance_id && !!credentials.token");
    expect(providers).toContain("canRequestQr: (credentials) => isSafeWahaBaseUrl(credentials.base_url)");
    expect(manageChannels).toContain('"PASSKEY_REQUIRED", "PASSKEY_CONFIRMATION_REQUIRED"');
    expect(manageChannels).toContain("supportsClientQr(provider, channel?.credentials ?? null)");
  });

  it("orienta suporte para erro sem restart ou QR sem alterar a copy desconectada", () => {
    const whatsappPage = read("src/pages/gestao/Whatsapp.tsx");
    expect(whatsappPage).toContain("Esta conexão exige uma etapa adicional no provedor. Fale com o suporte.");
    expect(whatsappPage).toContain("Este tipo de conexão é administrado sem pareamento por QR Code.");
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
