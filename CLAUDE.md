# moralles-reservas

Sistema de reservas de mesa para restaurante com agente de IA via WhatsApp. Multi-tenant: `organizations → units → unit_members`.

---

## 🧭 O que pertence neste arquivo (regra de ouro)

**Só entra aqui o que muda decisão de código futuro** — invariantes que evitam bug, gotchas de stack, contratos cross-feature. Antes de adicionar algo:

- Descobrível em `ls` / `git log` / `git blame` / lendo o próprio arquivo? → **não entra**. Comentário curto no código.
- Histórico ("bug X foi corrigido em data Y", "antes era A, hoje é B")? → **não entra**. Git já guarda.
- Status transicional ("legado", "deprecated", "será removido")? → **não entra**. Marca `@deprecated` no código ou remove de vez.
- Invariante futuro ("RLS força X", "writer Y precisa chamar RPC Z")? → **entra**, em **uma frase de regra + uma frase de por quê + ponteiro `arquivo.ts:linha`**. Sem storytelling.

### Regra para agentes IA editando este arquivo (humanos e bots)

- **Atualize proativamente quando descobrir invariante novo**, sem esperar o usuário pedir. Vale pra: gotcha de stack, contrato entre Edge Functions, RLS/multi-tenant, padrão cross-feature.
- **Aplique o filtro acima antes de escrever a linha.** Se cai em descobrível/histórico/status, NÃO entra — vai pro código como comentário curto, ou some.
- **Formato obrigatório:** `**regra em 1 frase.** Por quê (1 frase). [arquivo.ts](arquivo.ts).` Sem parágrafos longos, sem datas de bug.
- **Audite ao notar inchaço.** Quando o arquivo passar de **40K chars**, é prioridade — corte o que virou ruído antes de adicionar mais.

---

## ⚠️ Segurança antes de commitar (LEITURA OBRIGATÓRIA)

Repo público no GitHub + deploy automático Vercel: secret vazado é público em segundos e exige rotação no provider (push --force NÃO apaga o que bot já indexou).

