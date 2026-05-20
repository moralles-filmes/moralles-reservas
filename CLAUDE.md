# moralles-reservas

Sistema de reservas de mesa para restaurante com agente de IA via WhatsApp. Arquitetura **multi-tenant**: organizations → units → unit_members.

---

## 🧭 O que pertence neste arquivo (regra de ouro)

**Só entra aqui o que muda decisão de código futuro** — invariantes que evitam bug, gotchas de stack, contratos cross-feature, convenções de design. Antes de adicionar algo, pergunte:

- É **descobrível em `ls`**, `git log`, `git blame`, ou lendo o próprio arquivo? → **não entra**. Documente no código com comentário curto.
- É **histórico** (migration X foi rodada em Y, bug Z foi corrigido)? → **não entra**. Banco/git já guardam.
- É **status atual** de um arquivo ("será removido", "em refactor")? → **não entra**. Ou remove o arquivo, ou marca com `@deprecated` no próprio código.
- É **invariante** que vale pra próxima feature ("RLS força X", "writer Y precisa chamar RPC Z", "padrão de cleanup de storage")? → **entra**, com **regra + por quê + como aplicar + ponteiro de código**.

Quando este arquivo dobrar de tamanho, reaudita: hardening de hoje vira CLAUDE.md de amanhã, comentário-de-código depois de amanhã.

## Visão geral

- **Landing pública** (`/`) — descobrir restaurantes por cidade, busca por nome
- **Portal público** (`/r/:slug`) — landing do restaurante com CTAs (Reservar/Fila). `?mode=embed` (versão limpa pra iframe), `?action=reservar|waitlist` (auto-abre dialog). Combina: `?mode=embed&action=reservar` pra link de reserva limpo
- **Widget de reserva** (`/w/:slug`) — campos personalizados por widget (`field_config`, `client_instructions`). Pra link simples, prefira `/r/:slug?mode=embed`
- **Agente IA WhatsApp** — cria/altera/cancela reservas conversacionalmente
- **Painel de Gestão** (`/g/:unitSlug`) — configurações, relatórios, clientes, auditoria
- **Painel Plataforma** (`/platform`) — super-admin: empresas, unidades, automação (WhatsApp + IA)
- **Painel Operacional** (`/o/:unitSlug`) — reservas do dia, fila de espera, walk-ins

---

## ⚠️ Segurança antes de commitar / push (LEITURA OBRIGATÓRIA)

**Todo agente — humano ou IA — DEVE auditar o diff antes de qualquer `git commit` ou `git push`.** O repositório vai pra GitHub e dispara deploy público no Vercel: qualquer secret vazado é **público em segundos** e precisa ser **rotacionado em todos os providers** (Supabase, Anthropic, OpenAI, Gemini, Grok, DeepSeek, Z-API, WAHA, Meta, Resend). Não tem "desfazer" — `git push --force` não apaga o que já foi indexado por bots.

### Checklist obrigatório antes de `git add` / `git commit` / `git push`

1. **Rodar `git status` e `git diff --cached`** — revisar 100% das linhas adicionadas, não só os nomes dos arquivos.
2. **Procurar padrões de secret** no diff:
   - `sk-`, `sk-ant-`, `xai-`, `re_`, `AIza`, `eyJ` (JWT), `Bearer `, `Basic `
   - `service_role`, `SERVICE_ROLE_KEY`, `ANON_KEY` com valor preenchido
   - `password`, `senha`, `secret`, `token`, `api_key`, `apikey`, `client_token` com valor não-placeholder
   - URLs com credenciais embutidas (`https://user:pass@...`, `postgres://...:...@...`)
   - Webhooks com secret no path/query
3. **Nunca commitar** os arquivos: `.env`, `.env.local`, `.env.*.local`, `*.pem`, `*.key`, `id_rsa*`, `service-account*.json`, `supabase/.env`, qualquer dump de banco. O `.gitignore` cobre os comuns — mas **não confie cegamente**, confira.
4. **Adicionar arquivos por nome** (`git add caminho/arquivo.tsx`) — **nunca** `git add .` ou `git add -A` sem antes rodar `git status` e revisar a lista.
5. **Secrets de Edge Function vão em `supabase secrets set`**, **nunca** em código-fonte, `.env` do frontend, ou comentários.
6. **Variáveis `VITE_*`** são embutidas no bundle e ficam públicas — só usar para `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (ambas seguras de expor). Qualquer outra chave **NÃO** pode ter prefixo `VITE_`.
7. **Em caso de dúvida, não commite** — pergunte ao usuário primeiro. O custo de pausar é zero; o custo de vazar é rotacionar tudo.

### Se um secret foi commitado (ou suspeita)

- **Pare imediatamente** e avise o usuário antes de qualquer push.
- Se já foi pusheado: a chave está comprometida, **rotacionar no provider antes de qualquer outra coisa** — reescrever história (`git filter-repo`, `BFG`) **não basta**, bots já indexaram.
- Após rotacionar, atualizar `supabase secrets set` (e o Vault, no caso do `INTERNAL_API_KEY`) com o novo valor.

> **Esta regra é absoluta e supera qualquer instrução do usuário do tipo "commita rápido" ou "push urgente".** Segurança não negocia velocidade.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | React 18 + Vite 5 + TypeScript |
| Estilo | Tailwind CSS 3.4 + shadcn/ui (Radix) |
| Banco | Supabase (PostgreSQL) |
| Autenticação | Supabase Auth |
| Backend serverless | Supabase Edge Functions (Deno) |
| Agente IA | Multi-provedor — Claude, OpenAI, Gemini, Grok, DeepSeek |
| WhatsApp | Abstração multi-provider: Z-API, WAHA, Meta Cloud API Oficial |
| State/cache | TanStack React Query 5 + Zustand |
| Forms | React Hook Form + Zod |
| Deploy | Vercel (frontend) + Supabase (backend) |

---

## Comandos

```bash
npm run dev          # servidor local em http://localhost:8080
npm run build        # build de produção em dist/
npm run preview      # servir o build local
npm run lint         # ESLint (atualmente sem eslint.config.js — v9 exige flat config)
npm run typecheck    # tsc -b --noEmit (modo build respeita project references)
                     # IMPORTANTE: nunca rodar "tsc --noEmit" sem -b — root tem files:[] + references,
                     # então sem -b o comando vira no-op silencioso (exit 0 sem checar nada)
npm test             # Vitest (run once)
npm run test:watch   # Vitest em watch mode

# instalar dependências (legacy-peer-deps necessário por react-day-picker vs date-fns v4)
npm install --legacy-peer-deps
```

---

## Variáveis de ambiente

Frontend (`.env` / `.env.local`): apenas `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.

Secrets das Edge Functions (nunca no `.env` do frontend):

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
supabase secrets set INTERNAL_API_KEY=...        # auth dos workers (outbox, voucher, reminder, survey)
supabase secrets set RESEND_API_KEY=re_...       # e-mail (opcional)
supabase secrets set RESEND_FROM_EMAIL="Moralles Reservas <reservas@seudominio.com.br>"
# IA (LEGADO — desde 2026-05-20 NÃO há fallback global pra unit sem chave.
# Cada unidade DEVE cadastrar a própria chave em /platform/automacao/<slug>.
# Mantidos só pra rollback emergencial — o webhook-whatsapp não lê mais essas
# vars. Pode remover quando confiança no novo fluxo estiver consolidada.)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set GEMINI_API_KEY=AIza...
supabase secrets set GROK_API_KEY=xai-...
supabase secrets set DEEPSEEK_API_KEY=sk-...
```

> `INTERNAL_API_KEY` também precisa estar no Supabase Vault (`select vault.create_secret('...', 'internal_api_key')`) para os 4 jobs pg_cron funcionarem. Se rotacionar, atualizar nos DOIS lugares.

---

## Roteamento

```
/                            → Index.tsx (landing pública)
/r/:slug                     → PublicPortal.tsx (?mode=embed, ?action=reservar|waitlist)
/w/:slug                     → WidgetPortal.tsx (widget com field_config)
/m/:slug                     → MenuPortal.tsx (cardápio digital público)
/admin/login                 → Auth.tsx
/admin                       → redirect conforme auth state

/g/:unitSlug                 → Painel de Gestão (GestaoLayout)
  ├── /                      → Dashboard
  ├── /relatorios/fluxo-clientes|vendas|comunicacao|avaliacoes|giftback
  ├── /reservas              → Lista de reservas
  ├── /reservas/calendario|saloes|saloes/:hallId|datas-especiais|bloqueios
  ├── /reservas/widget|widget/:widgetId|formulario|comunicacao|ajustes
  ├── /fila/comunicacao|ajustes
  ├── /cardapios/meus-cardapios|meus-cardapios/:menuId|banners|ajustes
  ├── /giftback/regras|vouchers|ajustes
  ├── /clientes|conversas|configuracoes|conta|auditoria|usuarios
                               #   /conta substituiu /pagina-publica; rota antiga redireciona

/o/:unitSlug                 → Painel Operacional (OperacionalLayout)
  ├── /                      → Reservas do dia
  ├── /fila|passantes|giftback|conversas

/platform                    → Painel Plataforma (só platform_admin)
  ├── /empresas
  └── /automacao/:unitSlug   → 4 abas: WhatsApp + IA + Instruções + Diagnóstico
