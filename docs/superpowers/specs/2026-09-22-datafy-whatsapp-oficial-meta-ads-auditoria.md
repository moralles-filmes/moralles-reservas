# FASE 0 — Auditoria: Datafy + API Oficial do WhatsApp + Meta Ads

**Data:** 2026-09-22 · **Branch:** `feat/datafy-whatsapp-oficial` · **Status:** auditoria concluída, plano pendente de decisões de negócio

Documento de FASE 0 conforme o prompt mestre de integração. Nenhum código foi alterado. Fontes: leitura do repositório em worktree isolada + documentação vigente da Datafy (`developers.datafyapi.com.br`) e da Meta.

---

## 1. Conclusão que organiza tudo o mais

**A Datafy é um proxy transparente da WhatsApp Cloud API da Meta.** A própria documentação define o uso como "usar a API oficial mudando URL e token", entrega webhooks no **formato Meta idêntico, sem modificação**, e expõe um escape hatch nativo ("Outros endpoints da Meta").

Este repositório **já tem** um provider `official` = Meta Cloud API, com parsers de inbound, status, ecos de coexistência e peek de mídia no formato Meta, validação HMAC sobre raw body, guarda de identidade por `phone_number_id` e split de lote `entry[]/changes[]`.

Portanto: **a Datafy não é um provider novo do zero — é uma variante do `official` que já existe.** O trabalho real não está em "escrever um adapter", está em duas frentes que hoje não existem para provider nenhum:

1. **Estender o contrato de provider**, que hoje é texto-puro.
2. **Separar ingestão de webhook do processamento**, porque o orçamento de 20s da Datafy é incompatível com o pipeline síncrono atual.

---

## 2. Arquitetura atual (o que existe)

### 2.1 Camada de provider

| Arquivo | Papel |
|---|---|
| [`_shared/whatsapp-provider-core.ts`](../../../supabase/functions/_shared/whatsapp-provider-core.ts) (1311 l.) | Contrato `WhatsAppProviderAdapter`, `PROVIDER_CAPABILITIES`, parsers puros, snapshots de conexão |
| [`_shared/whatsapp-providers.ts`](../../../supabase/functions/_shared/whatsapp-providers.ts) (630 l.) | Fachada + `createWhatsAppProviderRegistry` com 4 adapters; validação de assinatura |
| [`_shared/whatsapp-send.ts`](../../../supabase/functions/_shared/whatsapp-send.ts) (399 l.) | Porta única de envio, com gate de billing e gate de conexão fail-closed |
| [`webhook-whatsapp/index.ts`](../../../supabase/functions/webhook-whatsapp/index.ts) (3695 l.) | Ingestão + dedupe + debounce + lock + agente de IA + envio, tudo síncrono |
| [`manage-channels/index.ts`](../../../supabase/functions/manage-channels/index.ts) (1926 l.) | Ciclo de vida de canal; 14 actions com dois níveis de autorização |

Providers registrados: `zapi`, `waha`, `official` (Meta Cloud API), `uazapi`.

### 2.2 O contrato de envio é texto-puro — este é o limite estrutural

```ts
export interface OutboundMessage { toPhone: string; text: string; }

export interface WhatsAppProviderAdapter {
  sendText(credentials: ChannelCredentials, message: OutboundMessage): Promise<SendResult>;
  // ...parsers, status, QR, lifecycle
}
```

Não existe caminho de código para `template`, `components`, `language`, mídia, interativos, reação, `mark_as_read` ou typing. `InboundMessage.text` é `string`; mídia recebida só é **espiada** (`peekInboundMedia` devolve o *tipo*, sem id, sem mime, sem URL) e respondida com texto fixo.

### 2.3 O que a Meta/`official` já resolve e é reaproveitável integralmente

- `parseOfficialInbound`, `parseOfficialStatus`, `parseOfficialOwnMessageEchoes` (coexistência `smb_message_echoes`), `peekOfficialMedia`
- `validateMetaSignature` — HMAC-SHA256 sobre **raw body** via `crypto.subtle`, comparação em tempo constante
- `req.text()` antes de qualquer `JSON.parse` ([`index.ts:1605`](../../../supabase/functions/webhook-whatsapp/index.ts))
- `metaPayloadMatchesChannel` — guarda cross-tenant por `phone_number_id`
- `splitMetaWebhookPayload` — lote Meta separado por evento/mensagem
- `MAX_WEBHOOK_BODY_BYTES`

