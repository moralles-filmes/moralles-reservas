# Datafy como parceiro: conexão self-service de lojas na API oficial (design)

**Status:** aprovada em 2026-10-13, com as quatro recomendações da §11. **Data:** 2026-10-13.
**Depende de:** Fases A–D da Datafy (mergeadas), Fase F de templates (mergeada, flags OFF), piloto da Moralles (13/10).
**Substitui:** a exclusão deliberada do `datafy` no `begin_switch` (plano das Fases A–B, item g), apenas para a primeira configuração de uma unidade.

---

## 1. O que o piloto da Moralles provou e o que ele expôs

Em 2026-10-13 a unidade Moralles (`moralles-centro`) entrou em produção num canal Datafy em Coexistence. Medido em produção:

- A ingestão assíncrona funciona com tráfego real: ACK à Datafy em ~1,2 s, turno do agente em ~21 s, resposta entregue com recibos `sent` e `delivered`. Sem a fila, esse turno teria estourado os 20 s da Datafy.
- O eco do aparelho (`smb_message_echoes`) chega e grava `manual_echo_verified_at` mesmo com o canal inativo (`conversation_parity_verified`).

Para chegar lá foram necessários cinco passos manuais, e cada um é uma lacuna do produto:

| # | Passo manual | Por que foi manual |
|---|---|---|
| 1 | Criar o canal no painel da Datafy, copiar `sk_live_` e `whsec_` | O sistema não fala com a API de administração da Datafy |
| 2 | Colar a URL do webhook e marcar eventos no painel da Datafy | Idem; a nota "a Datafy responde 403 a `webhook_configuration`" vale para o token de canal, não para o de conta |
| 3 | Ligar `async_ingestion_enabled` e a flag global por SQL | Nada liga a fila para canal Datafy |
| 4 | Ativar o canal por SQL (`activate_whatsapp_channel`) | Nenhum caminho ativa canal Datafy: `test` exige `activation_requested_at`, só o `begin_switch` o grava, e o `begin_switch` recusa `datafy` |
| 5 | Conferir a fila a olho no Diagnóstico | Não existe alerta de dead-letter nem de fila parada |

O levantamento da interface achou ainda: o portal do lojista mostra "Inicie a conexão para gerar um QR Code" para unidade sem canal ativo; com `default_whatsapp_provider = uazapi` o botão de QR aparece e cria um placeholder UazAPI; o card de Diagnóstico ignora canal inativo durante o onboarding; o diálogo de edição não tem ramo Datafy; o toast de rotação manda "atualizar a URL", que no Datafy não muda.

**Consequência operacional vigente:** com `whatsapp_automation_dispatch` OFF, confirmação, lembrete, pesquisa, fila e voucher de uma unidade Datafy saem como texto livre pelo caminho `legacy`. A Meta recusa texto livre fora da janela de 24 h. O chat com a IA não é afetado; as automações proativas falham até o piloto de templates (Fase F).

---

## 2. Decisões de negócio (tomadas em 2026-10-13)

| # | Decisão | Consequência no desenho |
|---|---|---|
| 1 | **A plataforma paga a Datafy; cada loja paga a Meta.** | Canal Datafy vive na conta de parceiro da plataforma (R$ 49,90/canal/mês, proporcional). O número vive na BM/WABA do cliente, onde ele cadastra o cartão. |
| 2 | **O cliente conecta o próprio número pelo nosso sistema, depois de liberação explícita do admin.** | Cada conexão gera custo para a plataforma; nenhuma chamada que gera custo acontece sem liberação ativa para aquela unidade. |
| 3 | **Só lojas novas nesta entrega.** | Ativação Datafy só em unidade sem canal ativo. Migração de loja em produção fica para entrega própria, com a pergunta MOD-datafy-whatsapp-003 (dois canais no mesmo número) respondida. |
| 4 | **Alerta operacional por webhook externo.** | Independe do `billing_notifications_dispatch`, que segue OFF. |
| 5 | **Loja entra no ar antes dos templates, com aviso na tela.** | Ativação não exige template aprovado; portal e painel dizem o que não vai chegar. |

---

## 3. O contrato de parceiro da Datafy (documentado, NÃO validado ao vivo)

Fonte: `developers.datafyapi.com.br` (guias de parceiro e OpenAPI `administracao/specs/canais.json`), lida em 2026-10-13. Este repositório já tem precedente de envelope real divergente da documentação (recibos UazAPI). **Nada desta seção pode virar código sem a validação da Fase 0 (§10).**

