# moralles-reservas

Sistema de reservas de mesa para restaurante com agente de IA via WhatsApp. Arquitetura **multi-tenant**: organizations → units → unit_members.

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
# IA (fallback se unit não tiver BYOK)
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
  ├── /clientes|conversas|configuracoes|pagina-publica|auditoria|usuarios

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
│   │   ├── useDashboardMetrics.ts / useFluxoClientes.ts / useComunicacao.ts
│   │   ├── useAvaliacoes.ts / useVouchers.ts / useGiftbackSettings.ts / useGiftbackRelatorio.ts
│   │   ├── useOrganizations.ts / useWhatsAppChannels.ts / useWhatsAppHealth.ts
│   │   ├── useConversations.ts / useAwaitingHumanCount.ts / useSendManualMessage.ts
│   │   ├── useUnitPublicContent.ts / useUnitAssetUpload.ts / useDiscoverUnits.ts
│   │   └── useAdminUsers.ts           # Legacy (será removido)
│   │
│   ├── stores/reservaStore.ts         # Filtros do painel (Zustand)
│   │
│   ├── components/
│   │   ├── Breadcrumb.tsx             # Breadcrumb compartilhado. BreadcrumbReservas e BreadcrumbRelatorios delegam pra cá
│   │   ├── PageHeader.tsx             # Header compartilhado — props: breadcrumb, title, description, children
│   │   ├── ui/                        # shadcn/ui — não editar diretamente
│   │   ├── reserva/
│   │   │   ├── ReservaForm.tsx        # Formulário público (salão, slots, extras, custom fields, aniversário → customers.birthday)
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
│   │   └── UnitSwitcher.tsx           # Legado — substituído por SidebarUnitProfile
│   │
│   └── pages/
│       ├── Index.tsx / PublicPortal.tsx / WidgetPortal.tsx / MenuPortal.tsx / Auth.tsx
│       ├── gestao/
│       │   ├── Dashboard.tsx / Reservas.tsx / Calendario.tsx / Clientes.tsx / Conversas.tsx
│       │   ├── Configuracoes.tsx / Automacao.tsx / Avaliacoes.tsx / PaginaPublica.tsx
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
│   ├── migrations/        # 001–045 (ver nomes dos arquivos para contexto)
│   └── functions/
│       ├── _shared/
│       │   ├── ai-providers.ts        # Abstração multi-provedor (runAgentLoop)
│       │   ├── cors.ts                # corsHeadersFor — whitelist de Origin
│       │   ├── email.ts               # Wrapper Resend
│       │   ├── whatsapp-providers.ts  # parseInbound / sendOutbound / SendResult / validateMetaSignature
│       │   ├── whatsapp-send.ts       # sendWhatsApp — exige pareamento channel_id↔unit_id
│       │   ├── retry.ts              # fetchWithRetry (exponential backoff)
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
| `audit_log` | Trilha LGPD |
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
| `voucher_rules` | Regras Giftback — `trigger_type` (after_rating/manual/birthday/frequency), `discount_percent`, `validity_days` |
| `vouchers` | Instâncias — `code` (8 chars), `status` (active/used/expired/cancelled) |

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
| Gemini | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Grok | `GROK_API_KEY` | `grok-3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |

Provedor ativo configurado por unidade via BYOK (ai_provider_credentials). Fallback: secret global.

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

---

## Workers automáticos (pg_cron)

Todos seguem o mesmo padrão: `pg_cron` → wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post` chama Edge Function com `x-internal-key`.

| Job | Schedule | Edge Function | Descrição |
|---|---|---|---|
| `process-notification-outbox` | `*/1 * * * *` | process-notification-outbox | Outbox confirmação (lote 20, backoff 1m→4h, max 5 tentativas) |
| `process-voucher-triggers` | `0 12 * * *` UTC | process-voucher-triggers | Expira vouchers + emite por aniversário/frequência |
| `process-reservation-reminders` | `0 13 * * *` UTC (10:00 BRT) | process-reservation-reminders | Lembrete D-0 — dia da reserva (settings.reminder_d1_enabled) |
| `process-satisfaction-surveys` | `0 17 * * *` UTC (14:00 BRT) | process-satisfaction-surveys | Pesquisa D+1 (settings.survey_d1_enabled) |