### 2.4 Multi-tenant, idempotência e observabilidade que já existem

- `organizations → units → unit_members`; `customers` pertencem à **organização**
- Idempotência inbound: PK composta `processed_messages(provider, message_id)` + claim cercado por UUID com takeover em 90s
- Lock de conversa por TTL (`conversations.ai_lock_until`) + debounce de rajada de 6s
- Append atômico em `conversations.messages` via RPC com dedupe por `event_id`
- Rastreio de entrega: `notifications_sent` com `delivered_at`/`read_at`/`failed_at`, correlação por `(unit_id, whatsapp_provider, whatsapp_channel_id, provider_message_id)`
- Telemetria: `webhook_executions` (FORCE RLS, TTL 30d, ~45 outcomes distintos)
- Padrão outbox já provado em `notification_outbox` e em `asaas-webhook` (persist-before-process, `req.text()` separado do parse)

---

## 3. O que NÃO existe (verificado, não presumido)

### Banco — nenhuma destas estruturas existe
| Estrutura | Situação |
|---|---|
| Templates oficiais Meta (WABA, categoria, status APPROVED/PENDING/REJECTED, quality) | **Não existe.** Só `reservation_message_templates` e `waitlist_message_templates`, que são texto livre interno |
| Campanhas / campaign recipients | **Não existe.** Declarado como futuro na UI de relatórios |
| Consentimento (opt-in) / suppression list | **Não existe.** Só o booleano `customers.do_not_contact`, sem data, canal, origem ou finalidade |
| `ctwa_clid`, referral, atribuição de anúncio, dataset, CAPI | **Não existe em lugar nenhum** |
| Eventos de webhook brutos por provider | **Não existe.** `webhook_executions` guarda telemetria sanitizada, nunca o payload |
| Mídia/anexos (media_id, mime, storage path) | **Não existe** |
| Fila/queue genérica | **Não existe.** Só `notification_outbox` (kinds fixos) + `pg_cron`/`pg_net` fire-and-forget |

Bucket de Storage: **um só**, `unit-assets`. Próxima migration: timestamp `> 20260922150000`, numeração `_110_`.

### Código
Envio de template · mídia (download/armazenamento) · interativos (botões/listas) · `mark_as_read` · typing · janela de 24h centralizada · qualquer coisa de Meta Ads.

### Interface
- **Não existe tela de "Integrações".** WhatsApp é a única integração de canal.
- [`src/pages/gestao/Automacao.tsx`](../../../src/pages/gestao/Automacao.tsx) (1792 l.) — onde canais, IA e prompt são configurados — está **órfã de rota `/g/`**. Só é acessível por `platform_admin` em `/platform/automacao/:slug`. O lojista nunca vê.
- O lojista tem apenas `/g/:slug/whatsapp` (QR), e **só funciona se o provider padrão for UazAPI** (guardas `UAZAPI_NOT_SELECTED` / `PROVIDER_SWITCH_REQUIRES_PLATFORM_ADMIN`).
- Chat é **text-only**: `<p>{msg.content}</p>`. Mídia chega já destruída como `[imagem]`.
- RBAC: 3 papéis sem granularidade. `isGerente` é o único gate real.

---

## 4. Matriz Datafy — o que muda em relação ao `official` atual

| Dimensão | `official` (hoje) | `datafy` (novo) |
|---|---|---|
| Base URL | `graph.facebook.com/v19.0` | `cloud.datafyapi.com.br/v1` (+ `/me`, `/media/{id}` fora do `/v1`) |
| Autenticação | `Bearer {access_token}` da Meta | `Bearer sk_live_...` (substitui o token Meta por completo) |
| Assinatura do webhook | `x-hub-signature-256` = HMAC(app_secret, body) | `x-datafy-signature-256` = HMAC(`whsec_...`, **`{timestamp}.{body}`**), hex com prefixo `sha256=` |
| Anti-replay | — | `x-datafy-timestamp`; recomendação de recusar entregas > 5 min |
| Idempotência de entrega | só `message.id` | **`x-datafy-delivery-id` (UUID)**, repetido nas reentregas |
| Descoberta de IDs | manual | `GET /me` → `cliente_id`, `phone_number_id`, `waba_id`, `business_id` |
| Configuração do webhook | app Meta | **bloqueada por API (403)** — obrigatoriamente manual no painel Datafy |
| Prazo de resposta | não documentado | **HTTP 200 em 20 s**; retry 3× (2 s, 10 s, 30 s); eventos de sync com escada estendida |
| Rate limit | limites Meta | 500 req/min (mensagens), 60 req/min (mídia), 60 req/min (consultas); `429` com tempo de espera na mensagem |
| Erros | Meta | `401` token, `402` assinatura inativa, `403` bloqueado, `429`; erros Meta repassados intactos com `code` + `fbtrace_id` |
| Mídia recebida | Graph | `GET /media/{id}` → `{ url, mime_type, size }`, **URL válida 30 dias**; a Datafy não retém além disso |
| Operações bloqueadas | — | `subscribed_apps`, `deregister`, `webhook_configuration`, `pin`, DELETE de número/WABA, IDs fora do token |