1. **Rode `git status` + `git diff --cached`** — revise 100% das linhas adicionadas.
2. **Padrões de secret a procurar:** `sk-`, `sk-ant-`, `xai-`, `re_`, `AIza`, `eyJ` (JWT), `Bearer `, `Basic `, `service_role`, `SERVICE_ROLE_KEY`, `password`/`senha`/`secret`/`token`/`api_key`/`client_token` com valor real, URLs com creds embutidas (`https://u:p@...`, `postgres://...:...@...`), webhooks com secret no path/query.
3. **Nunca commitar:** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `service-account*.json`, `supabase/.env`, dumps de DB.
4. **Sempre `git add caminho/arquivo`** — nunca `git add .` / `git add -A` sem revisar a lista antes.
5. **Secrets de Edge Function → `supabase secrets set`**, NUNCA no `.env` do frontend ou comentários.
6. **`VITE_*` é público no bundle** — só pra `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. Qualquer outra chave NÃO pode ter esse prefixo.
7. **Em dúvida, não commite** — pergunte antes.

Se um secret foi commitado: pare imediatamente, **rotacione no provider antes de qualquer push** (reescrever história não basta — bots já indexaram), atualize `supabase secrets set` e o Vault. Esta regra supera qualquer "commita rápido".

---

## Comandos

`npm run dev` (localhost:8080), `build`, `preview`, `lint`, `test`, `test:watch`. `npm install --legacy-peer-deps` (.npmrc força — react-day-picker vs date-fns v4).

**`npm run typecheck` = `tsc -b --noEmit`. NUNCA `tsc --noEmit` sem `-b`** — root tem `files:[]` + references, sem `-b` vira no-op silencioso (exit 0 sem checar). Rodar antes de commitar (dev server SWC não tipa). Baseline: zero erros, qualquer novo é regressão.

---

## Variáveis de ambiente

Frontend (`.env`): só `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`. EFs: `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_API_KEY` (auth workers), `RESEND_API_KEY` + `RESEND_FROM_EMAIL` (opcional).

- **`INTERNAL_API_KEY` precisa estar no Supabase Vault TAMBÉM** (`vault.create_secret(..., 'internal_api_key')`) pra `pg_cron` funcionar. Rotacionar nos DOIS lugares.
- **Stripe e chaves de IA NÃO ficam em env vars.** Stripe em `platform_secrets` (DB, painel `/platform/automacao`); chaves de IA per-unit em `ai_provider_credentials` (BYOK, `/platform/automacao/<slug>`). Sem fallback global pra IA.

---

## Roteamento (gotchas)

Estrutura completa em `src/App.tsx`. O que NÃO é descobrível:

- `/r/:slug` aceita `?mode=embed` (sem chrome, pra iframe) e `?action=reservar|waitlist` (auto-abre dialog). Combinável.
- `/acompanhar/:token` é página pública (sem login) de status de reserva/fila; `token` = `reservations.id` OU `waitlist.id` (UUID), resolvido pela RPC `get_public_tracking`. Link enviado ao cliente (fila ao entrar em `process-waitlist-entered`, lembrete D-0 em `process-reservation-reminders`) aponta pra cá — não mais pra `/r/:slug`.
- `/g/:unitSlug/cobranca` é a única rota whitelisted no `BillingGuard` quando org está `blocked/suspended/canceled` — sem isso, cliente bloqueado entra em loop.
- `/platform/*` é exclusivo de `platform_admin`. Edge Functions `manage-channels`, `manage-ai-providers`, `manage-billing`, `manage-organizations`, `manage-stripe-accounts`, `manage-platform-secrets`, `whatsapp-health` validam `platform_admin` no JWT.

---

## Banco de dados

### Modelo de tenancy

```
organizations (cliente SaaS)
  └── units (restaurante físico)
        └── unit_members (user_id, unit_id, role: owner|gerente|operador)
```

`customers` pertencem à **organization** (cliente reserva em qualquer unidade da rede). Todas as outras tabelas de negócio levam `unit_id`.

### Migrations

- Formato `YYYYMMDDHHMMSS_nome.sql` (Supabase CLI). **Idempotentes por design.**
- **Aplicar SEMPRE via `supabase db push`** — nunca colar SQL no Studio/SQL Editor. Studio grava em `schema_migrations` com timestamp ≠ filename, e o próximo `db push` fica bloqueado por drift; recovery exige `supabase migration repair --status reverted <ver>`.

### Modelo de reservas (availability.ts — contrato cross-feature)

[supabase/functions/_shared/availability.ts](supabase/functions/_shared/availability.ts) é fonte única de verdade compartilhada por `webhook-whatsapp` e `create-reservation`. Ordem de resolução:

1. **Janela de reserva** (`settings.booking_window_days`)
2. **`special_dates`** — override fechado bloqueia; aberto substitui hall_schedule
3. **Halls ativos** — special_date do hall > global, depois `hall_schedules` do dia
4. **Antecedência mínima** da janela que cobre o horário
5. **Mesas compatíveis** — `min_capacity ≤ partySize ≤ max_capacity`; `allow_empty_seat` aceita `partySize ≥ min - 1`
6. **`table_blocks`** — `table_id IS NULL` = macro (fecha hall/unit)
7. **First-fit** — aloca menor mesa disponível
8. **Overbooking** — se ativo, cria reserva floating (`table_id: null`) em vez de rejeitar

- **Timestamps em `availability.ts` SEMPRE com offset BRT explícito (`-03:00`).** Deno runtime é UTC; sem offset, comparação contra `table_blocks.blocked_from/to` (BRT no banco) fica 3h fora e bloqueios parciais (ex.: 19h-22h) deixam reservas escaparem na borda. Replicar em qualquer query nova nesse arquivo.

### Invariantes de tabelas

- **`reservations.source` (`web`/`whatsapp`)** é load-bearing: trigger `enqueue_confirmation_notification` filtra `source != 'whatsapp'` pra não duplicar template. Qualquer Edge Function nova que crie reserva via agente DEVE passar `source: "whatsapp"` em `reserveSlot` — frontend/wizard usa default `'web'`.
- **Reserva manual ([create-manual-reservation](supabase/functions/create-manual-reservation/index.ts)) DESACOPLA notificação de `source`.** Operador escolhe origem (relatório) E "avisar cliente" separadamente; como o trigger acopla os dois, a EF reconcilia `notification_outbox` no pós-insert (insere se notify=ON, deleta pendente se OFF). NÃO inferir intenção de notificar a partir de `source` em código novo. EF é autenticada (`is_unit_member`/`is_platform_admin`), isenta de rate-limit e caução.
- **`reserveSlot({ override: true })` força reserva flutuante** (`table_id: null`) quando a validação recusa — exclusivo da reserva manual do operador. Não usar em path público.
- **Operador não cancela reserva — forçado por trigger `enforce_operador_no_cancel()` (BEFORE UPDATE em `reservations`).** Bloqueia transição pra `status='cancelled'` quando `auth.uid()` é membro `operador` da unit; service_role (workers/agente/Stripe, `auth.uid()` null) e gerente/owner/platform_admin passam. Path novo que cancele via Edge Function `service_role` bypassa o trigger silenciosamente — gatear o papel no próprio EF. Frontend espelha em [ReservaCard.tsx](src/components/reserva/ReservaCard.tsx) (`canCancel = useCurrentUnit().isGerente`).
- **`customers.email` é array (`emails[]`)** — append-only via `resolveOrCreateCustomer`.
- **`business_hours`** é DEPRECATED — fonte de horário é `halls + hall_schedules`. Não construa nada novo em cima.
- **Tabelas com credenciais usam `FORCE RLS` sem policies** (`whatsapp_channels`, `ai_provider_credentials`, `processed_messages`, `rate_limit_events`, `platform_secrets`, `stripe_accounts`, `stripe_webhook_events`, `billing_customers`, `billing_subscriptions`, `billing_invoices`, `billing_events`, `billing_notifications`, `webhook_executions`). UI acessa via Edge Function.
- **`vouchers_unit_rule_customer_active_idx`** (UNIQUE PARTIAL em `vouchers` WHERE status='active' AND rule_id NOT NULL) garante no máximo 1 voucher ativo por (unit, rule, customer). Sempre tentar INSERT e tratar `23505` como dedupe silencioso.
- **`voucher_rules` CHECK exige `min_rating NOT NULL` quando `trigger_type='after_rating'`** — queries do webhook usam `.lte('min_rating', rating)` puro.
- **`organizations.billing_status`** é coluna autoritativa pro `BillingGuard` frontend E pra checks server-side em `create-reservation` / `webhook-whatsapp`. Valores: `active`, `trialing`, `pending_payment`, `past_due`, `grace_period`, `blocked`, `canceled`, `manual_override`, `suspended`. Default `'active'`.
- **`audit_log`** usa trigger genérico `audit_trigger_func()` em `customers`, `reservations`, `unit_members`. Reservas/membros logam `unit_id`; clientes logam `organization_id` (porque pertence à org). Query nova em `audit_log` precisa `.or(unit_id.eq.X, organization_id.eq.Y)` cobrindo os 2 — filtrar só por `unit_id` esconde mudanças de cliente.

### RLS

- **Anon insere em `customers`/`reservations`/`waitlist`** (units públicas), e **lê só por RPCs `SECURITY DEFINER`** (`get_unit_public_full`, `get_widget_public`, `get_public_hall_schedules`, `get_public_business_hours`, `get_public_tracking`). Policy `TO anon` direto em tabela de negócio é regressão. **`get_public_tracking(p_token uuid)` só devolve dados públicos (1º nome, sem telefone/e-mail/`notes`) gateado por `units.is_public` — campo novo no payload DEVE permanecer privacy-safe.**
- **`anon_insert_*` policies têm `EXISTS (... WHERE is_public)`**.
- **Authenticated** escopado por `is_unit_member(auth.uid(), unit_id)`. Edge Function bypassa via `SUPABASE_SERVICE_ROLE_KEY` mas deve validar `unit_id` da request contra o recurso (defense-in-depth).
- **Toda policy RLS escopada por `unit_id` precisa de contraparte `platform_admin_*`** via `is_platform_admin(auth.uid())` — vale pra tabelas E pra `storage.objects` de buckets multi-tenant. `useCurrentUnit.ts` fabrica pseudo-membership "owner" pra super-admin operar units alheias; sem o paralelo, write é bloqueada apesar da UI mostrar "Proprietário".
- **Todo guard server-side com `is_unit_member` precisa do paralelo `is_platform_admin`** — vale pra Edge Function E pra RPC `SECURITY DEFINER` com check inline. Mesma razão. Pattern EF: `Promise.all([rpc("is_unit_member", ...), rpc("is_platform_admin", ...)]); if (!member.data && !admin.data) forbidden;`. Pattern RPC: `if not (is_unit_member(uid, unit) or is_platform_admin(uid)) then raise ...`. Aplicado em `send-manual-message`, `send-cancellation`, `update-reservation`, `enter_waitlist`.

### Storage (bucket `unit-assets`)

Path: `<unit_id>/logo-<ts>.<ext>`. CDN read público; listing bloqueado; write só owner/gerente. Substituir asset NÃO apaga blob antigo — sem cleanup, custo acumula.

**Cleanup duplo obrigatório em qualquer feature que escreva no bucket:**

1. **Diff DB-vs-form no save** — capturar URLs prévias ANTES da mutation, comparar com form depois, apagar paths que sumiram. Helpers em [src/lib/storage.ts](src/lib/storage.ts): `deleteUnitAssetByUrl(url, unitId?)` / `deleteUnitAssetsByUrls`.
2. **Tracking de sessão (`uploadedRef = useRef<Set>()`)** — uploaders chamam `onUploaded({ publicUrl, path })`. No save, paths em `uploadedRef` que não ficaram no estado final são candidatos a remoção. Cobre "Trocar A→B→C".
3. **`storage.remove()` NÃO lança** em RLS denied / file missing — retorna `{ error }`. Sempre destruturar e logar.
4. **SEMPRE filtrar paths via `extractStoragePath()` de `@/lib/utils`** (rejeita URL de outro bucket → null) E confirmar `path.startsWith(<unit_id>/)` (defesa cross-tenant).

NUNCA `DELETE FROM storage.objects` via SQL — SQL bypassa policies e pula triggers internos. Worker `cleanup-orphan-assets` (dom 04:00 UTC) cobre "usuário fechou aba sem salvar" (cleanup `onUnmount` rejeitado: Strict Mode double-mount; `beforeunload` flaky em SPA).

**`units.price_range_min/max`:** UI tem campo único "ticket médio" → grava SÓ `price_range_max`, deixa `price_range_min` NULL. Formatters renderizam "até R$ X" no branch `min == null && max != null`.

---

## Wizard de reserva pública

Fluxo público (`/r/:slug` e `/w/:slug`) em [src/components/reserva/wizard/useReservaWizard.ts](src/components/reserva/wizard/useReservaWizard.ts) (state machine + Zod por step).

- **E-mail é obrigatório no frontend público** (`z.string().email()` sem `.optional()`) MAS opcional no banco / `create-reservation` / agente WhatsApp. Não promover essa regra pro backend sem coordenar (cliente WhatsApp raramente fornece e-mail).
- **`partitionHalls()`** em [src/components/reserva/wizard/availability-helpers.ts](src/components/reserva/wizard/availability-helpers.ts) é apenas filtro visual — `_shared/availability.ts` segue como fonte de verdade no submit.
- **Mobile usa `ResponsiveDialog` (bottom-sheet `<640px`, Dialog centrado `≥640px`)** — em [src/components/ui/responsive-dialog.tsx](src/components/ui/responsive-dialog.tsx). Inputs `h-12` em mobile (tap target ≥44px); footer respeita `env(safe-area-inset-bottom)`.
- **Copy de bloqueio:** `reason: "blocked"` → "Não estamos aceitando reservas nesta data"; `reason: "closed_special"` → "Esta data o restaurante está fechado". Não confundir bloqueio (`table_blocks`) com fechamento (`special_dates is_closed`) na cópia.

---

## Dashboard e métricas

Convenções em [src/hooks/useDashboardMetrics.ts](src/hooks/useDashboardMetrics.ts) e [src/hooks/useFluxoClientes.ts](src/hooks/useFluxoClientes.ts) — replicar em hook novo de relatório.

- **Taxa de cancelamento** = `cancelled / (confirmed + cancelled + no_show) * 100`. **Exclui pending.** Retorna `null` se denom=0 (UI renderiza "—").
- **Taxa de no-show** = `no_show / (confirmed + no_show) * 100`. Mesma regra.
- **"Pessoas esperadas hoje"** soma apenas `pending` ou `confirmed`. Canceladas e no-show excluídas.
- **`KpiCard.formatValue`** renderiza "—" para `null`/`undefined`/`NaN`/`Infinity`. Suffix ("%", "⭐") só com número finito.
- **Datas de eventos com timestamp UTC** (waitlist/walk_ins/notifications_sent): use `isoToLocalDate(iso)` pra agrupar por dia local — `.slice(0, 10)` em UTC atribui dia errado em eventos próximos da meia-noite BRT.
- **`getDay()` em timestamp UTC** retorna dia da semana no fuso LOCAL do browser. Pra waitlist/walk-ins parsear via `new Date(isoToLocalDate(iso) + "T12:00:00").getDay()`. Pra reservas, `r.date` (YYYY-MM-DD) já é dia local.
- **Ordenação de timestamps** — sempre `new Date(iso).getTime()` numérico, nunca `localeCompare` (mistura de formatos com/sem Z / milissegundos quebra).

---

## Agente IA — WhatsApp

### Fluxo

```
Cliente → Provider (Z-API/WAHA/Meta) → webhook-whatsapp
  → resolve canal → load histórico → runAgentLoop()
  → save resposta (sanitizada) → sendOutbound() → Cliente
```

### Provedores

5 LLMs suportados — Claude, OpenAI, Gemini, Grok, DeepSeek. Provedor é per-unit via BYOK em `ai_provider_credentials`; modelo em `settings.ai_config.models[provider]`. Defaults e lista curada em [src/lib/aiModels.ts](src/lib/aiModels.ts) (UI) + [_shared/ai-providers.ts](supabase/functions/_shared/ai-providers.ts) (backend) — ver invariante de sincronização abaixo.

### Invariantes do agente

- **Chave de API é per-unit, SEM fallback global.** `resolveApiKey` em [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts) lê só de `ai_provider_credentials WHERE active=true`. Sem chave → `throw api_key_not_configured:<provider>` → auto-handoff. Resolver futuro NÃO pode reintroduzir fallback global (cobrança não isola por tenant).
- **Default de modelo vive em DOIS arquivos sincronizados:** [src/lib/aiModels.ts](src/lib/aiModels.ts) (`DEFAULT_MODEL_BY_PROVIDER`/`MODELS_BY_PROVIDER` — UI) + [supabase/functions/_shared/ai-providers.ts](supabase/functions/_shared/ai-providers.ts) (`DEFAULT_MODELS`/`KNOWN_MODELS` — backend blindagem). Trocar/remover modelo descontinuado: atualizar os 4 + redeploy `webhook-whatsapp` e `manage-ai-providers`. `resolveModel()` cai pro default e loga `evt:"ai_model_fallback"` quando modelo está fora do set.
- **Erro do agente é auto-handoff, não retry.** Exception em `runAgentLoop` → `conversations.status='awaiting_human'` com `handoff_reason: agent_error:<provider>:<model>` + `meta` em `webhook_executions`. Retry estrutural (modelo descontinuado, quota, key inválida) não resolve.
- **Retry silencioso (UMA vez) gated por `!mutatingToolUsed` + tempo `<30s`.** Mutating tools (`create_reservation`/`update_reservation`/`cancel_reservation`) setam `mutatingToolUsed=true` — retry duplicaria. Tool mutante nova DEVE setar a flag.
- **Mensagens não-texto (áudio/imagem/sticker) recebem `MEDIA_REPLY_TEXT` hardcoded — nunca silêncio.** `peekInboundMedia()` em `_shared/whatsapp-providers.ts` antes do `finish("ignored_non_text")`. Outcome `media_response`, zero token. Conversa em handoff humano: loga mas não responde auto.
- **Toda saída do LLM passa por `sanitizeForWhatsApp`** ([_shared/whatsapp-format.ts](supabase/functions/_shared/whatsapp-format.ts)) antes do `sendOutbound` E do `appendToConversation`. Converte markdown padrão → formato WhatsApp. **Aplicar SÓ em saída de LLM** — NÃO em hardcoded, templates do lojista, ou `send-manual-message`.
- **System prompt usa `SELECT *` em `units` e carrega TODOS os `settings`** (sem `.in()` por key). `restaurantInfoLines` (array em `webhook-whatsapp/index.ts`) é o gatekeeper: campo novo no bot = 1 linha nova. Reverter pra SELECT explícito ou `.in()` é regressão (lacunas recorrentes).
- **Data e dia-da-semana no system prompt SEMPRE derivados de BRT (`new Date(Date.now() - BRT_OFFSET_MS)`), nunca `new Date()` cru.** Deno roda em UTC; das 21h à meia-noite BRT o `new Date()` já virou o dia → bot diz "hoje é quinta" numa quarta à noite e cita preço do dia errado (cardápios com preço por dia da semana). `today`/`horizon`/`weekdayName` saem todos do mesmo `nowBrt`. Regra 11 do prompt manda casar `weekdayName` com a faixa de dias certa e nunca assumir feriado. [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts).
- **Prompt injeta `special_dates` E `table_blocks` macro próximos 60d.** Sem isso, LLM responde "sim, aceitamos pra 12/06" pra perguntas sem horário/party. Bloqueios hall-específicos recebem sufixo `— só no salão X`. Regra 5 manda LLM NÃO chamar `check_availability` quando data está na lista. Feature nova de bloqueio aparece no mesmo bloco.
- **`table_blocks` ≠ `special_dates is_closed`.** Bloqueio = "não aceitamos reservas" (restaurante pode estar aberto pra walk-in); fechamento = "restaurante não abre". Copy do prompt: "sem reservas"/"agenda indisponível" pra bloqueio; "fechado" só pra `is_closed`. Regra 5 manda dizer JUNTO: (a) não aceitamos reservas + (b) aberto, atendimento por ordem de chegada (exceto título indicar evento privado).
- **Fonte de horário no prompt é `halls + hall_schedules`**, nunca `business_hours`. Helper `buildHallSchedulesBlock(unitId)` agrupa dias com janelas iguais, anota `% off` / antecedência / caução. Fallback pra `business_hours` só se unit não tem hall ativo (pré-migration 030).
- **Bloco "Programa Giftback" SEMPRE emitido — âncora NEGATIVA explícita quando vazio.** Ausência não é negação pra LLM — ele preenche inventando promoções. Replicar padrão em qualquer bloco onde ausência possa virar invenção.
- **Regra 7 do prompt proíbe fabricar QUALQUER desconto/promoção/cortesia/brinde** (não só voucher). Nome de item de cardápio não autoriza afirmar desconto. Negar direto sem handoff.
- **Coluna JSONB NUNCA é interpolada direto em template literal.** Supabase JS retorna `jsonb` como objeto; `${obj}` vira `"[object Object]"` → LLM alucina. Tipar interface, extrair campo string, fallback `""`. Aplica a `units.address`, `customers.emails`, `whatsapp_channels.credentials`, `ai_provider_credentials.credentials`, `settings.value`, `menus.theme`, `reservations.custom_field_values`, `reservation_widgets.field_config`, `notification_outbox.payload`. Pattern em [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts) e [src/pages/PublicPortal.tsx](src/pages/PublicPortal.tsx).
- **Resolver de entidade nomeada do LLM (`hall_name`, etc.) NUNCA usa `ilike + limit(1)`.** PostgREST retorna linha não-determinística em múltiplos matches. Pattern em `resolveHallId(unitId, name, partySize?)`: busca todos com `ORDER BY sort_order, name`; 0→undefined; 1→retorna; 2+ sem partySize→undefined; 2+ com partySize→filtra por capacidade agregada (`allow_empty_seat` subtrai 1). `undefined` faz o caller iterar todos os halls.
- **`cancel_reservation` description manda LLM buscar código primeiro** (via `get_reservation`/`list_customer_reservations`). Função tem guard `if (!code?.trim())` retornando erro amigável; `.maybeSingle()` detecta zero rows. Tool nova com param lookup-dependent documenta isso na própria description.
- **Confirmações informais PT-BR listadas na regra 10** ("Isso", "Tá bom", "Pode ser", "Fechado", "Bora", "Beleza", etc.). Re-checa `check_availability` antes de `create_reservation` mesmo após confirmação.
- **Debounce de rajada por conversa.** Cada inbound é invocação independente sem fila. Webhook appenda mensagem, captura `myInboundTs`, espera `DEBOUNCE_WINDOW_MS` (6s), relê thread, desiste se há mensagem mais nova. Só a ÚLTIMA invocação prossegue e combina pendentes em `combinedUserMessage`. Path novo de inbound DEVE passar pelo debounce.
- **O debounce é OTIMISTA e não garante exclusão — backado por lock de conversa.** A comparação de timestamp falha em empate de ms e em janelas não-sobrepostas (irmão chega logo após o sleep), deixando 2 invocações rodarem o agente → 2 chamadas concorrentes ao LLM → 503/timeout → handoff DUPLICADO. Após vencer o timestamp, a invocação reivindica `try_claim_conversation_for_ai(conv, requestId, 90s)`; só o holder roda o agente, irmão bloqueado faz `finish("conversation_locked")` (markProcessed evita virar "stuck"). Release em TODOS os exit paths + outer catch; TTL 90s cobre crash. Path novo de inbound passa pelo debounce **E** pelo lock. [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts).

### Resiliência

- **Truncamento:** últimas 20 mensagens E ≤1500 tokens estimados (`truncateHistory`). Janela 72h descarta mensagens antigas. Filtro `HARDCODED_AGENT_NOISE` remove strings hardcoded de erro/handoff/empty-response — string nova de resposta hardcoded DEVE ser adicionada ao set no mesmo PR.
- **Prompt caching Claude** (`cache_control: ephemeral`) — bloco novo deve ser ANEXADO (preserva prefix) e gated por "if data exists".
- **`max_tokens: 1024` por turno**, timeout 12s por tentativa, 2 retries (5xx/429/network, backoff exponencial) via [_shared/retry.ts](supabase/functions/_shared/retry.ts).
- **Fallback same-provider:** `FALLBACK_MODELS.gemini` = Flash→Pro. `callGeminiWithFallback` cobre 5xx, timeout E resposta vazia (candidate vazio). Sticky na invocação. Outros providers `null`. Fallback novo replica os 3 caminhos.
- **Telemetria:** `evt: agent_usage | agent_http_retry | agent_model_fallback | agent_empty_retry | agent_unexpected_stop`.

### Idempotência / handoff UX

- **`processed_messages` FORCE RLS** com `started_at`/`completed_at` — reprocessa após 90s se incompleto.
- **Handoff UX:** auto-resolve 12h sem reply humano → `ai_active`. Lembrete operador 1x/6h via `last_silenced_reply_at`.
- **`releaseToAI` / `markResolved` limpam `handoff_reason` E `handoff_at` E voltam status pra `ai_active`.** Status `resolved` é legado; webhook auto-promove pra `ai_active` na próxima inbound. Nunca grave `resolved` em código novo.
- **HMAC SHA-256** pra provider `official` (Meta); Z-API/WAHA usam `webhook_secret` per-channel.

---

## Stripe — caução de reserva

Stripe Connect Standard (per-unit). Pagamento via Stripe Checkout (hosted).

- **Secrets Stripe vivem em `platform_secrets` (DB), não em env vars.** EFs leem via `_shared/stripe-config.ts` (cache memória 5min, fallback `Deno.env`). `platform_secrets` FORCE RLS — `value` nunca volta pro frontend, só `last4`.
- **`create-reservation` detecta caução** após `reserveSlot()`: se schedule tem `charge_enabled=true`, seta `payment_status='pending_payment'` + `payment_expires_at = now()+15min` + retorna `requires_payment: true`. Frontend chama `create-checkout-session` e redireciona.
- **Reservas WhatsApp são isentas** (`source='whatsapp'` nunca entra no path).
- **Confirmação pós-pagamento:** `stripe-webhook` evento `checkout.session.completed` seta `paid` e insere `notification_outbox` (trigger original filtra `source != whatsapp` mas NÃO re-filtra payment — INSERT manual necessário).
- **Expiração:** worker `expire-pending-payments` + evento `checkout.session.expired` (defesa dupla).

---

## Billing — mensalidades

Cobrança recorrente das organizations. Usa **conta principal Stripe** (não Connect, não `transfer_data`). Separado da caução.

- **Billing é por organization.** `billing_customers` 1:1 com `organizations`. Org com 5 units paga 1 mensalidade.
- **`organizations.billing_status`** é autoritativa pro `BillingGuard` ([src/components/BillingGuard.tsx](src/components/BillingGuard.tsx)) E checks server-side. Platform admin bypassa. `/g/<slug>/cobranca` é whitelist (única rota em `blocked/suspended/canceled`, sem isso cliente entra em loop).
- **`billing_events` é SEPARADA de `stripe_webhook_events`.** No `stripe-webhook/index.ts`, billing events roteados ANTES do check de `stripe_webhook_events` — `BILLING_EVENT_TYPES.has(eventType)` processa e retorna. `checkout.session.completed` é DUAL-PURPOSE (caução OU billing) — `isBillingCheckout(obj)` discrimina em runtime; não mover esse evento pro set sem manter o discriminador.
- **`_shared/stripe-billing.ts`** é helper sem SDK (raw `fetch` + `URLSearchParams`) usado por `manage-billing` e workers. Não confundir com `stripe-config.ts` (resolve secrets).
- **Server-side guards:** `create-reservation` rejeita se org `blocked`/`suspended`. `webhook-whatsapp` silencia agente (outcome `org_billing_blocked`). SELECT direto em `organizations.billing_status` — não dependem do frontend.
- **Política comercial:** trial 14d (`plan.is_trial=true`), grace 3d, bloqueio D+4. Constantes `GRACE_PERIOD_DAYS`/`BLOCK_AFTER_DAYS` em `process-billing-overdue` + `REMINDER_OFFSETS` em `process-billing-reminders` — manter sincronizados.
- **Overrides manuais** em `billing_access_overrides`: `grant_access`→`manual_override`; `block_access`→`blocked`; `extend_trial`→`trialing`. Worker overdue respeita `grant_access` ativo antes de escalar.
- **Self-service `/g/:slug/cobranca`** ([src/pages/gestao/Cobranca.tsx](src/pages/gestao/Cobranca.tsx)): owner/gerente OU platform_admin. Remover cartão é EXCLUSIVO de platform_admin (action `delete` em `manage-payment-methods` valida server-side; cliente vê e troca via Checkout `mode=setup`). EF `create-billing-checkout` (separada de `manage-billing`) gera session `mode=subscription|setup`. Actions client-friendly em `manage-billing` (whitelist `CLIENT_FRIENDLY_ACTIONS`): `change_plan`, `preview_plan_change`, `cancel_subscription_by_owner` (sempre `cancel_at_period_end=true`).
- **Trial automático:** org nova herda plano `is_trial=true AND active=true` (`billing_status='trialing'` + `trial_ends_at`, sem Stripe envolvido). UNIQUE PARTIAL garante 1 plano trial ativo. `is_trial=true` filtrado da `PricingTable.tsx` (cliente nunca escolhe). One-shot por org — cancelou depois → `canceled`, não recomeça. Tempo extra via override `extend_trial`.

---

## Workers automáticos (pg_cron)

Padrão: `pg_cron` → wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post` chama EF com `x-internal-key`.

| Job | Schedule UTC | Função |
|---|---|---|
| `process-notification-outbox` | `*/1 * * * *` | Outbox confirmação (lote 20, backoff 1m→4h, max 5) |
| `process-voucher-triggers` | `0 12 * * *` | Expira vouchers + emite aniversário/frequência |
| `process-reservation-reminders` | `0 13 * * *` | Lembrete D-0 |
| `process-satisfaction-surveys` | `0 17 * * *` | Pesquisa D+1 |
| `cleanup-orphan-assets` | `0 4 * * 0` | Blobs órfãos `unit-assets` (grace 60min) |
| `expire-pending-payments` | `*/2 * * * *` | Cancela `pending_payment` expirado |
| `process-billing-overdue` | `0 10 * * *` | Escala invoices vencidas |
| `process-billing-reminders` | `0 13 * * *` | Lembretes D-3/D0/D+1/D+3 + bloqueio D+4 |
| `process-billing-reconcile` | `0 6 * * *` | Reconcilia subs/invoices com Stripe |
| `process-billing-unblock` | `*/5 * * * *` | Defesa dupla pra webhook `invoice.paid` |
| `process-trial-expiry` | `0 3 * * *` | Bloqueia trial vencido (skip se sub ativa ou override) |

- **`verify_jwt=false` obrigatório em `supabase/config.toml`** pra todo worker pg_cron (`process-*`, `expire-*`, `cleanup-*`). CLI ≥2.95 mudou default pra `true` — sem entrada explícita, gateway responde 401 antes do `requireInternalAuth` e cron silencia (pg_net é fire-and-forget). Worker novo = entrada nova antes do deploy.
- **`verify_jwt=true` explícito** pra toda EF de super-admin (`manage-*`, `whatsapp-health`) — defesa em profundidade.
- **Idempotência** via UNIQUE `(reservation_id, kind)` em `notifications_sent`. Workers lêem `reservation_message_templates` (`customized=true`) ou defaults hardcoded — **`defaultBody` em `useReservationTemplates.ts` precisa ficar sincronizado com `DEFAULT_*_BODY` dos workers** (worker é autoritativo).
- **`unitCache` zerado no início de cada invocação** — settings novos da UI refletem na próxima execução mesmo em EF quente.

---

## Giftback — invariantes

- **Validade sempre fim-do-dia BRT.** Use `expiresAtEndOfDayBrt(validity_days)` de [supabase/functions/_shared/giftback.ts](supabase/functions/_shared/giftback.ts) — Deno é UTC, `setHours` daria 21:00 BRT do dia anterior. Frontend usa `endOfDayLocalISO` em [src/lib/utils.ts](src/lib/utils.ts).
- **Voucher só persiste se WhatsApp send OK.** Ciclo no webhook: `prepareGiftbackVoucher` (monta sem escrever) → `sendOutbound` → `commitGiftbackVoucher` (escreve voucher + `notifications_sent` com status real). Inverter cria voucher fantasma.
- **`notifications_sent.status` reflete envio real** — `sent` se 2xx, `failed` com `error` caso contrário.
- **Dedupe `(rule, customer)` é DB-enforced** via `vouchers_unit_rule_customer_active_idx`. Sempre tente INSERT; erro `23505` é dedupe silencioso (log `voucher_dedup_race`). `SELECT existing` antes não basta (reprocessing_stuck_message permite 2 execuções paralelas).
- **`processFrequency` conta reservas até ontem BRT** (`.lte('date', yesterdayIso)`) — sem isso, reservas confirmadas no futuro disparam voucher antes da visita.
- **Cooldown da frequência = `rule.validity_days`** (estável). NÃO use `windowStart` deslizante.
- **Phone vazio = skip.** Workers filtram `phoneDigits.length >= 10` antes do `issueAndSend`.
- **29/02 em ano não-bissexto → dispara em 28/02** (regra civil BR). Lógica em `getTodayBrtParts` + flag `acceptLeapBirthday`.
- **Advisory lock no worker:** `try_giftback_lock()` no início, `release_giftback_lock()` no `finally`. Falha aberta é OK — UNIQUE PARTIAL pega o resto.
- **Mensagem do voucher é appendada em `conversations.messages`** (rating intercept + comment intercept chamam `appendToConversation` pro incoming "5" E pro outgoing). Sem isso, operador vê buraco na thread.

---

## Conversas — invariantes

- **Append em `conversations.messages` é SEMPRE via RPC `append_conversation_message(p_conv_id, p_message)`** (`SECURITY DEFINER`, só `service_role`). Usa `messages || jsonb_build_array(...)` no mesmo UPDATE — row lock serializa, SELECT→push→UPDATE perde mensagens. Writers: `webhook-whatsapp` (`appendToConversation`), `send-manual-message`, [_shared/conversation-log.ts](supabase/functions/_shared/conversation-log.ts) (`appendOutboundToConversation`). Worker novo DEVE chamar a RPC.
- **Lock de exclusão do agente por conversa:** `try_claim_conversation_for_ai(conv, token, ttl)` / `release_conversation_ai_claim(conv, token)` (`SECURITY DEFINER`, só `service_role`, grants espelhando o giftback). Lock é coluna TTL `conversations.ai_lock_until` — NÃO `pg_try_advisory_lock` (session-scoped, não sobrevive ao pooling transaction-mode do PgBouncer num hold de vários segundos). Após adquirir, re-checa `status == ai_active` (handoff/operador podem ter assumido entre debounce e claim). Não unificar com o lock advisory do giftback — perfil de risco diferente.
- **Shape canônico de `ConversationMessage`:** `{ role: "user"|"assistant"|"human", content, timestamp (ISO obrigatório), kind?, human_user_id? }`. RPC rejeita se faltar campo obrigatório. Tipo em [src/types/reserva.ts](src/types/reserva.ts).
- **Mensagem WhatsApp limita 4096 chars** — frontend (`maxLength` + toast) e backend (`send-manual-message` retorna 400). Replicar em endpoint novo.
- **`appendOutboundToConversation` auto-cria conversa em `ai_active`** se customer não tem nenhuma. Best-effort, nunca lança. Workers/EFs NÃO devem `INSERT into conversations` direto — sempre delegar.
- **Customer create/merge é SEMPRE via [`_shared/resolve-customer.ts`](supabase/functions/_shared/resolve-customer.ts) (`resolveOrCreateCustomer`).** Dedupe `(organization_id, phone)`; preserva `name` cadastrado (nunca sobrescreve com push_name); append em `emails[]`.
- **`useSendManualMessage` faz optimistic update + rollback** via `setQueryData(["conversation-detail", id])`, refetch real no `onSettled`. Padrão pra mutations novas na thread.
- **`supabase.functions.invoke` mascara corpo de erro non-2xx** — extrair via `FunctionsHttpError.context.json()` e anexar `httpStatus` no Error. Pattern em [src/hooks/useSendManualMessage.ts](src/hooks/useSendManualMessage.ts) permite `onError` ressincronizar (409 → invalidar e refetch).
- **Auto-scroll em Radix `ScrollArea`** aponta pro viewport interno: `root.querySelector("[data-radix-scroll-area-viewport]")`. Setar `scrollTop` no root não tem efeito.
- **`useAwaitingHumanCount` escuta `event: "*"`** — INSERT de conversa já em `awaiting_human` também conta.
- **`handleSend` guard reentrante** (`if (sendMessage.isPending) return`) antes de trim/validate — Ctrl+Enter rápido 2x não envia 2x.
- **`getConversationDisplayName()` em `@/lib/utils`** é a fonte canônica. Ordem: `customer.name` (se ≠ phone) → `conversation.contact_name` → `formatPhone(phone)` → `"Cliente sem nome"`. Push_name (extraído por `parseInbound`) é persistido em `customers.name` (só se placeholder `name == phone`) E `conversations.contact_name` (espelho).
- **Realtime subscription exige tabela em `publication supabase_realtime`** — senão `.on(...)` nunca dispara (canal retorna SUBSCRIBED, eventos não chegam). Pattern: `alter publication supabase_realtime add table X exception when duplicate_object then null` (idempotente). RLS continua valendo no canal.
- **Layout master-detail `<lg` é single-pane.** [src/pages/gestao/Conversas.tsx](src/pages/gestao/Conversas.tsx): `h-[calc(100dvh-180px)]` + toggle `hidden lg:flex` baseado em `selectedId`; detalhe ganha botão Voltar `lg:hidden`. **`100dvh` obrigatório** (não `100vh`) — iOS Safari não recua `100vh` com teclado aberto. Tela nova lista+detalhe segue o pattern ou usa `ResponsiveDialog`.
- **`useConversations` carrega TODAS as conversas (loop `.range()` 1000) e seleciona colunas explícitas SEM `messages`.** `statusCounts`/busca/filtro/contagem são client-side sobre o conjunto inteiro — qualquer `.limit()` capa contagem E esconde conversas antigas; reintroduzir `messages` no select estoura o payload (detalhe busca a conversa completa por id em `["conversation-detail", id]`). [src/hooks/useConversations.ts](src/hooks/useConversations.ts).
- **A query `["conversation-detail", id]` semeada com a linha da lista usa `placeholderData` (NUNCA `initialData`).** A linha da lista não tem `messages`; com `initialData` + o `staleTime` global de 30s o React Query trata o parcial como fresco e nunca busca o thread completo (thread em branco). `placeholderData` mostra o cabeçalho na hora mas força o fetch real. [src/pages/gestao/Conversas.tsx](src/pages/gestao/Conversas.tsx).

---

## Painel Operacional — invariantes

- **Mutation que faz "external action + status UPDATE" trata cada lado separadamente.** Se external suceder mas UPDATE falhar, NÃO relançar throw — proteções DB-side (ex.: UNIQUE PARTIAL em `notifications_sent`) bloqueiam o 2º envio silenciosamente. Padrão: retornar `{ externalOk, dbOk }`, `toast.warning` quando `dbOk=false`, invalidar pra forçar reconciliação. Pattern em [src/hooks/useWaitlist.ts](src/hooks/useWaitlist.ts) `useNotifyWaitlist`.
- **Desabilitar 1 botão entre N que compartilham mutation usa `mutation.variables`**, não state extra. Checar `mutation.isPending && mutation.variables?.id === entry.id`. Desabilitar mutation globalmente trava a lista. Pattern em [src/pages/operacional/Fila.tsx](src/pages/operacional/Fila.tsx) / [Passantes.tsx](src/pages/operacional/Passantes.tsx).
- **Painéis em tablet usam `refetchInterval` visibility-aware:** `() => document.hidden ? false : 30_000`. Tab background não consome request idle.
- **Empty state em lista filtrada checa as listas DERIVADAS**, não o total bruto. `reservas?.length > 0` com todas `cancelled` passa o guard mas as listas derivadas estão vazias → render em branco. Pattern em [src/pages/operacional/ReservasDia.tsx](src/pages/operacional/ReservasDia.tsx).

---

## Membros e papéis

`owner` (total, cria units) > `gerente` (config + membros + dados, sem automação) > `operador` (reservas/fila/walk-ins). Membros em `unit_members` via EF `manage-members`; super-admins em `platform_admins`. Tabela `admin_users` + EF `manage-admins` foram REMOVIDAS — **não reinstalar**.

---

## Padrões de código

- Componentes **PascalCase**, hooks **camelCase** com prefixo `use`. Path alias `@/` → `src/`. Hooks de dados aceitam `unitId` como 1º parâmetro (`useCurrentUnit()` resolve). Forms via React Hook Form + Zod. Toast via Sonner. CSS via `cn()` de `@/lib/utils` (nunca template literal Tailwind). Datas `YYYY-MM-DD` no DB / `formatDateBR()` na exibição. Telefones só dígitos / `formatPhone()` na exibição.
- **Layouts admin (Gestão/Operacional/Plataforma/Admin legado) renderizam o casco via `AdminShell`** ([src/components/layouts/AdminShell.tsx](src/components/layouts/AdminShell.tsx)) — ele provê o toggle hambúrguer (colapso no desktop persistido em `localStorage` chave `admin-sidebar-collapsed` + gaveta mobile com backdrop `<lg`). Painel/layout novo passa o conteúdo da sidebar na prop `sidebar` em vez de montar `<aside>` de largura fixa próprio; reintroduzir `<aside>` fixo perde a responsividade mobile e o toggle.
- Queries/mutations via **TanStack React Query** — nunca `useState + useEffect` pra dados remotos.
- **`invalidateQueries` é prefix-match — cuidado com ordem da key.** Se query é `["customers", orgId, unitId, search]` e mutation invalida `["customers", unitId]`, **não casa** (posição 1 é orgId). Invalidate broad (`["customers"]`) ou montar key na mesma ordem.
- **Listas TanStack tratam `isError` separado de `!data.length`** — 4 branches: `isLoading`, `isError` (com `refetch()`), `empty`, `list`. Silenciar erro como "lista vazia" já mascarou incidente em produção.
- **Batch que lê tabela inteira precisa `.range(from, to)` em loop** até `chunk.length < PAGE`. Sem `.range`, PostgREST trunca silenciosamente em `db-max-rows` default (1000).
- **`refetchOnWindowFocus: false`** é default global em [src/App.tsx](src/App.tsx) — evita resetar form state ao trocar de aba. Painéis operacionais usam `refetchInterval`, não reativam windowFocus.
- **`AuthContext` só ativa `loading=true` quando `user_id muda`** ([src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx)). Supabase dispara `SIGNED_IN` em refoco após token refresh — ativar loading desmonta árvore e descarta state local.
- **Auto-logout de órfão:** user autenticado sem `unit_members` E sem `platform_admins` → `AuthContext` desloga + redireciona `/admin/login`. Detecção via Realtime nas duas tabelas. NÃO adicionar de volta tela estática "Sem acesso a nenhuma unidade" — trava em sessão zumbi.
- **Nome da unit vive em `units.name`** — fonte canônica. Owner/gerente escreve via policy `unit_owner_gerente_update_units`. Após escrever, chamar `refreshMemberships()` do `useAuth()`. Setting `restaurant_name` é legado (EFs leem com fallback pra compat); UI não escreve mais nele.
- **Slug da unit (`units.slug`) é editável** e invalida URLs antigas (QR impresso → 404). Mutation faz `refreshMemberships`, invalida `["all-units"|"public-unit"|"unit-public-content"|"organizations"]`, renavega `/g/<antigo>` → `/g/<novo>`. Trata colisão `23505`.
- **Input do usuário em `.or()`/`.ilike()` PostgREST passa por `sanitizeSearchTerm()`** de `@/lib/utils` (remove `, ( ) % _ \ " ' \` *`, limita 80 chars). Sem isso, `O'Brien` quebra a query.
- **URLs em `<a href>` de portal público passam por `isSafeHttpUrl()`** (bloqueia `javascript:`/`data:`/`vbscript:`). Hoje só `menu_banners.link_url`: triplo guard frontend save + render + CHECK constraint. Campo novo "link salvo por membro" segue o mesmo.
- **Edge Functions nunca devolvem `error.message` cru do Postgres em 500.** Mensagem curta PT-BR pro cliente; detalhe em `console.error`/`jsonLog`. Exceção: mensagens do Supabase Auth são UX-críticas, devolver intactas.
- **CORS em `manage-*`** via [_shared/cors.ts](supabase/functions/_shared/cors.ts) (whitelist localhost, *.vercel.app, reservas.moralles.com.br).