Workers lêem templates de `reservation_message_templates` (`customized=true`) ou usam defaults hardcoded. Idempotência via UNIQUE `(reservation_id, kind)` em `notifications_sent`.

> Mantenha `defaultBody` em `useReservationTemplates.ts` em sincronia com `DEFAULT_*_BODY` nos workers (worker é a fonte autoritativa).

---

## Membros e papéis

| Papel | Permissões |
|---|---|
| `owner` | Acesso total, incluindo criação de outras unidades |
| `gerente` | Configurações, membros, todos os dados da unidade (sem automação) |
| `operador` | Reservas, fila, walk-ins (operacional apenas) |

---

## Padrões de código

- Componentes em **PascalCase**, hooks em **camelCase** com prefixo `use`
- Queries/mutations via **TanStack React Query** — nunca `useState` + `useEffect` para dados remotos
- **Todo hook de dados aceita `unitId` como primeiro parâmetro** — usar `useCurrentUnit()` para obtê-lo
- Formulários via **React Hook Form + Zod**
- **`refetchOnWindowFocus: false`** é default global no `QueryClient` ([src/App.tsx](src/App.tsx)) — evita resetar form state ao trocar de aba. Painéis operacionais que precisam de dados ao vivo devem usar `refetchInterval` no hook específico (não reativar `refetchOnWindowFocus`).
- **`AuthContext` só ativa `loading=true` quando o user_id muda** ([src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx)). Supabase dispara `SIGNED_IN` em refoco de aba após token refresh; ativar loading nesse caso desmonta a árvore (guards renderizam Skeleton) e descarta state local dos forms. Manter o filtro por `currentUserId !== nextUserId`.
- **Nome da unidade vive em `units.name`** — é a fonte canônica usada pela sidebar (via `AuthContext.memberships`), portais públicos (`/r/:slug`, `/w`, `/m`, `Index`), breadcrumbs e headers. Owner/gerente pode escrever via RLS (policy `unit_owner_gerente_update_units`, migration 019). Após escrever, **chame `refreshMemberships()` do `useAuth()`** para atualizar a sidebar sem logout. O setting `restaurant_name` é **legado** — Edge Functions (`send-confirmation`, `webhook-whatsapp`) ainda leem com fallback `unit.name` para compat, mas a UI não deve escrever nele.
- **Slug da unidade (`units.slug`) é editável em Configurações** ao lado do nome (auto-sugerido via `slugify()` enquanto o campo não é tocado, ou manual). Mudar slug **invalida URLs antigas** (`/r/`, `/g/`, `/o/`, `/w/`, `/m/`) — QR codes impressos e links em mensagens WhatsApp já enviadas viram 404. O mutation faz `refreshMemberships()`, invalida `["all-units"]`, `["public-unit"]`, `["unit-public-content"]`, `["organizations"]` e renavega `/g/<antigo>` → `/g/<novo>`. Trata colisão (`23505`) com mensagem amigável. Não há autosync silencioso — qualquer mudança exige clique no Salvar do bloco de slug.
- **Nome do contato em Conversas** — exibir SEMPRE via `getConversationDisplayName()` de `@/lib/utils`. Ordem: `customer.name` (se ≠ phone) → `conversation.contact_name` (push_name corrente) → `formatPhone(phone)`. Push_name é extraído por `parseInbound` em `_shared/whatsapp-providers.ts` (Z-API `senderName`/`chatName`/`notifyName`, WAHA `_data.notifyName`/`pushName`, Meta `contacts[0].profile.name`) e persistido em DOIS lugares pelo `webhook-whatsapp`: (1) `customers.name` — só preenche quando customer é novo ou tem placeholder (`name == phone`); nunca sobrescreve nome real cadastrado via reserva; (2) `conversations.contact_name` — espelho atualizado a cada mensagem.
- Notificações via **`toast` do Sonner** (`import { toast } from "sonner"`)
- Classes CSS via **`cn()`** de `@/lib/utils` — nunca template literals diretos com Tailwind
- Path alias `@/` aponta para `src/`
- Datas sempre em formato `YYYY-MM-DD` no banco; exibição via `formatDateBR()`
- Telefones sem formatação no banco (apenas dígitos); exibição via `formatPhone()`
- **Rodar `npm run typecheck` antes de commitar mudanças no frontend** — o dev server usa SWC (sem type check), então import faltante (`<Link>` sem `import { Link } from "react-router-dom"`) só explode em runtime via ErrorBoundary ("Algo deu errado"). Hoje há ~4 erros pré-existentes (toaster/use-toast órfãos do shadcn + `String.replaceAll` exigindo lib ES2021); use-os como baseline e detecte regressões pela contagem.