### Feature matrix (capacidades declaradas pela documentação vigente)

**Suportado diretamente** — texto, imagem, áudio, vídeo, documento, sticker, localização, solicitação de localização, contato, reação, botões, lista, botão com link, carrossel, marcar como lida, indicador de digitação, respostas contextuais, upload/obter/deletar mídia, criar/editar/listar/deletar/enviar/migrar template, status e limites do número, sincronizar histórico, sincronizar contatos, proxy para qualquer endpoint Meta.

**Suportado via proxy da Meta** — qualquer endpoint da Cloud API não listado acima, pelo mesmo par URL+token.

**Condicional (coexistência)** — `smb_message_echoes` (mensagens do aparelho), `history` (até 6 meses), `smb_app_state_sync` (contatos, primeiras 24h). Grupos não sincronizam.

**Necessita configuração adicional** — webhook (manual no painel), portfólio Meta verificado, forma de pagamento cadastrada na Meta.

**Não aplicável hoje a este SaaS** — catálogo/produtos, order messages, Authentication (não há login por WhatsApp).

---

## 5. Riscos e regressões (achados que mudam o plano)

**R1 — O orçamento de 20 s da Datafy é incompatível com o webhook atual.** `webhook-whatsapp` faz, dentro da resposta HTTP: debounce de 6 s (sleep) → claim → chamada de LLM (timeout 12 s × até 2 retries) → envio. Com Z-API/UazAPI não havia prazo documentado. A Datafy corta em 20 s e reentrega 3×. O dedupe `(provider, message_id)` e o lock de conversa impedem resposta duplicada, mas o canal entraria em retry permanente e a telemetria ficaria ilegível. **Separar ingestão de processamento deixa de ser refinamento e vira pré-requisito.**

**R2 — `parseOfficialInbound` descarta tudo que não é `type === "text"`.** `referral` (com `ctwa_clid`), `context` (reply citado) e todo tipo não-texto são perdidos antes de qualquer persistência. Sem mexer nisso, atribuição de anúncio é impossível — e o referral não volta depois.

**R3 — Preço da Meta muda em 1º/out/2026 (9 dias).** Passa a haver 1.000 mensagens de serviço grátis/mês por número; acima disso R$ 0,035. Templates Utility perdem a isenção dentro da janela. Marketing segue R$ 0,32. A janela de 72 h gratuita para Click-to-WhatsApp permanece. **Consequência estrutural:** o custo de Cloud API é **por mensagem**, enquanto todo o maquinário de `whatsapp_instances` / `whatsapp_instance_cycles` modela **custo mensal fixo por instância**. Esse modelo não representa Datafy.

**R4 — Template aprovado pela Meta é incompatível com o editor de texto livre atual.** Hoje o lojista edita `reminder_d1`/`survey_d1` (600 chars) e os 3 de fila (300 chars) à vontade. Template Meta tem texto fixo aprovado + variáveis. Ou a estrutura congela (só variáveis substituíveis), ou cada edição vira submissão por tenant com aprovação assíncrona.

**R5 — `confirmation` e `cancellation` têm linha condicional** (`💸 Desconto: X% off` só aparece se houver desconto). Template Meta não aceita linha opcional: vira dois templates ou parâmetro sempre preenchido.

**R6 — `notifications_sent.kind` tem CHECK fechado com 9 valores** e `whatsapp_channels.provider` com 4. Kind ou provider novo exige migration — e `processed_messages.provider` também.

**R7 — O gate de frescor de conexão é fail-closed e consulta o provider antes de enviar.** Para Cloud API "conectado" não tem o mesmo significado (não há sessão/QR; o número está ativo enquanto a conta estiver regular). Sem tratamento próprio, cada envio vira uma consulta HTTP extra — e, pior, a semântica de `disconnected` passa a ser inventada.