---

## Tema visual

Dois mundos: `:root` warm (laranja+bege, portais públicos+login) e `.theme-admin` navy SaaS (painéis Gestão/Operacional/Plataforma). `.theme-admin` sobrescreve TODAS as CSS vars no escopo. Nunca hardcode cores — tokens Tailwind sempre.

- **`index.html` precisa manter `viewport-fit=cover` no meta viewport.** Sem ele, todo `env(safe-area-inset-*)` (footers de `Dialog`/`ResponsiveDialog`, gaveta do `AdminShell`) avalia 0 no iOS — safe-area morre em silêncio. [index.html](index.html).
- **Pares de inputs em form usam `grid grid-cols-1 sm:grid-cols-2`, nunca `grid-cols-2` cru.** O `sm:` (640px) casa com a largura em que o Dialog deixa de ser fullscreen — abaixo disso empilha. Grid de KPI/tiles (`grid-cols-2 lg:grid-cols-4`) é proposital e fica.

---

## Observabilidade WhatsApp

- **`webhook_executions`** FORCE RLS, TTL 30d. Outcomes: `success`, `agent_error`, `send_error`, `duplicate`, `media_response`, `debounced_superseded`, `conversation_locked`, `status_changed_locked`, `org_billing_blocked`, etc.
- **`SendResult` estruturado:** `{ ok, status, error, bodySnippet, missingCreds }`.
- **Diagnóstico** em `/platform/automacao/<slug>` aba "Diagnóstico" via `whatsapp-health`.