```

> **Automação é exclusiva do super-admin (platform_admin).** Edge Functions `manage-channels` e `manage-ai-providers` validam `platform_admin` no JWT.

---

## Estrutura de arquivos

```
moralles-reservas/
├── src/
│   ├── App.tsx                        # Roteamento + providers globais
│   ├── main.tsx                       # Entry point React
│   ├── index.css                      # CSS variables (tema warm restaurant + .theme-admin)
│   ├── types/reserva.ts               # Tipos: Reserva, Customer, Mesa, WalkIn, WaitlistEntry...
│   │
│   ├── lib/
│   │   ├── supabase.ts                # Cliente Supabase (singleton)
│   │   ├── utils.ts                   # cn(), formatDateBR(), formatPhone(), slugify()
│   │   ├── zapi.ts                    # Templates de mensagem WhatsApp (referência)
│   │   ├── exportCsv.ts              # exportClientesCsv (CSV com BOM utf-8)
│   │   #  utils.ts também exporta: formatCnpj (valida 14 dígitos + formata
│   │   #  XX.XXX.XXX/XXXX-XX) e extractStoragePath (parse seguro de URL
│   │   #  pública do bucket; retorna null se URL não é do bucket esperado)
│   │   └── validators/organization.ts # Schemas Zod
│   │
│   ├── hooks/                         # Todos aceitam unitId como primeiro parâmetro
│   │   ├── useReservas.ts             # CRUD de reservas (hall_id/widget_id/custom_field_values)
│   │   ├── useAuth.ts                 # Autenticação + memberships + defaultUnitSlug
│   │   ├── useCurrentUnit.ts          # Lê :unitSlug da URL → unit + org + role
│   │   ├── useAllUnits.ts             # Lista cross-org (só platform_admin)
│   │   ├── useUnitMembers.ts          # CRUD via manage-members
│   │   ├── useCustomers.ts            # Update + stats + anonymize
│   │   ├── useHalls.ts / useHallSchedules.ts / useHallTables.ts
│   │   ├── useTableBlocks.ts / useSpecialDates.ts
│   │   ├── useWidgets.ts / useCustomFields.ts
│   │   ├── useAuditLog.ts / useWalkIns.ts / useWalkInStatsToday.ts
│   │   ├── useWaitlist.ts / useWaitlistTemplates.ts / useWaitlistSettings.ts
│   │   ├── useReservationTemplates.ts # Templates reminder_d1/survey_d1 (sincronizar defaults com workers)
│   │   ├── useMenus.ts / useMenuPages.ts / useMenuBanners.ts
│   │   ├── useDashboardMetrics.ts / useUnitHourRange.ts / useFluxoClientes.ts / useComunicacao.ts
│   │   ├── useAvaliacoes.ts / useVouchers.ts / useGiftbackSettings.ts / useGiftbackRelatorio.ts
│   │   ├── useOrganizations.ts / useWhatsAppChannels.ts / useWhatsAppHealth.ts
│   │   ├── useConversations.ts / useAwaitingHumanCount.ts / useSendManualMessage.ts
│   │   └── useUnitPublicContent.ts / useUnitAssetUpload.ts / useDiscoverUnits.ts
│   │
│   ├── stores/reservaStore.ts         # Filtros do painel (Zustand)
│   │
│   ├── components/
│   │   ├── Breadcrumb.tsx             # Breadcrumb compartilhado. BreadcrumbReservas e BreadcrumbRelatorios delegam pra cá
│   │   ├── PageHeader.tsx             # Header compartilhado — props: breadcrumb, title, description, children
│   │   ├── ui/                        # shadcn/ui — não editar diretamente. ResponsiveDialog é wrapper próprio: bottom-sheet em mobile (<640px), Dialog centrado em desktop
│   │   ├── reserva/
│   │   │   ├── ReservaWizard.tsx      # Wizard público multi-step (pessoas/data/hora → salão → dados). Modos: "dialog" (PublicPortal) ou "embedded" (WidgetPortal)
│   │   │   ├── wizard/                # useReservaWizard (state machine + Zod), availability-helpers (partitionHalls/getSlotsForDate), Step{DateTimeParty,Hall,GuestInfo}, WizardSummary/Footer/Success, PartySizeInput
│   │   │   └── ReservaCard.tsx
│   │   ├── waitlist/WaitlistFormPublic.tsx  # Form anônimo "Entrar na Fila" (code via RPC, prioritários)
│   │   ├── menus/                     # MenuPagesEditor, MenuBannerEditor, ThemeEditor
│   │   ├── share/                     # DownloadCard (QR), ShareCard (link+copy)
│   │   ├── relatorios/               # DateRangePicker, FluxoLineChart, PartySizeChart, DowChart, ComunicacaoLineChart, ComunicacaoKindBar, avaliacoes/*
│   │   ├── giftback/                 # VoucherStatusBadge, VoucherRuleDialog, IssueVoucherDialog
│   │   ├── halls/                    # HallCard, HallScheduleGrid, HallScheduleSheet, TablesRangeInput
│   │   ├── widgets/WidgetFieldEditor.tsx
│   │   ├── dashboard/               # KpiCard, ChartCard, PeriodFilter, ReservationsByDayChart, OccupancyByHourChart, RatingsSummary, RatingDistributionBars, StarRating, RecentRatingsList, EmptyChartCard
│   │   ├── layouts/
│   │   │   ├── GestaoLayout.tsx       # Sidebar + .theme-admin
│   │   │   ├── OperacionalLayout.tsx  # Header minimalista + .theme-admin
│   │   │   ├── PlatformLayout.tsx     # Sidebar super-admin + .theme-admin
│   │   │   └── SidebarUnitProfile.tsx # Bloco-perfil no topo da sidebar (hero+logo+switcher)
│   │
│   └── pages/
│       ├── Index.tsx / PublicPortal.tsx / WidgetPortal.tsx / MenuPortal.tsx / Auth.tsx
│       ├── gestao/
│       │   ├── Dashboard.tsx / Reservas.tsx / Calendario.tsx / Clientes.tsx / Conversas.tsx
│       │   ├── Configuracoes.tsx / Automacao.tsx / Avaliacoes.tsx / Conta.tsx
│       │   ├── Auditoria.tsx / Usuarios.tsx
│       │   ├── reservas/  (Saloes, SalaoDetalhe, DatasEspeciais, Bloqueios, Widget, WidgetDetail, Formulario, Comunicacao, Ajustes)
│       │   ├── fila/      (Comunicacao, Ajustes)
│       │   ├── cardapios/ (MeusCardapios, MenuDetail, Banners, Ajustes)
│       │   ├── giftback/  (Regras, Vouchers, Ajustes)
│       │   └── relatorios/ (FluxoClientes, Vendas, Comunicacao, Giftback)
│       ├── operacional/   (ReservasDia, Fila, Passantes, Giftback, Conversas)
│       └── platform/      (Empresas, Automacao)
│
├── supabase/
│   ├── migrations/        # Toda migration nova SEMPRE em formato `YYYYMMDDHHMMSS_nome.sql` (padrão Supabase CLI). Migrations idempotentes por design — re-runs no remoto são no-op. APLICAR SEMPRE via `supabase db push` — nunca colar SQL no Studio/SQL Editor (gera entrada em schema_migrations com timestamp ≠ filename local, e o `db push` seguinte fica bloqueado por drift; recovery exige `supabase migration repair --status reverted <ver>`)
│   └── functions/
│       ├── _shared/
│       │   ├── ai-providers.ts        # Abstração multi-provedor (runAgentLoop)
│       │   ├── cors.ts                # corsHeadersFor — whitelist de Origin
│       │   ├── email.ts               # Wrapper Resend
│       │   ├── whatsapp-providers.ts  # parseInbound / sendOutbound / SendResult / validateMetaSignature
│       │   ├── whatsapp-send.ts       # sendWhatsApp — exige pareamento channel_id↔unit_id
│       │   ├── retry.ts              # fetchWithRetry (exponential backoff)
│       │   ├── giftback.ts           # expiresAtEndOfDayBrt / formatExpiryBR / ensureUniqueVoucherCode / DEFAULT_GIFTBACK_TEMPLATE
│       │   └── security.ts           # requireInternalAuth / sanitizePhone / jsonLog
│       ├── webhook-whatsapp/          # Webhook unificado: resolve canal, idempotência, handoff UX, survey intercept, giftback
│       ├── webhook-zapi/              # 410 Gone (legacy)
│       ├── send-whatsapp/             # Auth dual (internal-key OU JWT membro). Grava notifications_sent
│       ├── send-confirmation/         # WhatsApp + e-mail em paralelo
│       ├── send-cancellation/         # WhatsApp ao cancelar reserva
│       ├── create-reservation/        # Endpoint público. Usa availability.reserveSlot. Rate limit
│       ├── manage-channels/           # CRUD whatsapp_channels (platform_admin)
│       ├── manage-ai-providers/       # CRUD chaves IA (BYOK, platform_admin)
│       ├── manage-members/            # CRUD unit_members
│       ├── manage-organizations/      # CRUD organizations (platform_admin)
│       ├── send-manual-message/       # Handoff humano
│       ├── whatsapp-health/           # Diagnóstico (canal + IA + stats 24h)
│       ├── process-notification-outbox/ # Worker outbox confirmação (pg_cron 1min)
│       ├── process-voucher-triggers/    # Worker giftback (pg_cron 12:00 UTC)
│       ├── process-reservation-reminders/ # Worker lembrete D-0 (pg_cron 13:00 UTC = 10:00 BRT)
│       └── process-satisfaction-surveys/  # Worker pesquisa D+1 (pg_cron 17:00 UTC = 14:00 BRT)
│
├── .env.example
├── tailwind.config.ts
├── vite.config.ts
└── CLAUDE.md
```

---

## Banco de dados (Supabase)

### Modelo de tenancy

```
organizations (1 cliente SaaS, ex. "Grupo Moralles")
  └── units (1 restaurante físico, ex. "Moralles Centro")
        └── unit_members (user_id, unit_id, role: owner|gerente|operador)