## Tema visual: dois mundos

- **Warm restaurant (`:root`)** — paleta laranja + bege. Portais públicos e login.
- **Navy SaaS (`.theme-admin`)** — paleta navy + off-white. Painéis internos (GestaoLayout, OperacionalLayout, PlatformLayout).

`.theme-admin` sobrescreve TODAS as CSS variables dentro do escopo. **Nunca hardcode cores** — sempre via tokens do Tailwind (que mapeiam pras CSS vars).

## Hardening de segurança multi-tenant

- **Anon nunca lê tabelas direto** — toda leitura pública via RPC `SECURITY DEFINER`. Adicionar policy `TO anon` direto na tabela é regressão.
- **Anon insere apenas em units/orgs públicas** — policies `anon_insert_*` têm `EXISTS (... WHERE is_public)`.
- **Tabelas com credenciais usam `FORCE RLS` sem policies** (whatsapp_channels, ai_provider_credentials, processed_messages, rate_limit_events). UI consome via Edge Function.
- **Edge Functions validam `unit_id`** da request contra o recurso — defense-in-depth.
- **CORS em `manage-*`** via `_shared/cors.ts` (whitelist localhost, *.vercel.app, reservas.moralles.com.br).
- **Storage `unit-assets`**: listing bloqueado, CDN público funciona.
- **Toda policy RLS escopada por `unit_id` precisa de contraparte `platform_admin_*`** via `is_platform_admin(auth.uid())` — vale para tabelas E para `storage.objects` de buckets multi-tenant. `useCurrentUnit.ts` fabrica pseudo-membership "owner" para platform_admin operar unidades alheias; sem a policy paralela, a write é bloqueada apesar da UI mostrar "Proprietário". Pattern em `013_multi_tenant.sql`; storage cobre em `047_unit_assets_platform_admin.sql`.

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

```bash
supabase functions deploy webhook-whatsapp
supabase functions deploy send-whatsapp
supabase functions deploy send-confirmation
supabase functions deploy send-cancellation
supabase functions deploy manage-channels
supabase functions deploy manage-ai-providers
supabase functions deploy manage-members
supabase functions deploy manage-organizations
supabase functions deploy send-manual-message
supabase functions deploy whatsapp-health
supabase functions deploy process-notification-outbox
supabase functions deploy process-voucher-triggers
supabase functions deploy process-reservation-reminders
supabase functions deploy process-satisfaction-surveys
supabase functions deploy create-reservation
```

> Ao alterar `_shared/availability.ts`, sempre redeploy `create-reservation` e `webhook-whatsapp`.

## Adicionando novos componentes shadcn/ui

Copie do projeto `moralles-agenda`:
```
/Users/yurimoraes/Documents/APPs Moralles/moralles-agenda/src/components/ui/<componente>.tsx
```