---

## Deploy

### Frontend (Vercel)

Push em `main` dispara deploy. Vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. `.npmrc` força `legacy-peer-deps=true` — não remover.

### Edge Functions

Deploy individual: `supabase functions deploy <nome>`. **Edge Functions não compartilham bundle em runtime** — alterar arquivo em `_shared/` exige redeploy de TODAS as functions que importam, senão continuam com versão antiga em memória.

Checklist de redeploy quando `_shared/X.ts` muda:

- **`availability.ts`** → `create-reservation`, `create-manual-reservation`, `update-reservation`, `webhook-whatsapp`
- **`conversation-log.ts`** → TODAS (`webhook-*`, `send-*`, `process-*`)
- **`resolve-customer.ts`** → `create-reservation`, `create-manual-reservation`, `webhook-whatsapp`
- **`cors.ts`** → `manage-*`, `send-*`, `create-manual-reservation` (qualquer EF chamada pelo frontend autenticado)
- **`stripe-config.ts`** → `manage-stripe-accounts`, `create-checkout-session`, `stripe-webhook`, `manage-platform-secrets`, `manage-billing`, `process-billing-reconcile`, `create-billing-checkout`, `manage-payment-methods`
- **`stripe-billing.ts`** → `manage-billing`, `process-billing-reconcile`, `create-billing-checkout`
- **`ai-providers.ts`** → `webhook-whatsapp`, `manage-ai-providers`

Worker/EF novo que importe um helper aqui = atualizar este checklist no mesmo PR.