- **Autenticação:** token de conta `sk_acct_…`, criado em Minha conta → Parceiros. Dá acesso a **todos** os canais da conta. Distinto do token de canal `sk_live_…`.
- **Base:** `https://cloud.datafyapi.com.br`.

| Operação | Chamada | Efeito relevante |
|---|---|---|
| Criar canal | `POST /channels/whatsapp` `{name, description?}` | Devolve `id`, `token` (`sk_live_`), `webhook_secret`; nasce sem número e sem assinatura. Trial de 2 dias. **Não idempotente.** |
| Consultar canal | `GET /channels/whatsapp/{id}` | `subscribed`, `on_trial`, `trial_ends_at`, `paused`, `waba_id`, `phone_number_id`, `business_id`, `phone`, `display_name`, `webhooks[]`, `token`, `webhook_secret` |
| Listar canais | `GET /channels/whatsapp` | Sem token/secret; inclui `subscription` da conta (`active`/`past_due`/`trial`/`pending`/`canceled`) |
| Criar webhook | `POST /channels/whatsapp/{id}/webhooks` `{url, events?, enabled?}` | `events` default `messages` + `smb_message_echoes`; assinado com o `webhook_secret` do canal |
| Editar webhook | `PATCH …/webhooks/{webhookId}` | Troca URL/eventos/enabled |
| Rotacionar secret | `POST …/{id}/webhook-secret` | Devolve o novo `webhook_secret` |
| Assinar canal | `POST …/{id}/subscribe` | **Cobra na hora** o proporcional do ciclo. 402 cartão recusado; 409 sem assinatura de conta |
| Cancelar canal | `POST …/{id}/cancel` | Crédito no próximo ciclo; 409 se for o único canal ativo |
| Gerar link | `POST …/{id}/connect-link` | `{url, token: ct_…, expires_in: 86400}`; uso único; 409 já conectado / trial expirado |
| Pausar / retomar | `POST …/{id}/pause` · `/resume` | Pausa bloqueia envio, recebimento e webhooks; não desconecta da Meta. Retomar pode exigir novo link |
| Deletar | `DELETE …/{id}` | Exige assinatura cancelada |

**Janela de conexão:** `window.open(url)`, com a marca do parceiro (logo, nome, cor configurados no painel). Ao concluir, a janela envia `postMessage` com `origin === "https://app.datafyapi.com.br"`, `data.source === "datafy"`, `data.event === "connected"` e `data.data = {phone_number_id, waba_id, business_id, coexistence}`, e fecha sozinha. Em erro, `event === "error"` e a janela fica aberta.

**Lado do cliente (Coexistence):** vincula o número do app em Meta Business Suite → Contas do WhatsApp; percorre o Embedded Signup (telefone, portfólio, WABA); escaneia o QR no app WhatsApp Business; escolhe compartilhar histórico. Depois cadastra o cartão na WABA (Configurações de pagamento). O app precisa ser aberto ao menos a cada 14 dias, senão a conexão cai; o WhatsApp Web costuma desconectar na conexão.

---

## 4. Fluxo-alvo

```
Admin                     Lojista (owner/gerente)          Backend (manage-channels)            Datafy / Meta
─────                     ───────────────────────          ─────────────────────────            ─────────────
1. Libera a unidade ──────────────────────────────────────▶ grant ativo
                          2. "Conectar WhatsApp oficial" ─▶ start: gates + claim
                                                            cria canal Datafy (se não existe) ─▶ POST /channels
                                                            grava token/whsec/external id
                                                            cria webhook (url+eventos) ───────▶ POST /webhooks
                                                            gera link ────────────────────────▶ POST /connect-link
                          3. janela da Datafy ◀──────────── url (não persistida, não logada)
                             Embedded Signup + QR no app ──────────────────────────────────────▶ Meta
                          4. postMessage "connected" ─────▶ confirm (postMessage é só gatilho)
                                                            GET /channels/{id} ───────────────▶ fonte da verdade
                                                            unicidade phone_number_id / WABA
                                                            grava credenciais, status connected
                                                            assina (claim, uma vez) ──────────▶ POST /subscribe ($)
                                                            consome a liberação
                                                            grava activation_requested_at
                          5. Envia msg pelo app do celular ─────────────────────────────────── webhook: eco
                                                            eco verificado + pedido + connected
                                                            → activate_whatsapp_channel
                          6. Checklist: cartão na Meta, templates pendentes
```