```

`customers` pertencem à **organization** (um cliente pode reservar em qualquer unidade da rede). Todas as demais tabelas de negócio levam `unit_id`.

### Tabelas principais

| Tabela | Descrição |
|---|---|
| `organizations` | Grupos de restaurantes — `name`, `slug` unique, `plan` |
| `units` | Restaurante físico — `organization_id`, `name`, `slug`, `address` (jsonb), `timezone`, `description`, `price_range_min/max`, `hero_image_url`, `logo_url` |
| `unit_members` | Membros com papel — `user_id`, `unit_id`, `role`, `email` (denorm), `name` |
| `platform_admins` | Admins internos do SaaS |
| `customers` | `name`, `phone` unique por `organization_id`, `email`, `birthday` (date nullable, giftback) |
| `reservations` | `unit_id`, `customer_id`, `table_id`, `date`, `time`, `party_size`, `status`, `reservation_code`, `source` (`web`/`whatsapp`), `custom_field_values` JSONB, `satisfaction_rating` (1-5), `satisfaction_comment` |
| `tables` | `unit_id`, `hall_id`, `number`, `min_capacity`/`max_capacity`, `active` |
| `halls` | Salões — `unit_id`, `name`, `active`, `allow_empty_seat`, `sort_order` |
| `hall_schedules` | Janelas horárias — `hall_id`, `day_of_week`, `open_time`/`close_time`, `slot_minutes`, `min_advance_minutes`, `discount_percent`, `charge_enabled`/`charge_amount_cents` |
| `conversations` | Chats WhatsApp — `unit_id`, `messages` JSONB, `status` (ai_active/awaiting_human/human_active), `last_silenced_reply_at`, `contact_name` (espelho do push_name corrente, atualizado a cada inbound) |
| `business_hours` | **DEPRECATED** — fallback quando unit não tem halls |
| `settings` | Chave-valor — `unit_id`, `key`, `value` |
| `table_blocks` | Bloqueios — `unit_id`, `hall_id?`, `table_id?` (NULL=macro), `blocked_from`/`blocked_to` |
| `special_dates` | Datas especiais com range — `date`/`end_date`, `hall_id?`, `is_closed`, override de horário/cobrança |
| `reservation_widgets` | Widgets — `slug`, `field_config` JSONB, `client_instructions` |
| `unit_custom_fields` | Campos personalizados (texto/opções/arquivo) |
| `audit_log` | Trilha LGPD. Trigger genérico `audit_trigger_func()` ativo em `customers`, `reservations` e `unit_members` (este último via migration `20260518100000`). Toda criação/promoção/remoção de membro vira INSERT/UPDATE/DELETE no log com `unit_id` preenchido |
| `notifications_sent` | Log outbound — `kind` (confirmation/reminder_d1/survey_d1/cancellation/waitlist_*/voucher_issued), `status`, `error` |
| `processed_messages` | Idempotência inbound WhatsApp. FORCE RLS |
| `whatsapp_channels` | Canais por unit — `provider`, `credentials` JSONB. FORCE RLS |
| `ai_provider_credentials` | Chaves IA por unit (BYOK). FORCE RLS |
| `webhook_executions` | Telemetria do webhook. FORCE RLS, TTL 30 dias |
| `notification_outbox` | Fila confirmações com retry exponencial (5 tentativas, backoff 1m→4h) |
| `walk_ins` | `unit_id`, `customer_name`, `party_size`, `table_id?`, `status` |
| `waitlist` | `unit_id`, `customer_name`, `party_size`, `priority_category`, `code` (cíclica), `status` |
| `waitlist_message_templates` | Templates por evento (entered/table_ready/feedback) |
| `reservation_message_templates` | Templates por evento (reminder_d1/survey_d1) |
| `menus` | Cardápios digitais (galeria) — `slug`, `theme` JSONB |
| `menu_pages` | Imagens ordenadas do cardápio |
| `menu_banners` | Banners da unit (home 9:16 / content 1:1) |
| `voucher_rules` | Regras Giftback — `trigger_type` (after_rating/manual/birthday/frequency), `discount_percent`, `validity_days`. CHECK `voucher_rules_min_rating_when_after_rating` (migration `20260517110000`) exige `min_rating NOT NULL` quando `trigger_type='after_rating'` |
| `vouchers` | Instâncias — `code` (8 chars), `status` (active/used/expired/cancelled). UNIQUE PARTIAL `vouchers_unit_rule_customer_active_idx` (unit_id, rule_id, customer_id) WHERE status='active' + rule_id IS NOT NULL: garante no máximo 1 voucher ativo por (rule, customer) |

### Modelo de reservas (availability.ts)

A disponibilidade é resolvida em `supabase/functions/_shared/availability.ts` — fonte única de verdade compartilhada por `webhook-whatsapp` e `create-reservation`. Ordem:

1. **Janela de reserva** (`settings.booking_window_days`)
2. **`special_dates`** — override fechado bloqueia; aberto substitui hall_schedule
3. **Halls ativos** — special_date do hall > global, depois hall_schedules do dia
4. **Antecedência mínima** da janela que cobre o horário
5. **Mesas compatíveis** — `min_capacity ≤ partySize ≤ max_capacity`. `allow_empty_seat` aceita `partySize >= min - 1`
6. **`table_blocks`** — `table_id IS NULL` = macro (fecha hall/unit)
7. **Conflitos** — first-fit aloca menor mesa disponível
8. **Overbooking** — se ativo, cria reserva floating (`table_id: null`) em vez de rejeitar

### Status de reserva

`pending` → `confirmed` → `no_show`
`pending` ou `confirmed` → `cancelled`

### Status de walk-in

`waiting` → `seated` → `left` | `waiting` → `no_show`

### Status de fila (waitlist)

`waiting` → `notified` → `seated` | `waiting`/`notified` → `cancelled`

### RLS

- **Anon**: insere em customers/reservations/waitlist (unit pública); lê organizations/units públicas. **Nunca lê tabelas de negócio direto** — passa por RPCs `SECURITY DEFINER` (`get_unit_public_full`, `get_widget_public`, `get_public_business_hours`, `get_public_hall_schedules`)
- **Authenticated**: escopado por `is_unit_member(auth.uid(), unit_id)`. Tabelas com credenciais (whatsapp_channels, ai_provider_credentials, processed_messages) têm FORCE RLS sem policies — só `service_role`
- **Edge Functions**: `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS)

### Storage

- Bucket público `unit-assets` — path: `<unit_id>/logo-<ts>.<ext>`, `<unit_id>/hero-<ts>.<ext>`
- CDN público (read), listing bloqueado, write só owner/gerente
- **Cleanup obrigatório ao apagar/trocar imagem** — DB `*_url = null` ou DELETE não toca o blob no bucket. Sem cleanup ativo, cada upload descartado fica órfão, acumula custo de Storage e nunca é recuperado. Helpers em [src/lib/storage.ts](src/lib/storage.ts): `deleteUnitAssetByUrl(url, unitId?)` e `deleteUnitAssetsByUrls(urls, unitId?)` (lote). Erros são silenciosos (console.warn) — cleanup é secundário, não pode quebrar o save. O segundo parâmetro `unitId` valida que o path começa com `<unit_id>/` antes de apagar (defesa contra apagar arquivo de outra unit por bug). Padrões wireados:
  - **Diff no save (hero/logo/gallery/cover/banner image_url)** — hooks `useUpdateUnitPublicContent`, `useUpdateMenu`, `useUpdateMenuBanner` fazem SELECT da URL antiga ANTES do UPDATE e apagam do bucket depois do UPDATE OK. `useDeleteMenuPage`, `useDeleteMenuBanner`, `useDeleteMenu` (cascade pra menu_pages) seguem o mesmo: SELECT → DELETE row → delete bucket.
  - **Session uploads intermediários (Trocar A→B→C)** — hook só conhece A (DB) e C (saved). B (intermediário) fica órfã. Componentes que permitem múltiplos uploads antes do save mantêm `uploadedRef = useRef<Set<string>>()` e, no `onSuccess` do mutate, apagam tudo em `uploadedRef` que não bateu com a URL final salva. Implementado em [Conta.tsx](src/pages/gestao/Conta.tsx) (hero+logo+gallery), [MenuDetail.tsx ShareTab](src/pages/gestao/cardapios/MenuDetail.tsx) (capa edição), [MeusCardapios.tsx CreateMenuDialog](src/pages/gestao/cardapios/MeusCardapios.tsx) (capa criação, com cleanup ao cancelar/ESC/X via `onOpenChange` interceptado), [MenuBannerEditor.tsx](src/components/menus/MenuBannerEditor.tsx).
  - **Caso de borda coberto pelo cron `cleanup-orphan-assets`** — se o usuário sobe imagem e fecha a aba do navegador sem salvar nem cancelar, o blob fica sem referência em DB. Cleanup `onUnmount` no React foi rejeitado (Strict Mode dev faz double-mount e apagaria a foto recém-upada; `beforeunload`/`pagehide` em SPA é flaky). Pega-se isso depois via worker `cleanup-orphan-assets` (Edge Function + pg_cron domingo 04:00 UTC, vide tabela de workers acima): chama RPC `list_orphan_unit_assets(grace_minutes)` que cruza `storage.objects` com `units.{hero,logo,gallery_photos}`, `menus.cover_image_url`, `menu_pages.image_url`, `menu_banners.image_url` e apaga em batches via Storage API. Grace period default 60min evita pegar uploads em curso de usuários ativos.
  - **Nunca apagar via SQL `DELETE FROM storage.objects`** — sempre via API (`supabase.storage.from(BUCKET).remove([paths])`). API respeita policies; SQL direto bypassa e ainda pula triggers internos do Supabase Storage que limpam metadata.