**R8 — Duas APIs para o mesmo recurso.** `useWhatsAppChannels` (admin, rico) e `useWhatsappConnection` (lojista, client-safe) batem na mesma Edge Function com contratos diferentes. Provider novo exige mexer nos dois.

---

## 6. Inventário de mensagens (base para os templates oficiais)

Proativas — **exigem template aprovado fora da janela de 24 h**:

| Mensagem | `kind` | Categoria Meta | Customizável hoje |
|---|---|---|---|
| Confirmação de reserva | `confirmation` | UTILITY | ❌ hardcoded |
| Cancelamento de reserva | `cancellation` | UTILITY | ❌ hardcoded |
| Lembrete do dia (10:00 BRT) | `reminder_d1` | UTILITY | ✅ 600 chars |
| Pesquisa de satisfação D+1 (14:00 BRT) | `survey_d1` | UTILITY | ✅ 600 chars |
| Entrou na fila | `waitlist_entered` | UTILITY | ✅ 300 chars |
| Mesa pronta | `waitlist_table_ready` | UTILITY | ✅ 300 chars |
| Feedback pós-fila (14:00 BRT) | `waitlist_feedback` | MARKETING | ✅ 300 chars |
| Giftback / voucher (09:00 BRT) | `voucher_issued` | **MARKETING** | ✅ via `settings` |

Transacionais (dentro da janela, texto livre, **não precisam de template**): resposta do agente de IA, handoff, resposta a mídia, comentário de pesquisa, bloqueio de franquia de IA, resposta manual do atendente.

---

## 7. Plano proposto — fases

Cada fase fecha com gates do projeto (`typecheck`, `vitest`, pré-voo local, `saas-shield-br:*` quando tocar banco/auth/RLS/webhook) e é mergeada antes da seguinte.

| Fase | Entrega | Depende de |
|---|---|---|
| **A — Fundação do provider** | Estender `WhatsAppProviderAdapter` com métodos **opcionais** (`sendTemplate`, `sendMedia`, `markAsRead`, `getNumberHealth`, `fetchMedia`, `cloudApiRequest`) + capability flags. Backwards-compatible: adapters atuais não mudam. | — |
| **B — Adapter Datafy** | `datafy` no registry reusando os parsers `official`; cliente HTTP central; `/me` para descoberta; assinatura `x-datafy-signature-256` com timestamp e anti-replay; migrations de CHECK (`provider`) | A |
| **C — Ingestão assíncrona** | Tabela de eventos brutos com idempotência por `x-datafy-delivery-id`; webhook responde rápido; processamento durável; dead letter. **Resolve R1** | B |
| **D — Referral / CTWA** | Capturar `referral` + `ctwa_clid` no parser; touchpoints por contato (sem sobrescrever). **Resolve R2** | C |
| **E — Mensagens ricas** | Mídia (download + Storage + retenção), interativos, reply, mark-as-read; chat renderiza | A, C |
| **F — Templates oficiais** | CRUD + sincronização + status por webhook; reconciliação com os editores atuais. **Endereça R4/R5** | B |
| **G — Janela de atendimento** | `WhatsAppEligibilityService` central, validado **no momento do envio** | F |
| **H — Campanhas** | Audiência, consentimento, suppression, fila durável, rate control, custo, pause/cancel, test send | F, G |
| **I — Meta CAPI** | Dataset, mapeamento de eventos, outbox, dedupe, test mode | D |
| **J — Observabilidade e custo** | Health, alertas, métricas, painel de custo por categoria com regra versionada por vigência. **Endereça R3** | C |

---

## 8. Decisões de negócio — tomadas em 2026-09-22

| # | Decisão | Consequência |
|---|---|---|
| 1 | **Datafy convive; vira o padrão para unidades novas.** Z-API, WAHA e UazAPI ficam intactos. | O Ren Sushi **não migra** nesta entrega. Nenhum canal existente muda de provider. Cutover do cliente em produção é fase futura, explícita e reversível. |
| 2 | **Escopo desta entrega: fases A–D.** | Contrato estendido, adapter Datafy, ingestão assíncrona e captura de referral/`ctwa_clid`. Fases E–J ficam fora. |
| 3 | **Os 8 templates entram no catálogo** (4 de reserva + 3 de fila + giftback). | A **redação** dos 8 templates é entregue agora (a aprovação da Meta é assíncrona e leva dias — adiantá-la é ganho puro). A **implementação** do módulo continua na Fase F. |
| 4 | **Sem anúncio CTWA hoje; preservar o dado desde já.** | Fase D captura e persiste `referral`/`ctwa_clid` em touchpoints. A Conversions API (Fase I) fica para quando houver anúncio real — não se inventa atribuição sem evidência. |