Ponto 4 tem caminho alternativo: se a janela fechar sem `postMessage` (bloqueio, aba perdida), o portal oferece "Já concluí a conexão", que chama o mesmo `confirm`. O `confirm` é idempotente e nunca confia no conteúdo do `postMessage`.

---

## 5. Componentes

### 5.1 Credencial de conta Datafy

- Nova chave `datafy_account_token` em `platform_secrets`, cadastrada pelo painel (`manage-platform-secrets`, que tem whitelist de chaves).
- **Sem fallback para `Deno.env`.** O CLAUDE.md registra que `platform_secrets` cai para env em qualquer erro de leitura e que isso mantém credencial velha viva; para um token que alcança todos os canais da conta, leitura falha recusa a operação (503), nunca usa outra fonte.
- Cliente HTTP novo `_shared/datafy-admin-client.ts`, com `fetch` injetável e testes. O token vai em `Authorization`, nunca em path ou query. Nenhum log carrega o token, o `sk_live_`, o `whsec_`, a URL do link ou o `ct_`.

### 5.2 Liberação por unidade

- Tabela `whatsapp_official_connection_grants`: `id`, `organization_id`, `unit_id`, `granted_by`, `granted_at`, `revoked_by`, `revoked_at`, `consumed_channel_id`, `consumed_at`. Índice único parcial: no máximo uma liberação **ativa** (não revogada e não consumida) por unidade.
- `FORCE RLS` sem policies; leitura e escrita só pelo `manage-channels` (platform_admin escreve; owner/gerente só vê se a própria unidade está liberada, via ação client-safe).
- **Uma liberação paga um canal.** Ela é consumida quando a assinatura do canal é confirmada (`subscribe` 200). Reconectar o **mesmo** canal (novo link) não consome outra; criar outro canal Datafy na unidade exige nova liberação.
- Os gates existentes continuam somados à liberação: `resolveWhatsAppGateByUnit` (serviço ativo/override) e `checkChannelConnectionAllowance` (contrato inclui a conexão).

### 5.3 Onboarding fora de `whatsapp_channels`, e o canal só nasce com âncora

O invariante vigente diz que um canal Datafy **nunca é inserido sem `phone_number_id`**, porque esse campo é a âncora de `metaPayloadMatchesChannel`. O fluxo self-service tem um intervalo em que o canal existe na Datafy mas ainda não tem número. Em vez de afrouxar o invariante, esse intervalo vive numa tabela própria:

- `whatsapp_datafy_onboardings`: `id`, `organization_id`, `unit_id`, `grant_id`, `reserved_channel_id uuid unique` (o id que a linha de `whatsapp_channels` vai receber), `datafy_channel_id text unique`, `channel_token`, `webhook_secret`, `datafy_webhook_id`, `state`, `claim_id`, `claim_step`, `claim_started_at`, `subscribed_at`, `coexistence`, `completed_at`, `abandoned_at`, `last_error`. `FORCE RLS` sem policies, como `whatsapp_channels`. No máximo um onboarding aberto por unidade (índice único parcial).
- O webhook é criado na Datafy já com `?channel=<reserved_channel_id>`. Entrega que chegue antes da confirmação encontra canal inexistente, recebe 404 e a Datafy reentrega.
- Na confirmação, a linha de `whatsapp_channels` nasce com `id = reserved_channel_id`, `phone_number_id` vindo do GET da Datafy, `external_instance_id` = id Datafy (índice único `(provider, external_instance_id)` já existe), `status = 'connected'`, `is_active = false`, `async_ingestion_enabled = true`, e logo depois recebe `activation_requested_at`.
- Colunas novas em `whatsapp_channels`: `provider_subscribed_at`, `provider_subscription_canceled_at`, `provider_paused_at`, `provider_coexistence`.
- Índice único parcial na expressão `(credentials->>'phone_number_id')` para `provider in ('official','datafy')`.
- **Claim próprio, não o da UazAPI.** As RPCs `claim/release_whatsapp_channel_provisioning` recusam provider diferente de `uazapi`. O onboarding tem RPCs próprias que cercam cada passo não idempotente (`create_channel`, `subscribe`) com `claim_id` + TTL comparado no SQL (`now()` escreve e compara). Resposta incerta vira estado `uncertain` do passo e só sai dele por reconciliação: listagem por `name` para o canal, `GET` com `subscribed` para a assinatura.