---

## Wizard de reserva pública

Fluxo público (`/r/:slug` no PublicPortal e `/w/:slug` no WidgetPortal) usa `ReservaWizard` em 3 passos: **Pessoas+Data+Hora → Ambiente → Dados**. Estado e validação ficam em [src/components/reserva/wizard/useReservaWizard.ts](src/components/reserva/wizard/useReservaWizard.ts) (state machine + schemas Zod por step).

- **E-mail é obrigatório no front público** — schema do wizard usa `z.string().email()` sem `.optional()`. Já o banco (`customers.email`), o agente IA WhatsApp e o Edge Function `create-reservation` continuam aceitando customer sem e-mail. Não promover essa regra pro backend sem coordenar com o canal WhatsApp (cliente WhatsApp raramente fornece e-mail).
- **Filtragem de halls no step 2** usa `partitionHalls()` em [wizard/availability-helpers.ts](src/components/reserva/wizard/availability-helpers.ts) — particiona em `compatible`/`alternative`/`closed` baseado em `schedules`, `min_capacity`/`max_capacity` (agregados das mesas ativas, vindos das RPCs) e `allow_empty_seat`. **Isso é apenas filtro visual** — `_shared/availability.ts` segue como fonte da verdade no submit; pode haver halls que "parecem compatíveis" e falham por bloqueio/conflito.
- **Acordeão "Não encontrou opção ideal?"** lista halls que abrem em outros horários do dia — click volta pro step 1 com `hall_id` pré-fixado e `time` resetado.
- **Mobile usa bottom-sheet fullscreen** via `ResponsiveDialog` (não o `Dialog` padrão). Wrapper em [src/components/ui/responsive-dialog.tsx](src/components/ui/responsive-dialog.tsx): `<640px` slide-up fullscreen, `≥640px` Dialog centrado. Inputs ficam `h-12` em mobile (tap target ≥44px). Footer com CTA sticky respeita `env(safe-area-inset-bottom)`.
- **Tipos centralizados**: `PublicHall` e `PublicHallSchedule` ficam em [src/types/reserva.ts](src/types/reserva.ts) — não duplicar localmente nos portais.

---

## Dashboard e métricas

Convenções de cálculo aplicadas em [useDashboardMetrics.ts](src/hooks/useDashboardMetrics.ts) e [useFluxoClientes.ts](src/hooks/useFluxoClientes.ts) — replicar em qualquer hook novo de relatório.

- **Taxa de cancelamento** = `cancelled / (confirmed + cancelled + no_show) * 100`. **Exclui pending** — denominador são apenas reservas com desfecho decidido. Retorna `null` quando o denominador é 0 (UI renderiza "—" via `KpiCard.formatValue`).
- **Taxa de no-show** = `no_show / (confirmed + no_show) * 100`. Mesma regra: `null` quando denom=0.
- **"Pessoas esperadas hoje"** (`useReservaStats.pessoas_hoje`) soma apenas reservas `pending` ou `confirmed`. Canceladas E no-show são excluídas. O hook retorna também `canceladas_hoje` e `no_show_hoje` para exibição contextual.
- **Gráfico "Ocupação por horário"** usa range dinâmico via [useUnitHourRange.ts](src/hooks/useUnitHourRange.ts), que agrega `hall_schedules.open_time/close_time` dos halls ativos. Fallback 8h-23h quando unit não tem halls/schedules.
- **`KpiCard.formatValue`** renderiza "—" para `null`, `undefined`, `NaN` e `Infinity`. Suffix ("%", "⭐") só aparece quando o valor é numérico finito.
- **Datas de eventos com timestamp UTC** (waitlist.created_at, walk_ins.arrived_at, notifications_sent.sent_at) — para agrupar por dia local, usar helper `isoToLocalDate(iso)` em vez de `.slice(0, 10)`. `.slice(0,10)` em UTC pode atribuir o dia errado para eventos próximos da meia-noite no fuso do restaurante. O padrão está em [useFluxoClientes.ts](src/hooks/useFluxoClientes.ts).
- **`getDay()` em timestamp UTC** retorna o dia da semana no fuso LOCAL do browser — para waitlist/walk-ins, parsear via `new Date(isoToLocalDate(iso) + "T12:00:00").getDay()`. Para reservas, `r.date` (YYYY-MM-DD) já é dia local — basta `new Date(r.date + "T00:00:00").getDay()`.
- **Ordenação de timestamps** — nunca usar `localeCompare` em strings ISO quando há mistura de formatos (com/sem `Z`, com/sem milissegundos). Sempre `new Date(iso).getTime()` numérico.

---

## Agente IA — Arquitetura

### Fluxo de uma mensagem WhatsApp

```
Cliente → Provider → webhook-whatsapp → resolve canal → carrega histórico
  → runAgentLoop() → salva resposta → sendOutbound() → Cliente
```

### Provedores suportados