### Premissas adotadas (não bloqueiam A–D; confirmar antes das fases que dependem delas)

- **Propriedade do WABA:** o token Datafy (`sk_live_`) é por número e o `/me` devolve o `waba_id` dele. Credencial fica **por unidade**, em `whatsapp_channels.credentials` — que já é FORCE RLS sem policy. Sem mudança de modelo de tenancy.
- **Mídia (Fase E):** segue **sem download**. A Fase C preserva o payload bruto, então `media_id`, mime e tamanho ficam registrados mesmo sem baixar o arquivo — a decisão de armazenar pode ser tomada depois sem perder o passado. A URL da Datafy expira em 30 dias.
- **Modelo de custo (Fase J):** permanece em aberto e **flagged**. Cloud API cobra por mensagem; `whatsapp_instance_cycles` modela mensalidade fixa por instância. Nenhuma unidade Datafy deve entrar nesse maquinário sem que a política exista.

---

## 9. Pendências de validação real

**VALIDAÇÃO REAL COM PROVIDER PENDENTE.** Nada nesta auditoria foi exercitado contra a Datafy — não há credencial disponível nesta sessão. A documentação foi lida como fonte de verdade, mas este repositório já registra um precedente em que o envelope real do provider divergiu da documentação e uma suíte verde por 14 dias exercitava uma forma inventada. Portanto, antes de anunciar paridade:

- `GET /me` com token real → confirmar campos
- 1 webhook real recebido → confirmar envelope, headers e assinatura (instrumentação de **forma**, nunca de valor)
- 1 envio de texto → confirmar `messages[0].id` e o formato de `wamid.`
- 1 recibo de status → confirmar correlação

## Pendência bloqueante para a Fase F (templates)

Evento WABA sem `metadata.phone_number_id` — `message_template_status_update`, `account_update`, `phone_number_quality_update` — faz o webhook responder **401**; num lote misto derruba o lote inteiro em 500, e a Meta reentrega indefinidamente.

Cadeia, verificada no código durante a review da Task 5: `metaPhoneNumberIds` só coleta ids de `changes[].value.metadata`; evento de template não tem `metadata`; `splitMetaWebhookPayload` re-despacha a parte não categorizada; o filho roda `metaPayloadMatchesChannel`, obtém lista vazia e recusa; o pai devolve `meta_batch_partial_failure`.

**Não é regressão da Task 5** — é byte-a-byte o que o provider `official` já fazia, e corrigir agora violaria a constraint "nenhum canal existente muda". Está dormente porque nenhum WABA assina esses eventos antes de existir template, e segue dormente nas Fases A–D: o `referral`/`ctwa_clid` da Fase D chega dentro de `messages[]`, que tem `metadata`.

**A Fase F não sobe sem decidir entre:** (a) 401 fail-closed, e então a assinatura desses eventos fica desligada no WABA; ou (b) 200 ignorando evento sem `metadata`, e então a decisão vale também para `official`.

### A superfície é mais larga que o caso do `metadata` (auditoria de confiabilidade)

A auditoria pós-Task 5 corrigiu o recorte acima: o `500` do pai não depende de o filho ter falhado por `metadata` ausente. Em `webhook-whatsapp/index.ts:1745`, **qualquer** `result.ok === false` de qualquer parte do lote propaga como 500 — 401 de assinatura, 404 de canal não encontrado, 400 de JSON inválido, 413 de payload grande. O caso do `metadata` é o mais provável, não o único.

Consequência para a decisão: a saída (b) não pode ser "200 quando falta `metadata`". Ela tem que responder, parte a parte, **quais falhas de filho são retentáveis pela Meta e quais não são** — uma assinatura inválida num filho merece 401 de verdade; um evento que este canal simplesmente não sabe tratar merece 200 e descarte registrado. Hoje os dois produzem o mesmo 500.

Esse caminho passou a ter duas portas de entrada (`official` e `datafy`, ambos sob `isMetaShapedProvider`), então a correção alcança os dois de uma vez — o que reforça que ela não cabe nas Fases A–D, cuja constraint é não mudar canal existente.