### 5.4 Ações novas no `manage-channels`

Decisão em núcleo puro novo `_shared/datafy-onboarding-core.ts` (testado em `src/lib/`); o handler é adapter de I/O.

| Ação | Quem | O que faz |
|---|---|---|
| `official_connection_state` | owner/gerente/admin da unidade | Liberação ativa? canal existente? etapa atual do checklist. Sem credencial, WABA bruta ou link |
| `official_connect_start` | owner/gerente/admin | Gates + liberação; abre ou retoma o onboarding; garante canal Datafy (reconcilia por `name` = `reserved_channel_id` antes de criar) e webhook; gera link; devolve só a `url` |
| `official_connect_confirm` | owner/gerente/admin | `GET /channels/{id}`; exige `phone_number_id` e `coexistence = true`; unicidade de número e WABA (WABA única entre organizações, invariante da Fase F); cria a linha de `whatsapp_channels` com o `reserved_channel_id`; assina com claim; consome liberação; grava `activation_requested_at`; fecha o onboarding |
| `grant_official_connection` / `revoke_official_connection` | platform_admin | Cria/revoga liberação, com ator e data |
| `datafy_subscribe` / `datafy_cancel` / `datafy_pause` / `datafy_resume` | platform_admin | Operações de custo e suspensão manuais, sempre pelo canal da unidade no nosso banco |
| `datafy_link_existing` | platform_admin | Liga um canal criado à mão (Moralles) ao id Datafy, achando-o por `phone_number_id` na listagem da conta |

Regras transversais:
- O id do canal Datafy usado em qualquer chamada vem da linha da unidade no nosso banco, filtrada por `unit_id` do chamador autenticado. Nunca do corpo da requisição.
- `phone_number_id`, `waba_id` e `business_id` vêm do `GET` da Datafy, nunca do `postMessage` nem do corpo. É a mesma régua do invariante "na criação, o `phone_number_id` nasce só da descoberta".
- POST não idempotente nunca tem retry cego. Resposta incerta reconcilia por consulta (`GET` do canal / listagem por `name`) antes de qualquer nova tentativa.
- Todo `UPDATE` com predicado de tenant usa `.select()` e confere a contagem.
- Operador nunca acessa nenhuma dessas ações.

### 5.5 Ativação automática no primeiro canal

- **Webhook, caminho do eco:** depois de gravar `manual_echo_verified_at`, se o canal tem `activation_requested_at` e `status = 'connected'`, chama `activate_whatsapp_channel` (espelha o caminho de connection callback que já existe). A RPC continua sendo a autoridade: em unidade com outro canal ativo ela exige o pedido, e o trigger de paridade exige o eco.
- **`begin_switch`:** passa a aceitar `datafy` **somente** quando a unidade não tem canal ativo (primeira configuração). Com canal ativo de outro provedor, responde 409 `DATAFY_MIGRATION_NOT_SUPPORTED` (decisão nº 3). Isso destrava o botão "Ativar" para canais Datafy criados à mão.

### 5.6 Ingestão assíncrona garantida para Datafy

- Capability nova no registry: `inboundRedelivery: "documented" | "unmeasured"` (Datafy `documented`; os quatro legados `unmeasured`, porque a reentrega deles nunca foi medida).
- `decideIngestionMode` passa a receber essa capability: provider `unmeasured` processa síncrono mesmo com a coluna ligada. Fecha o buraco registrado no CLAUDE.md ("nada no código verifica isso").
- A flag global `whatsapp_async_ingestion` permanece como corte amplo. O painel mostra o modo **efetivo** do canal (coluna + flag + capability), não só a coluna.

### 5.7 Alerta operacional externo

- Extrair o sender do pipeline de templates (`createTemplateAlertSender`) para `_shared/ops-alert-sender.ts` (HTTPS, sem credencial na URL, sem redirect, timeout de 5 s). Env nova `WHATSAPP_OPS_ALERT_URL` (Edge secret).
- **Quem dispara é o `process-whatsapp-channel-health` (`*/5`), não a varredura.** Fila parada é justamente quando a varredura não roda; um alerta que dependesse dela calaria no caso que importa.
- Dois eventos: `inbound_dead_letter` (linhas novas em `dead` desde o último alerta da unidade) e `inbound_backlog_stalled` (idade da linha não terminal mais antiga acima de `MAX_PENDING_BACKLOG_AGE_MS`, a mesma régua derivada do painel).
- Payload só com ids, contagens e idades. Nunca telefone, corpo de mensagem ou `raw_body`.
- Cadência por ledger (último alerta por unidade e tipo), nunca por fila de notificações.
- Ausência da URL não é sucesso: o health responde `delivered: false, reason: "unconfigured"` e o Diagnóstico mostra "alerta não configurado".