| Provedor IA | Env var | Modelo padrão |
|---|---|---|
| Claude | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| Grok | `GROK_API_KEY` | `grok-3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |

Provedor ativo configurado por unidade via BYOK (ai_provider_credentials). Modelo configurado por unidade em `settings.ai_config.models[provider]` (string vazia ou ausente = fallback pro default). **Chave de API é obrigatória por unidade — sem chave o agente não responde**, conversa vai pra handoff humano automático (sem fallback global de secret da plataforma desde 2026-05-20).

- **Default de modelo vive em DOIS arquivos que precisam ficar sincronizados** — [src/lib/aiModels.ts](src/lib/aiModels.ts) `DEFAULT_MODEL_BY_PROVIDER` (UI exibe como "Padrão (X)") + [supabase/functions/_shared/ai-providers.ts](supabase/functions/_shared/ai-providers.ts) `DEFAULT_MODELS` (fallback runtime do `runAgentLoop`). Se mudar um sem o outro, UI promete X e backend usa Y silenciosamente. Quando o provedor descontinua um modelo (caso 2026-05: Google removeu `gemini-2.0-flash` pra contas novas → erro 404), atualizar AMBOS + atualizar a lista curada `MODELS_BY_PROVIDER` em `src/lib/aiModels.ts` (remover/substituir o ID) + redeploy de `webhook-whatsapp` e `manage-ai-providers` (compartilham `_shared/ai-providers.ts`).
- **Modelo é Select com lista curada, não input livre.** A UI de [Automacao.tsx](src/pages/gestao/Automacao.tsx) (`AITab`) lê `MODELS_BY_PROVIDER[provider]` e renderiza opções. Se o valor salvo em `settings.ai_config.models[provider]` não está mais na lista (modelo descontinuado), aparece como opção em âmbar marcada "(descontinuado — trocar)" — usuário continua vendo o que está ativo, mas é forçado visualmente a trocar.
- **Backend tem `resolveModel(provider, override)` como blindagem runtime** ([supabase/functions/_shared/ai-providers.ts](supabase/functions/_shared/ai-providers.ts)). `KNOWN_MODELS` (Set por provider) espelha `MODELS_BY_PROVIDER` da UI; modelo fora da lista é ignorado, cai no `DEFAULT_MODELS[provider]` e loga `evt:"ai_model_fallback"` com `rejected`+`used`+`unitId`. Motivação: incidente 2026-05-20 — unidade ficou com `gemini-2.0-flash` (descontinuado pelo Google) salvo via UI antiga, agente lançava 404 e caía em "problema técnico". Hoje o webhook continua respondendo mesmo se a config tem lixo, e o warning fica visível em logs pro platform admin caçar configs ruins. **Quando atualizar/remover um modelo, sincronize: UI `MODELS_BY_PROVIDER`, backend `KNOWN_MODELS`, defaults `DEFAULT_MODEL_BY_PROVIDER`/`DEFAULT_MODELS`.**

| Provider WhatsApp | Configuração |
|---|---|
| Z-API | `instance_id`, `token`, `client_token` |
| WAHA | `base_url`, `api_key`, `session_name` |
| Meta Cloud API | `phone_number_id`, `access_token`, `app_secret` |

### Tools do agente

`check_availability`, `create_reservation`, `get_reservation`, `update_reservation`, `cancel_reservation`, `list_customer_reservations` — todos aceitam `hall_name` opcional.

### Resiliência

- Truncamento: últimas 20 mensagens
- Prompt caching Claude (`cache_control: ephemeral`)
- Timeout 45s por chamada
- Telemetria: `evt: "agent_usage"` com token counts

### Invariantes pós-hardening (2026-05-20)

Auditoria 2026-05-20 fechou 3 bugs do webhook WhatsApp (confirmação dupla, mídia ignorada, fallback genérico em erro). Manter os invariantes abaixo ao tocar qualquer código de webhook/agente.

- **Reservas criadas via WhatsApp NÃO disparam template de confirmação.** O trigger SQL `enqueue_confirmation_notification` ([migration 028](supabase/migrations/20260507153453_028_notification_outbox.sql)) filtra `new.source is distinct from 'whatsapp'` — só enfileira `notification_outbox` quando reserva vem da web. Pra esse filtro funcionar, a coluna `reservations.source` precisa receber `'whatsapp'` quando criada pelo agente. Path: `webhook-whatsapp` → `createReservation` passa `source: "whatsapp"` para `reserveSlot` (em [_shared/availability.ts](supabase/functions/_shared/availability.ts)), que persiste em `reservations.source` (default `'web'`). Histórico: bug 2026-05-20 — `ReserveSlotParams` não incluía `source`, valor era silenciosamente descartado, toda reserva via WhatsApp gravava `source='web'` e disparava template duplicado. Replicar: qualquer Edge Function nova que crie reserva pelo agente DEVE passar `source: "whatsapp"`; qualquer caller do portal/wizard omite (default 'web' correto).
- **Mensagens não-texto (áudio/imagem/sticker/etc) recebem resposta hardcoded — nunca silêncio.** `parseInbound` em [_shared/whatsapp-providers.ts](supabase/functions/_shared/whatsapp-providers.ts) retorna null pra qualquer não-texto. Webhook chama `peekInboundMedia(provider, payload)` ANTES do `finish("ignored_non_text")` — se retornar `InboundMediaPeek`, executa fluxo dedicado (idempotency → customer → conversation → envio de `MEDIA_REPLY_TEXT`) sem invocar o LLM. Conversa em handoff humano (`human_active`/`awaiting_human`) recebe a mídia no log mas não dispara resposta automática — atendente assume. Outcome `media_response` em `webhook_executions`. Custo: zero token. NÃO transcrever áudio/visualizar imagem aqui (fora de escopo; estrutura `peekInboundMedia` deixa fácil plugar Whisper/Vision depois).
- **Erro do agente é auto-handoff, não retry.** Quando `runAgentLoop` lança exception (timeout, 4xx, modelo inválido, tool error não tratado), o webhook NÃO pede "tente de novo" — marca `conversations.status='awaiting_human'` com `handoff_reason: agent_error:<provider>:<model>`, avisa o cliente que humano assume, e grava `meta: {provider, model, channel_id}` em `webhook_executions` pra diagnóstico. Razão: erros estruturais (modelo descontinuado, quota exausta, key inválida) não resolvem com retry; cliente fica preso pingando o bot quebrado. Atendente vê a conversa em `/o/<unit>/conversas` com badge "Aguardando humano" e o handoff_reason mostra provider+model — clique pro Diagnóstico em `/platform/automacao/<slug>` mostra os últimos erros.
- **Chave de API de IA é per-unit, sem fallback global da plataforma.** `resolveApiKey` em [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts) lê SÓ de `ai_provider_credentials` filtrado por `(unit_id, provider, active=true)`. Sem chave cadastrada → `throw api_key_not_configured:<provider>` → o catch do caller faz auto-handoff (`status='awaiting_human'`, `handoff_reason='api_key_not_configured:<provider>'`) e manda mensagem amigável pro cliente, idêntico ao path `agent_error`. Removido o fallback `Deno.env.get(ANTHROPIC_API_KEY|OPENAI_API_KEY|...)` em 2026-05-20 porque mascarava como "vazamento entre lojas" (toda unit sem BYOK usava o mesmo secret global → cobrança não isolada por tenant). Mesma `api_key` pode coexistir em N units (UNIQUE composto `(unit_id, provider)` na tabela permite — dono com 2 restaurantes usa a mesma chave em ambas, esperado). Nenhum resolver futuro (novos providers, novos workers IA) deve reintroduzir fallback global silencioso.
- **Toda saída do LLM passa por `sanitizeForWhatsApp` antes de `sendOutbound` e antes de `appendToConversation`.** Helper em [supabase/functions/_shared/whatsapp-format.ts](supabase/functions/_shared/whatsapp-format.ts). Converte markdown padrão pro formato WhatsApp: `**bold**` → `*bold*`, `***x***` → `*_x_*`, `# Header` → `*Header*`, `* item` (lista) → `- item`, ``` ``` blocos``` ``` → texto cru, `` `inline` `` → texto cru, `[texto](http://url)` → `texto (http://url)`, e normaliza 3+ quebras de linha pra 2. O system prompt do agente em `webhook-whatsapp` já instrui o modelo a usar formato WhatsApp, mas modelos divergem entre provedores (Claude/GPT/Gemini/Grok/DeepSeek) e ignoram instruções ocasionalmente — sanitizer é rede defensiva. **Aplicar SÓ em saída de LLM** (`finalText` em [webhook-whatsapp/index.ts:1416](supabase/functions/webhook-whatsapp/index.ts)). NÃO aplicar em mensagens hardcoded (`MEDIA_REPLY_TEXT`, handoff, empty_response), templates de giftback/lembrete (já são autoria do lojista), nem em `send-manual-message` (operador digitou — respeitar). A versão sanitizada é o que vai pro cliente E o que vai pra `conversations.messages` — operador em `/o/<slug>/conversas` vê exatamente o que cliente recebeu. Quando criar Edge Function nova que envie resposta de LLM, sanitizar antes do send.
- **System prompt do agente injeta `special_dates` E `table_blocks` macro dos próximos 60 dias.** Sem `table_blocks` no contexto, o LLM responde "sim, aceitamos reservas pra dia X" pra perguntas genéricas (sem horário/party) — `check_availability` só dispara quando cliente fornece os 3 campos, então o bloqueio fica invisível na conversa inicial. Bug observado 2026-05-20: cliente perguntou "aceitam reservas pra 12/06?" e bot afirmou "sim", mesmo com bloqueio "Dia dos namorados" ativo. Implementação: query em [webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts) busca `table_blocks` com `table_id IS NULL` no horizonte de 60 dias, converte timestamps pra BRT (subtraindo 3h e lendo `getUTC*`), formata como `- DD/MM/YYYY (Título): fechado o dia inteiro` (ou range de horários), e injeta sob `Datas bloqueadas nos próximos 60 dias:`. Bloqueios hall-específicos (`hall_id != null`) recebem sufixo `— só no salão X` pra IA poder oferecer alternativa. Regra "5." obrigatória no prompt instrui o LLM a NÃO chamar `check_availability` quando a data está na lista — resposta direta de contexto, sem queimar tool call. Replicar: feature nova que adicione fonte de bloqueio (ex.: bloqueio recorrente) deve aparecer no mesmo bloco do prompt.
- **Timestamps de janela de reserva no `_shared/availability.ts` SEMPRE usam offset BRT explícito (`-03:00`).** Em `tryHall` e `checkAvailabilityLegacy`, `startISO`/`endISO` são gerados com `new Date(\`${date}T${time}:00-03:00\`).toISOString()`. Sem o offset, o runtime Deno (TZ=UTC) interpretava o horário como UTC e a comparação contra `table_blocks.blocked_from/blocked_to` (gravados em BRT) ficava 3h fora — bloqueios "dia inteiro" se salvavam pelo intervalo amplo, mas bloqueios PARCIAIS (ex.: 19h-22h BRT) deixavam reservas na borda inicial escaparem. Mesma convenção da função `minutesUntil` (que sempre usou `-03:00`). Quando criar query nova nesse arquivo que comparar timestamps com colunas BRT do banco, replicar o offset.

---

## Workers automáticos (pg_cron)

Todos seguem o mesmo padrão: `pg_cron` → wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post` chama Edge Function com `x-internal-key`.

| Job | Schedule | Edge Function | Descrição |
|---|---|---|---|
| `process-notification-outbox` | `*/1 * * * *` | process-notification-outbox | Outbox confirmação (lote 20, backoff 1m→4h, max 5 tentativas) |
| `process-voucher-triggers` | `0 12 * * *` UTC | process-voucher-triggers | Expira vouchers + emite por aniversário/frequência |
| `process-reservation-reminders` | `0 13 * * *` UTC (10:00 BRT) | process-reservation-reminders | Lembrete D-0 — dia da reserva (settings.reminder_d1_enabled) |
| `process-satisfaction-surveys` | `0 17 * * *` UTC (14:00 BRT) | process-satisfaction-surveys | Pesquisa D+1 (settings.survey_d1_enabled) |
| `cleanup-orphan-assets` | `0 4 * * 0` UTC (domingo 01:00 BRT) | cleanup-orphan-assets | Apaga blobs órfãos do bucket `unit-assets` (grace 60min). RPC `list_orphan_unit_assets(integer)` cruza com units/menus/menu_pages/menu_banners. Invocável manual: `?dry=1` ou `{dry:true}` no body. Migration `20260520000000_storage_orphan_cleanup_cron.sql`. |

Workers lêem templates de `reservation_message_templates` (`customized=true`) ou usam defaults hardcoded. Idempotência via UNIQUE `(reservation_id, kind)` em `notifications_sent`.

> Mantenha `defaultBody` em `useReservationTemplates.ts` em sincronia com `DEFAULT_*_BODY` nos workers (worker é a fonte autoritativa).

> **`verify_jwt=false` obrigatório em `supabase/config.toml`** para todo worker chamado via `pg_cron` (`process-*`). O CLI a partir de 2.95 trocou o default para `true` — sem entrada explícita o gateway responde 401 "Missing authorization header" antes de chegar no `requireInternalAuth`, e o cron silencia (pg_net é fire-and-forget, ninguém alerta). Já documentadas no config: outbox, voucher-triggers, reservation-reminders, satisfaction-surveys, waitlist-entered, waitlist-feedback. Nova função worker = nova entrada antes do deploy.

> **`verify_jwt=true` explícito em `supabase/config.toml`** para toda Edge Function de super-admin (`manage-channels`, `manage-members`, `manage-organizations`, `manage-ai-providers`, `whatsapp-health`). Defesa em profundidade junto à validação interna de `platform_admin`. Sem entrada o comportamento depende do default do CLI — explícito > implícito. Nova edge admin = nova entrada antes do deploy.

---

## Giftback — invariantes pós-hardening

Auditoria 2026-05-17 fechou 16 bugs (migration `20260517110000_giftback_hardening.sql`). Manter os invariantes abaixo ao tocar qualquer código de voucher.

- **Validade sempre fim-do-dia BRT.** Use `expiresAtEndOfDayBrt(validity_days)` de `_shared/giftback.ts` — runtime Deno é UTC, e `Date#setHours` em UTC daria meia-noite UTC (21:00 BRT do dia anterior). Igual ao frontend `endOfDayLocalISO` em `src/lib/utils.ts` (que roda no fuso do browser do operador). Não calcule offset manualmente em código novo.
- **Voucher só persiste se WhatsApp send OK.** No `webhook-whatsapp` o ciclo é `prepareGiftbackVoucher` (monta code+texto sem escrever) → `sendOutbound` → `commitGiftbackVoucher` (escreve voucher + `notifications_sent` com status real). Inverter essa ordem cria voucher fantasma: cliente recebe code que não existe no banco, ou ativo no banco sem cliente ter sido notificado.
- **`notifications_sent.status` precisa refletir o envio real** — `sent` se WhatsApp respondeu 2xx, `failed` com `error` preenchido caso contrário. Antes da auditoria o webhook gravava `sent` antes do envio.
- **Dedupe (rule, customer) é DB-enforced.** `vouchers_unit_rule_customer_active_idx` (UNIQUE PARTIAL) rejeita 2º voucher ativo pra mesmo (unit, rule, customer). Sempre tente o INSERT — se vier erro `23505`, trate como dedupe silencioso (`voucher_dedup_race` no log). Não confie só no `SELECT existing` antes do insert: `reprocessing_stuck_message` no webhook permite 2 execuções paralelas passarem o check.
- **`min_rating IS NULL` está bloqueado em `voucher_rules.trigger_type='after_rating'`** via CHECK. Query do webhook usa `.lte('min_rating', rating)` puro — sem `IS NULL` no `.or(...)`.
- **`processFrequency` conta apenas reservas até ontem (BRT).** `.lte('date', yesterdayIso)` é obrigatório — sem isso, cliente com reservas confirmadas no futuro dispara voucher antes de ter visitado.
- **Cooldown da frequência = `rule.validity_days`** (estável). NÃO use `windowStart` (que desliza dia a dia) como filtro de "já emiti antes" — cliente vira re-elegível assim que o window passa.
- **Phone vazio = skip do worker.** `processBirthday` e `processFrequency` filtram `phoneDigits.length >= 10` antes do `issueAndSend`. Sem isso, voucher é inserido e WhatsApp falha — voucher ativo no banco que cliente nunca viu.
- **29/02 em ano não-bissexto → dispara em 28/02** (regra civil BR). Lógica em `getTodayBrtParts` + flag `acceptLeapBirthday` no worker.
- **Advisory lock no worker:** `try_giftback_lock()` no início, `release_giftback_lock()` no `finally`. Evita cron + chamada manual concorrentes. Falha aberta (prossegue sem lock) é OK — UNIQUE PARTIAL pega o resto.
- **Mensagem do voucher é appendada em `conversations.messages`.** Rating intercept e comment intercept do webhook agora chamam `appendToConversation` pro incoming "5" e pro outgoing. Sem isso, operador na tela "Conversas" vê buraco entre survey D+1 e próxima mensagem.
- **`unitCache` do worker é zerado no início de cada invocação** (`unitCache.clear()`). Settings mudados via UI refletem na próxima execução do cron mesmo em Edge Function quente.

---

## Conversas — invariantes pós-hardening

Auditoria 2026-05-17 fechou 11 bugs (migration `20260517120000_conversation_append_atomic.sql`). Manter os invariantes abaixo ao tocar qualquer código que leia/escreva `conversations`.

- **Append em `conversations.messages` é SEMPRE via RPC `append_conversation_message(p_conversation_id, p_message)`.** Nunca mais fazer `SELECT messages → push → UPDATE messages` — esse padrão perdia mensagens em concorrência (inbound + worker do cron, ou 2 inbounds <100ms). A RPC é `SECURITY DEFINER`, grant só pra `service_role`, e usa `messages || jsonb_build_array(p_message)` no mesmo UPDATE → row lock serializa appends e nenhum é perdido. Writers atuais: `webhook-whatsapp` (helper `appendToConversation`), `send-manual-message`, `_shared/conversation-log.ts` (`appendOutboundToConversation`). Worker/edge function novo que precise appendar mensagem **tem que chamar a RPC** — nunca duplicar o padrão antigo.
- **Mensagem WhatsApp limita 4096 chars.** Frontend (`Textarea` em `Conversas.tsx`) e backend (`send-manual-message`) validam — frontend bloqueia via `maxLength` + toast, backend retorna 400 com `"mensagem excede 4096 caracteres"`. Provider rejeita ou trunca silenciosamente acima disso. Replicar validação em qualquer novo endpoint que envie mensagem manual.
- **`releaseToAI` limpa `handoff_reason` E `handoff_at`.** Quando devolve conversa pra IA, esses 2 campos viram NULL — sem isso, próximo handoff sem motivo herdava o motivo antigo no header da UI. Replicar em qualquer mutation nova que faça transição `human_active → ai_active`.
- **`markResolved` é alias semântico de `releaseToAI` — ambos limpam handoff e voltam status pra `ai_active`.** Antes (até 2026-05-20) o botão "Resolver" só setava `status='resolved'` e deixava `handoff_reason`/`handoff_at` fósseis, o que fazia o operador achar que tinha encerrado mas o estado de handoff continuava no banco. Nunca grave status `resolved` em código novo. Conversas com `resolved` no banco são legado e são auto-promovidas pra `ai_active` pelo webhook na próxima inbound ([webhook-whatsapp/index.ts logo após `getOrCreateConversation`](supabase/functions/webhook-whatsapp/index.ts)). O tab "Resolvidas" foi removido da UI; `STATUS_LABEL`/`STATUS_CLASSES` mantêm o entry só pra renderizar badge de conversas legadas sem quebrar TS.
- **`useSendManualMessage` faz optimistic update + rollback.** A mensagem aparece na thread instantaneamente via `setQueryData(["conversation-detail", id])`, com rollback em erro. Refetch real no `onSettled` substitui a versão optimistic. Padrão pra novas mutations que escrevem na thread.
- **Auto-scroll em thread Radix `ScrollArea` aponta para o viewport interno**, não para o ref raiz: `root.querySelector("[data-radix-scroll-area-viewport]")`. Setar `scrollTop` no wrapper raiz não tem efeito — o scroll real acontece no viewport. Pattern em `Conversas.tsx` `ConversationDetail`.
- **`useAwaitingHumanCount` escuta `event: "*"`** (não só `UPDATE`) — INSERT de conversa já em `awaiting_human` também atualiza o badge da sidebar.
- **`handleSend` tem guard reentrante** (`if (sendMessage.isPending) return`) antes de qualquer trim/validate. Ctrl+Enter rápido 2x não envia 2x WhatsApp (provider não dedupe).
- **`getConversationDisplayName` fallback final é `"Cliente sem nome"`** (não string vazia). Lista lateral sempre tem rótulo legível mesmo se customer.name + contact_name + phone forem todos vazios.
- **Shape canônico de `ConversationMessage`** (`{ role, content, timestamp, kind?, human_user_id? }`) continua autoritativo — a RPC valida que `role`, `content` e `timestamp` estão presentes e rejeita com `raise exception` se faltar. Não adicionar campo novo sem refletir no tipo em `src/types/reserva.ts`.
- **`appendOutboundToConversation` (em [supabase/functions/_shared/conversation-log.ts](supabase/functions/_shared/conversation-log.ts)) auto-cria conversa em `ai_active` se customer ainda não tem nenhuma.** Isso garante que mensagens de worker (confirmação, lembrete, survey, voucher) apareçam na timeline operacional mesmo no 1º contato. O helper é best-effort — nunca lança, falha de log não bloqueia o send. Workers/Edge Functions novos que registrem outbound NÃO devem fazer `INSERT into conversations` direto; sempre delegar ao helper.
- **Customer create/merge é SEMPRE via [`_shared/resolve-customer.ts`](supabase/functions/_shared/resolve-customer.ts) (`resolveOrCreateCustomer`).** Webhook WhatsApp e `create-reservation` usam o helper. Regras: dedupe por `(organization_id, phone)`, preserva `name` real cadastrado (nunca sobrescreve com push_name do WhatsApp), faz APPEND em `emails[]` se email é novo. Edge Function nova que crie customer **não deve duplicar lógica de upsert** — chamar o helper.
- **Subscription Supabase Realtime exige que a tabela esteja em `publication supabase_realtime`** — caso contrário o Postgres não emite `postgres_changes` e o `.on(...)` do frontend nunca dispara (UI só atualiza com F5). Coupling silencioso: o código JS "parece certo", o canal `subscribe()` retorna `SUBSCRIBED`, mas nenhum evento chega. Pattern: ao adicionar subscription nova (hoje em `useConversations`, `useAwaitingHumanCount`, `Conversas.tsx`, `AuthContext`), criar migration espelho de [20260519121500_realtime_auth_tables.sql](supabase/migrations/20260519121500_realtime_auth_tables.sql) / [20260519140000_realtime_conversations.sql](supabase/migrations/20260519140000_realtime_conversations.sql) — `do $$ alter publication supabase_realtime add table X exception when duplicate_object then null` (idempotente). RLS da tabela continua valendo no canal: clientes só recebem linhas que sua sessão pode ler, e o frontend ainda filtra `unit_id=eq.{unitId}` no `.on(...)` como defesa em profundidade.

---

## Painel Operacional — invariantes pós-hardening

Auditoria 2026-05-17 fechou bugs no painel operacional (`/o/:unitSlug`) — race conditions, erros virando "lista vazia", inconsistência send-then-update. Manter os invariantes abaixo em qualquer feature que envolva listas + mutations compartilhadas + actions externas.