### 5.8 Interface

**Portal do lojista `/g/:slug/whatsapp`:**
- Unidade liberada e sem canal ativo: card "Conectar WhatsApp oficial" com os pré-requisitos (número no app WhatsApp Business, portfólio Meta, celular por perto, acesso ao e-mail do Facebook). Some a frase de QR Code.
- O clique abre uma janela **vazia de forma síncrona** e só depois navega para a URL devolvida pelo backend. Abrir depois do `await` é bloqueado como popup.
- O listener valida `origin` e `data.source`; o evento só dispara o `confirm`. A URL e o `ct_` não entram em query key, log, storage nem estado persistido.
- Depois da conexão, um checklist derivado do backend: (1) número conectado; (2) "envie uma mensagem pelo app WhatsApp Business no celular para qualquer contato" até o eco chegar; (3) "cadastre o cartão na sua conta Meta", com passo a passo; (4) aviso de que confirmações e lembretes podem não chegar até os templates serem aprovados; (5) lembrete de abrir o app a cada 14 dias.
- Com liberação ativa, a capability exibida é a do Datafy, mesmo que `default_whatsapp_provider` da organização seja `uazapi`. Isso tira o botão de QR que cria placeholder UazAPI.

**Painel da plataforma `/platform/automacao/:slug`:**
- Liberar/revogar conexão oficial.
- No card Datafy: checklist com liberado → canal Datafy → webhook → número conectado (telefone, Coexistence) → assinatura → eco → ativo → modo de ingestão efetivo. Ações de assinatura, pausa e vínculo de canal existente.
- Correções do levantamento: ramo Datafy no diálogo de edição; toast de rotação sem "atualize a URL"; `activation_requested_at` visível; Diagnóstico enxergando o canal em onboarding; diálogo de novo canal partindo do provedor padrão da organização.

### 5.9 Eventos do webhook

- Na criação: só `messages` e `smb_message_echoes`. Eventos de template sem binding da Fase F são recusados (`template_batch_invalid`), e assinar antes do binding geraria 401 em série.
- Os eventos de template entram por `PATCH` no momento do piloto de templates da unidade, que segue o runbook da Fase F e suas autorizações próprias.

---

## 6. Segurança e isolamento (resumo para os gates)

1. `sk_acct_` só no servidor, só em `platform_secrets`, sem fallback de env, fora de logs e DTOs.
2. Toda chamada à Datafy usa o id do canal resolvido pelo `unit_id` do chamador; corpo não escolhe canal.
3. Identidade Meta vem da Datafy (GET), nunca do navegador; `phone_number_id` único entre canais e WABA única entre organizações.
4. Custo só com liberação ativa + gates de serviço e contrato; claim cercado; sem retry cego.
5. `postMessage` validado por origem e `source`, e mesmo assim tratado como gatilho, não como dado.
6. Link de conexão é capability: sem log, sem persistência, `no-store`.
7. Owner/gerente só na própria unidade, com paralelo `platform_admin`; operador nunca.
8. Alerta externo sem PII.

---

## 7. Migrations (ordem: banco antes das EFs)

1. `whatsapp_official_connection_grants` e `whatsapp_datafy_onboardings` (FORCE RLS, sem policies, `revoke all … from public, anon, authenticated`).
2. RPCs `claim_datafy_onboarding_step` / `release_datafy_onboarding_step` (SECURITY DEFINER, `search_path = ''`, EXECUTE só `service_role`).
3. Colunas novas em `whatsapp_channels` e índice único de `phone_number_id`.
4. Ledger de alertas operacionais (último envio por unidade/tipo).

Aplicação por `supabase db push`, com pré-voo local cobrindo índices, CHECKs e controle positivo. Conferir `acl-estatico`.

---

## 8. Fora de escopo