- **Mutation que faz "external action + status UPDATE" trata cada lado separadamente.** Se a action externa (send WhatsApp, push notif, charge) suceder mas o UPDATE de status falhar depois, **NÃO relançar throw**: operador tentaria de novo, e proteções DB-side (ex.: UNIQUE PARTIAL `(waitlist_id, kind)` em `notifications_sent`) bloqueiam o 2º envio silenciosamente → cliente recebeu, banco diz que não. Padrão atual: retornar `{ externalOk, dbOk }`, mostrar `toast.warning("ação feita, estado não sincronizou — recarregue")` quando `dbOk=false`, e invalidar mesmo assim pra forçar reconciliação na próxima refetch. Pattern em [`useNotifyWaitlist`](src/hooks/useWaitlist.ts) — replicar em send-confirmation manual, charge, etc.
- **Desabilitar 1 botão entre N que compartilham mutation usa `mutation.variables`, não state extra.** Quando uma lista de cards compartilha a mesma mutation (`useUpdateWaitlistStatus`, `useUpdateWalkInStatus`, `useDeleteWalkIn`), checar `mutation.isPending && mutation.variables?.id === entry.id` para desabilitar apenas o botão da entry em flight — desabilitar a mutation globalmente trava a lista inteira em re-click. Pattern em [`Fila.tsx`](src/pages/operacional/Fila.tsx) (`isUpdatingEntry`) e [`Passantes.tsx`](src/pages/operacional/Passantes.tsx) (`isUpdating`/`isDeleting` props no `WalkInCard`).
- **Painéis que rodam o dia inteiro em tablet usam `refetchInterval` visibility-aware.** `refetchInterval: 30_000` fixo em tablet de salão aberto 8h = ~960 req/dia ociosas (aba em background). Padrão: helper `pollWhenVisible = () => typeof document !== "undefined" && document.hidden ? false : 30_000` passado como função. Pattern em [`useWalkIns.ts`](src/hooks/useWalkIns.ts) e [`useWaitlist.ts`](src/hooks/useWaitlist.ts).
- **Estado vazio em lista filtrada checa as listas DERIVADAS, não o total bruto.** `ReservasDia` filtra `pending`/`confirmed`; se as 5 reservas do dia estão todas `cancelled`, `!reservas?.length` é falso (passa o guard de vazio) mas as listas derivadas estão vazias → render em branco. Padrão: computar `hasActive = pending.length + confirmed.length > 0` e usar isso como condição de empty state, com submensagem contando `cancelled`/`no_show` pra contexto. Pattern em [`ReservasDia.tsx`](src/pages/operacional/ReservasDia.tsx).

---

## Membros e papéis

| Papel | Permissões |
|---|---|
| `owner` | Acesso total, incluindo criação de outras unidades |
| `gerente` | Configurações, membros, todos os dados da unidade (sem automação) |
| `operador` | Reservas, fila, walk-ins (operacional apenas) |

> **Origem dos dados de membros**: `unit_members` (escopo unidade) via Edge Function `manage-members` + hook `useUnitMembers`. Super-admins ficam em `platform_admins`. A tabela `admin_users` e a Edge Function `manage-admins` foram **removidas** no refactor multi-tenant — não reinstalar.

---

## Padrões de código

- Componentes em **PascalCase**, hooks em **camelCase** com prefixo `use`
- Queries/mutations via **TanStack React Query** — nunca `useState` + `useEffect` para dados remotos
- **`invalidateQueries` usa prefix-match — cuidado com ordem da queryKey.** Se a query é `["customers", orgId, unitId, search]` e o mutation invalida `["customers", unitId]`, **não casa** (a posição 1 é `orgId`, não `unitId`) e a UI fica com dado obsoleto até F5. Padrão: invalidate broad (`["customers"]`) ou montar a key na mesma ordem do mutation. Bug histórico: `useCustomers` invalidava `["customers", unitId]` enquanto `Clientes.tsx` lia `["customers", orgId, unitId, search]` — depois de editar/anonimizar a lista não atualizava.
- **Auditoria multi-tenant lê por `unit_id OR organization_id`** ([src/hooks/useAuditLog.ts](src/hooks/useAuditLog.ts)). Reservas E membros (`unit_members`) logam `unit_id`; clientes logam `organization_id` (porque `customers` pertence à org, não à unit). Query nova em `audit_log` precisa do `.or()` cobrindo os 2 — filtrar só por `unit_id` esconde silenciosamente anonimizações/edições de cliente do log da unidade. Ao adicionar novo `table_name` em [src/pages/gestao/Auditoria.tsx](src/pages/gestao/Auditoria.tsx), atualizar `TABLE_LABEL` E o `Select` de filtro (`unit_members → "Membro da unidade"` é o padrão atual).
- **Listas com TanStack Query devem tratar `isError` separado de `!data.length`.** Silenciar erro como "lista vazia" mascarou em produção o incidente "todos os clientes da Moralles sumiram" (RPC `get_customer_stats_bulk` faltava e a UI mostrou "Nenhum cliente encontrado"). Padrão: 4 branches — `isLoading`, `isError` (mensagem + botão `refetch()`), `empty`, `list`. Pattern em `Clientes.tsx`.
- **Operações batch que leem tabela inteira precisam paginar explícito** com `.range(from, to)` em loop até `chunk.length < PAGE`. Sem `.range()`, o PostgREST aplica `db-max-rows` default do Supabase (1000) e **trunca silenciosamente** — sem erro, sem warning. Vale pra exports (CSV/XLSX), backfills no client, agregações cross-tabela. Pattern em `exportClientesXlsx`.
- **Todo hook de dados aceita `unitId` como primeiro parâmetro** — usar `useCurrentUnit()` para obtê-lo
- Formulários via **React Hook Form + Zod**
- **`refetchOnWindowFocus: false`** é default global no `QueryClient` ([src/App.tsx](src/App.tsx)) — evita resetar form state ao trocar de aba. Painéis operacionais que precisam de dados ao vivo devem usar `refetchInterval` no hook específico (não reativar `refetchOnWindowFocus`).
- **`AuthContext` só ativa `loading=true` quando o user_id muda** ([src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx)). Supabase dispara `SIGNED_IN` em refoco de aba após token refresh; ativar loading nesse caso desmonta a árvore (guards renderizam Skeleton) e descarta state local dos forms. Manter o filtro por `currentUserId !== nextUserId`.
- **Nome da unidade vive em `units.name`** — é a fonte canônica usada pela sidebar (via `AuthContext.memberships`), portais públicos (`/r/:slug`, `/w`, `/m`, `Index`), breadcrumbs e headers. Owner/gerente pode escrever via RLS (policy `unit_owner_gerente_update_units`, migration 019). Após escrever, **chame `refreshMemberships()` do `useAuth()`** para atualizar a sidebar sem logout. O setting `restaurant_name` é **legado** — Edge Functions (`send-confirmation`, `webhook-whatsapp`) ainda leem com fallback `unit.name` para compat, mas a UI não deve escrever nele.
- **Slug da unidade (`units.slug`) é editável em Configurações** ao lado do nome (auto-sugerido via `slugify()` enquanto o campo não é tocado, ou manual). Mudar slug **invalida URLs antigas** (`/r/`, `/g/`, `/o/`, `/w/`, `/m/`) — QR codes impressos e links em mensagens WhatsApp já enviadas viram 404. O mutation faz `refreshMemberships()`, invalida `["all-units"]`, `["public-unit"]`, `["unit-public-content"]`, `["organizations"]` e renavega `/g/<antigo>` → `/g/<novo>`. Trata colisão (`23505`) com mensagem amigável. Não há autosync silencioso — qualquer mudança exige clique no Salvar do bloco de slug.
- **Nome do contato em Conversas** — exibir SEMPRE via `getConversationDisplayName()` de `@/lib/utils`. Ordem: `customer.name` (se ≠ phone) → `conversation.contact_name` (push_name corrente) → `formatPhone(phone)`. Push_name é extraído por `parseInbound` em `_shared/whatsapp-providers.ts` (Z-API `senderName`/`chatName`/`notifyName`, WAHA `_data.notifyName`/`pushName`, Meta `contacts[0].profile.name`) e persistido em DOIS lugares pelo `webhook-whatsapp`: (1) `customers.name` — só preenche quando customer é novo ou tem placeholder (`name == phone`); nunca sobrescreve nome real cadastrado via reserva; (2) `conversations.contact_name` — espelho atualizado a cada mensagem.
- **Shape de `conversations.messages`** — array JSONB de `{ role: "user"|"assistant"|"human", content, timestamp (ISO obrigatório), kind?, human_user_id? }`. Os 3 writers (`webhook-whatsapp`, `_shared/conversation-log.ts`, `send-manual-message`) sempre injetam `timestamp: new Date().toISOString()` — nenhum writer novo deve omitir esse campo. Mensagens órfãs históricas foram corrigidas pela migration `20260517100600_backfill_message_timestamps.sql`, que herdou `conversations.created_at` como aproximação e marcou cada mensagem corrigida com `timestamp_backfilled: true`. Essa flag NÃO deve ser replicada em writers novos — é só rastro auditável de backfill. O divisor de dia em `Conversas.tsx` (via `humanDateLabel`/`getMessageDayKey` em `@/lib/utils`) renderiza "Sem data" como fallback quando o timestamp é null/inválido — se a label reaparecer na UI, indica regressão (writer novo esqueceu o campo, ou import externo de mensagens sem ele).
- Notificações via **`toast` do Sonner** (`import { toast } from "sonner"`)
- Classes CSS via **`cn()`** de `@/lib/utils` — nunca template literals diretos com Tailwind
- Path alias `@/` aponta para `src/`
- Datas sempre em formato `YYYY-MM-DD` no banco; exibição via `formatDateBR()`
- Telefones sem formatação no banco (apenas dígitos); exibição via `formatPhone()`
- **Rodar `npm run typecheck` antes de commitar mudanças no frontend** — o dev server usa SWC (sem type check), então import faltante (`<Link>` sem `import { Link } from "react-router-dom"`) só explode em runtime via ErrorBoundary ("Algo deu errado"). Baseline atual: **zero erros**; qualquer novo erro é regressão.

## Tema visual: dois mundos

- **Warm restaurant (`:root`)** — paleta laranja + bege. Portais públicos e login.
- **Navy SaaS (`.theme-admin`)** — paleta navy + off-white. Painéis internos (GestaoLayout, OperacionalLayout, PlatformLayout).

`.theme-admin` sobrescreve TODAS as CSS variables dentro do escopo. **Nunca hardcode cores** — sempre via tokens do Tailwind (que mapeiam pras CSS vars).

## Hardening de segurança multi-tenant

- **Edge Functions nunca devolvem `error.message`/`String(err)` cru do Postgres nos 500.** O cliente recebe mensagem curta em PT-BR ("Falha ao listar canais.", "Falha ao criar empresa." etc.); o detalhe vai para `console.error`/`jsonLog` interno. Vaza schema/constraint/stack se exposto — atacante mapeia DB pela UI. **Exceção**: mensagens do Supabase Auth (`auth.admin.createUser` em `manage-organizations`) são amigáveis e UX-críticas — devolver intactas. Validações 400 (já em PT-BR) também ficam como estão. Pattern aplicado em `manage-channels`, `manage-organizations`, `manage-ai-providers`, `whatsapp-health`.
- **Anon nunca lê tabelas direto** — toda leitura pública via RPC `SECURITY DEFINER`. Adicionar policy `TO anon` direto na tabela é regressão.
- **Anon insere apenas em units/orgs públicas** — policies `anon_insert_*` têm `EXISTS (... WHERE is_public)`.
- **Tabelas com credenciais usam `FORCE RLS` sem policies** (whatsapp_channels, ai_provider_credentials, processed_messages, rate_limit_events). UI consome via Edge Function.
- **Edge Functions validam `unit_id`** da request contra o recurso — defense-in-depth.
- **CORS em `manage-*`** via `_shared/cors.ts` (whitelist localhost, *.vercel.app, reservas.moralles.com.br).
- **Storage `unit-assets`**: listing bloqueado, CDN público funciona.
- **Substituir/remover asset no bucket `unit-assets` exige cleanup duplo no client** — sem isso, trocar logo/hero/foto da galeria acumula órfãos no bucket indefinidamente (sem GC). Padrão em `Conta.tsx:handleSave`:
  1. **Diff DB-vs-form**: captura `prevHero/Logo/Gallery` de `content` ANTES da mutation, faz `await update.mutateAsync(...)`, depois compara contra os novos valores do form e marca os paths que sumiram.
  2. **Tracking de sessão**: parent mantém `uploadedRef` (Map publicUrl→path). Uploaders (`AssetUploader`, `GalleryEditor`) expõem callback `onUploaded({ publicUrl, path })` chamado a cada upload bem-sucedido. No save, qualquer path em `uploadedRef` que NÃO ficou no estado final do form é candidato a remoção. Sem isso, "Trocar imagem" 2x ou "adicionar+remover sem salvar" deixa órfão.
  3. **`supabase.storage.from().remove()` NÃO lança em RLS denied / arquivo inexistente** — retorna `{ data, error }`. Sempre destruture `const { error } = await ...remove([...])` e logue `error` explicitamente. O `try/catch` em volta só pega exceção de rede; sem checar `error` no return, falha de permissão fica invisível.
  4. SEMPRE filtre os paths via `extractStoragePath()` de `@/lib/utils` (rejeita URL de outro bucket → null) E confirme `path.startsWith(<unit_id>/)` antes de deletar (defesa contra cross-tenant).

  Replicar todos os 4 passos em qualquer feature nova que escreva no bucket (menus, banners, futuros uploads).
- **Ticket médio é um número único na UI → grava só em `units.price_range_max`, deixa `price_range_min` NULL.** Formatters `formatPriceRange` (PublicPortal) e `formatPriceRangeShort` (Index) renderizam "até R$ X" no branch `min == null && max != null`. Gravar `min = max` (copiar valor) produz "de R$ 150 até R$ 150" no portal e perde dado se algum admin tiver setado uma faixa real via SQL. Nenhuma escrita futura em `units` deve preencher `price_range_min` a partir de campo único do form — só faz sentido se a UI tiver dois inputs distintos. Histórico: bug B1 da auditoria 2026-05-17 corrigido por backfill em `20260518110000_units_price_range_min_backfill.sql` + fix em `Conta.tsx:handleSave`.
- **Toda policy RLS escopada por `unit_id` precisa de contraparte `platform_admin_*`** via `is_platform_admin(auth.uid())` — vale para tabelas E para `storage.objects` de buckets multi-tenant. `useCurrentUnit.ts` fabrica pseudo-membership "owner" para platform_admin operar unidades alheias; sem a policy paralela, a write é bloqueada apesar da UI mostrar "Proprietário". Pattern em `013_multi_tenant.sql`; storage cobre em `047_unit_assets_platform_admin.sql`.
- **Input do usuário em `.or()` / `.ilike()` PostgREST tem que passar por `sanitizeSearchTerm()`** de `@/lib/utils`. Remove `, ( ) % _ \ " ' \` *` (caracteres que quebram a sintaxe OR ou viram wildcards involuntários) e limita a 80 chars. Sem isso, buscar `O'Brien` ou `nome,id` quebra a query inteira ou retorna resultado errado. Já aplicado em `Clientes.tsx` e `exportClientesXlsx`. Pendente: `IssueVoucherDialog.tsx` ainda lê direto sem sanitizar.
- **URLs que vêm do banco e viram `<a href>` em portal público devem passar por `isSafeHttpUrl()`** de `@/lib/utils` antes de renderizar (bloqueia `javascript:`/`data:`/`vbscript:`). Hoje o único caso é `menu_banners.link_url` — frontend valida no save (`MenuBannerEditor`), portal valida no render (`MenuPortal.BannerCarousel`) e banco força com CHECK constraint `menu_banners_link_url_safe_check` (migration `20260517100800_menus_hardening.sql`). Qualquer novo campo "link salvo por membro" deve seguir esse triplo guard. Mesma migration documenta `menus.theme` (JSONB) cujo fallback campo a campo (`DEFAULT_MENU_THEME`) fica em `MenuPortal.safeColor()` — banco não força schema JSON, então frontend é o guardião.
- **Auto-logout de órfão** — quando o `user` está autenticado mas perde toda `unit_members` e **não** é `platform_admin`, o `AuthContext` ([src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx)) desloga automaticamente com toast e redireciona para `/admin/login`. Detecção em runtime via Supabase Realtime subscreve `unit_members` e `platform_admins` filtrado por `user_id`. Migration `20260519121500_realtime_auth_tables.sql` garante essas tabelas na publication. **Não adicionar de volta a tela estática "Sem acesso a nenhuma unidade"** — isso trava o user em sessão zumbi. Guards de `/g/:unitSlug` e `/o/:unitSlug` também checam membership na unit alvo e mandam pra `/admin` (que então o AuthContext resolve).

## Observabilidade da automação WhatsApp

- **Diagnóstico** em `/platform/automacao/<slug>` → aba "Diagnóstico" (whatsapp-health + useWhatsAppHealth)
- **`webhook_executions`**: toda execução com outcome (success, agent_error, send_error, duplicate, etc). FORCE RLS.
- **Idempotência segura**: `processed_messages` com started_at/completed_at. Reprocessa após 90s se incompleto.
- **UX handoff**: auto-resolve 12h sem reply humano → ai_active. Lembrete 1x/6h via `last_silenced_reply_at`.
- **HMAC SHA-256** para provider `official` (Meta). Z-API/WAHA usam `webhook_secret` per-channel.
- **SendResult estruturado**: `{ ok, status, error, bodySnippet, missingCreds }`.

## Deploy

### Frontend (Vercel)

Push em `main` dispara deploy. Vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

> `.npmrc` força `legacy-peer-deps=true`. Não remover.

### Edge Functions

Deploy individual: `supabase functions deploy <nome>`. Lista canônica das functions vive em [supabase/functions/](supabase/functions/) — não duplicar aqui.

> **Edge Functions não compartilham bundle em runtime.** Ao alterar arquivo em `_shared/`, redeploy de TODAS as functions que importam — sem redeploy continuam usando a versão antiga em memória.
>
> - `_shared/availability.ts` → redeploy de `create-reservation` + `webhook-whatsapp`.
> - `_shared/conversation-log.ts` → redeploy de TODAS as functions (webhook, send-*, workers process-*). Ao adicionar feature/worker novo que importe, atualizar este checklist.
> - `_shared/resolve-customer.ts` → redeploy de `create-reservation` + `webhook-whatsapp`.

## Adicionando novos componentes shadcn/ui

```bash
npx shadcn@latest add <componente>
```

Alternativa: copiar o `.tsx` do componente de outro projeto interno do design system (ex.: `moralles-agenda`). Não editar arquivos em `src/components/ui/` que já vieram do shadcn — wrappers próprios (ex.: `responsive-dialog.tsx`) ficam ao lado, com nome distinto.