- Migração de loja em produção para Datafy (`begin_switch` com canal ativo).
- Número só Cloud API (sem app, `coexistence = false`): ver questão aberta 1.
- Piloto de templates (Fase F): segue o runbook próprio. Esta entrega só mostra o estado e avisa.
- Verificação por API do cartão na Meta.
- Integração do custo Datafy ao maquinário `whatsapp_instances`/ciclos e pausa automática por inadimplência.

---

## 9. Riscos

| Risco | Tratamento |
|---|---|
| Contrato real diverge da documentação | Fase 0 ao vivo antes de qualquer código |
| Clique duplo assina duas vezes (cobrança proporcional) | Claim cercado; `confirm` idempotente; reconciliação por GET |
| Trial de 2 dias acaba antes de assinar | Assinar no `confirm`; falha de assinatura gera alerta e mantém o checklist em "assinatura pendente" |
| Assinatura da conta Datafy em `past_due` | Admin API devolve 403 para tudo; `official_connection_state` mostra "indisponível" e o health alerta |
| Cliente sem cartão na Meta | Envios da API falham e aparecem em Entregas; checklist mantém o passo aberto |
| App não aberto por 14 dias | Coexistence cai; health worker já observa conexão; copy no portal |
| Popup bloqueado | Janela aberta de forma síncrona; botão "Já concluí" como reserva |

---

## 10. Entrega em fases (base do plano)

| Fase | Entrega | Gate de saída |
|---|---|---|
| 0 | **Validação ao vivo do contrato de parceiro**, com canal de teste em trial (sem assinar, sem cliente real): criar canal, criar webhook, gerar link, conectar um número de teste, registrar a FORMA do `postMessage` e do GET, testar `subscribe` repetido e `delete` de canal nunca assinado | Relatório de forma (nunca de valor) comparado à §3 |
| 1 | Cliente admin + segredo + núcleo `datafy-onboarding-core` + migrations | Testes do núcleo com controle positivo; pré-voo local |
| 2 | Ações do `manage-channels`, ativação pelo eco, `begin_switch` primeira configuração, capability de reentrega | `typecheck`, `vitest`, `deno check`; auditores `saas-shield-br` |
| 3 | Portal do lojista e painel da plataforma | Fluxo E2E com a janela real da Datafy |
| 4 | Alerta operacional no health worker | Alerta real recebido na URL configurada |
| 5 | Vincular o canal da Moralles (`datafy_link_existing`) e piloto com a segunda loja | Loja conectada sem SQL nem colar nada à mão |

Gates de merge: `npm run typecheck`, `npm test`, lint, pré-voo local, `rls-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`, `migration-validator`, `secret-hunter`, `integration-reliability-auditor`, `acl-estatico`. Invariantes novos entram no par CLAUDE.md/AGENTS.md no mesmo change.

---

## 11. Questões decididas (aprovadas em 2026-10-13, conforme recomendação)

1. **Número só Cloud API (sem app).** Decidido: não suportar nesta entrega. Sem app não há eco, e o contrato de paridade não se aplica nem se prova. Se o cliente conectar assim, o `confirm` não assina, alerta o admin e o canal fica no trial até decisão.
   **Revisado em 2026-10-14 pela Fase 0** ([relatório §4 item 5](2026-10-13-datafy-parceiro-validacao-fase0.md)): o GET da Datafy não traz `coexistence`, então o `confirm` não tem como recusar pela fonte confiável. O `confirm` assina assim que o número aparece no GET; "não suportar" passa a significar "nunca ativa", porque a ativação exige o eco. O custo de um número sem app é o canal que a liberação já autorizava, até o admin cancelar (o painel aponta o canal assinado sem eco). O `coexistence` do `postMessage` só alimenta um aviso no portal. As colunas `provider_coexistence` (§5.3) e `coexistence` do onboarding não são criadas, e a checagem `coexistence = true` do `official_connect_confirm` (§5.4) sai.
2. **Momento da assinatura.** Recomendação: no `confirm`, logo após o número aparecer no GET. Assinar antes (no `start`) paga por quem desiste no meio; assinar depois do eco arrisca o fim do trial de 2 dias.
3. **Loja suspensa por inadimplência.** Recomendação: nesta entrega, pausa e cancelamento manuais pelo painel. Acoplar ao `whatsapp_service_enforcement` fica para a entrega de custo.
4. **Alcance da liberação.** Recomendação: uma liberação = um canal pago; reconectar o mesmo canal não consome nova.
