# moralles-reservas

Sistema de reservas de mesa para restaurante com agente de IA via WhatsApp. Arquitetura **multi-tenant**: organizations → units → unit_members.

## Visão geral

- **Portal público** (`/r/:slug`) — clientes fazem reservas via formulário web ou consultam pelo código
- **Agente IA WhatsApp** — responde clientes, cria/altera/cancela reservas conversacionalmente
- **Painel de Gestão** (`/g/:unitSlug`) — configurações, relatórios, clientes, automação, auditoria
- **Painel Operacional** (`/o/:unitSlug`) — reservas do dia, fila de espera, walk-ins (uso em tempo real)

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
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm test             # Vitest (run once)
npm run test:watch   # Vitest em watch mode

# instalar dependências (legacy-peer-deps necessário por react-day-picker vs date-fns v4)
npm install --legacy-peer-deps
```

---

## Primeira execução

Bootstrap do zero (ordem importa — o seed da migration `004` espera o auth user existir):

```bash
# 1. Dependências
npm install --legacy-peer-deps

# 2. .env do frontend (preencher VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY)
cp .env.example .env

# 3. Aplicar migrations 001–013 (SQL Editor no painel ou `supabase db push`)

# 4. Criar o auth user inicial (será o super_admin)
#    Painel: Authentication > Users > Add user (marcar "Auto Confirm User")
#    Ou via Auth Admin API:
curl -X POST "$VITE_SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"voce@exemplo.com","password":"…","email_confirm":true}'

# 5. Aplicar migration 004 (seed promove o e-mail a super_admin / unit_member)
#    Se for fork: troque o e-mail hardcoded em 004_admin_users.sql antes de rodar.

# 6. Subir
npm run dev   # http://localhost:8080/admin/login
```

---

## Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha:

```bash
VITE_SUPABASE_URL=       # Settings > API no painel Supabase
VITE_SUPABASE_ANON_KEY=  # Settings > API no painel Supabase
```

As demais variáveis (API keys, WhatsApp, service role key) são **secrets das Edge Functions** — nunca vão no `.env` do frontend:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...

# Legado Z-API (usado como fallback enquanto não há whatsapp_channels configurados)
supabase secrets set ZAPI_INSTANCE_ID=...
supabase secrets set ZAPI_TOKEN=...
supabase secrets set ZAPI_CLIENT_TOKEN=...
supabase secrets set ZAPI_WEBHOOK_SECRET=...   # validar origem do webhook Z-API

# Hardening geral
supabase secrets set INTERNAL_API_KEY=...      # auth do send-whatsapp / send-confirmation

# E-mail (Resend) — opcional. Sem isso, send-confirmation só manda WhatsApp.
# Cadastre domínio em resend.com e configure SPF/DKIM/DMARC antes de produção.
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set RESEND_FROM_EMAIL="Moralles Reservas <reservas@seudominio.com.br>"

# Apenas o provedor de IA ativo precisa estar configurado:
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # Claude
supabase secrets set OPENAI_API_KEY=sk-...          # OpenAI
supabase secrets set GEMINI_API_KEY=AIza...         # Gemini
supabase secrets set GROK_API_KEY=xai-...           # Grok
supabase secrets set DEEPSEEK_API_KEY=sk-...        # DeepSeek
```

---

## Roteamento

```
/                            → Index.tsx (landing pública — redireciona para /r/<slug-padrão>)
/r/:slug                     → PublicPortal.tsx — formulário de reserva + consulta por código
/admin/login                 → Auth.tsx — login (já logado é redirecionado para /admin)
/admin                       → redireciona conforme auth state:
                                  • deslogado → /admin/login
                                  • com unit → /g/<defaultSlug>
                                  • platform_admin sem unit → /platform
                                  • logado sem nada → mensagem "Sem acesso a nenhuma unidade"

/g/:unitSlug                 → Painel de Gestão (GestaoLayout)
  ├── /                      → Dashboard
  ├── /reservas              → Lista de reservas com filtros
  ├── /calendario            → Visão calendário mensal
  ├── /clientes              → Histórico e perfil de clientes
  ├── /conversas             → Histórico de chats WhatsApp
  ├── /mesas                 → Gestão de mesas + bloqueios
  ├── /configuracoes         → Horários, datas especiais, conta, membros
  ├── /automacao             → WhatsApp channels + Provedor de IA + System prompt
  ├── /avaliacoes            → Avaliações de satisfação
  └── /auditoria             → Trilha LGPD

/o/:unitSlug                 → Painel Operacional (OperacionalLayout)
  ├── /                      → Reservas do dia (agrupadas por status)
  ├── /fila                  → Fila de espera (waitlist)
  └── /passantes             → Walk-ins (clientes sem reserva)
```

---

## Estrutura de arquivos

```
moralles-reservas/
├── src/
│   ├── App.tsx                        # Roteamento + providers globais
│   ├── main.tsx                       # Entry point React
│   ├── index.css                      # CSS variables (tema warm restaurant)
│   │
│   ├── types/
│   │   └── reserva.ts                 # Tipos: Reserva, Customer, Mesa, WalkIn, WaitlistEntry...
│   │
│   ├── lib/
│   │   ├── supabase.ts                # Cliente Supabase (singleton)
│   │   ├── utils.ts                   # cn(), formatDateBR(), formatPhone()
│   │   └── zapi.ts                    # Templates de mensagem WhatsApp (referência)
│   │
│   ├── hooks/
│   │   ├── useReservas.ts             # CRUD de reservas via React Query
│   │   ├── useAuth.ts                 # Autenticação + memberships + defaultUnitSlug
│   │   ├── useCurrentUnit.ts          # Lê :unitSlug da URL, retorna unit + org + role
│   │   ├── useUnitMembers.ts          # Lista/cria/remove membros da unidade
│   │   ├── useCustomers.ts            # Update customer + get_customer_stats + anonymize
│   │   ├── useTableBlocks.ts          # CRUD de bloqueios de mesa
│   │   ├── useSpecialDates.ts         # CRUD de datas especiais (feriados)
│   │   ├── useAuditLog.ts             # Lista de audit_log (LGPD)
│   │   ├── useWalkIns.ts              # CRUD de walk-ins (Operacional)
│   │   └── useWaitlist.ts             # CRUD de fila de espera (Operacional)
│   │
│   ├── stores/
│   │   └── reservaStore.ts            # Filtros do painel (Zustand)
│   │
│   ├── components/
│   │   ├── ui/                        # shadcn/ui — não editar diretamente
│   │   ├── reserva/
│   │   │   ├── ReservaForm.tsx        # Formulário público — aceita prop unit; TIME_SLOTS dinâmicos do business_hours
│   │   │   └── ReservaCard.tsx        # Card de reserva com ações de status
│   │   ├── layouts/
│   │   │   ├── GestaoLayout.tsx       # Sidebar + layout das páginas de gestão
│   │   │   └── OperacionalLayout.tsx  # Header minimalista + navegação operacional
│   │   └── UnitSwitcher.tsx           # Dropdown de troca de unidade no header
│   │
│   └── pages/
│       ├── Index.tsx                  # Landing pública (redireciona para /r/slug)
│       ├── PublicPortal.tsx           # Portal público escopado por unit slug
│       ├── Auth.tsx                   # Login
│       ├── gestao/
│       │   ├── Dashboard.tsx          # Métricas e KPIs da unidade
│       │   ├── Reservas.tsx           # Lista com filtros amplos
│       │   ├── Calendario.tsx         # Visão calendário mensal
│       │   ├── Clientes.tsx           # Histórico de clientes (escopado por organização)
│       │   ├── Conversas.tsx          # Histórico de chats WhatsApp
│       │   ├── Mesas.tsx              # Gestão de mesas + bloqueios
│       │   ├── Configuracoes.tsx      # Horários, datas especiais, conta, membros da equipe
│       │   ├── Automacao.tsx          # WhatsApp channels + Provedor de IA + System prompt
│       │   ├── Avaliacoes.tsx         # Avaliações de satisfação pós-reserva
│       │   └── Auditoria.tsx          # Trilha LGPD
│       └── operacional/
│           ├── ReservasDia.tsx        # Reservas do dia agrupadas por status
│           ├── Fila.tsx               # Fila de espera com timers e notificação WhatsApp
│           └── Passantes.tsx          # Walk-ins — registro, alocação de mesa, status
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_create_tables.sql
│   │   ├── 002_rls_policies.sql
│   │   ├── 003_ai_config_setting.sql
│   │   ├── 004_admin_users.sql            # Seed super_admin → unit_member (migration 013 migra)
│   │   ├── 005_hardening.sql
│   │   ├── 006_hardening_followups.sql
│   │   ├── 007_product_features.sql       # table_blocks, special_dates, customer prefs
│   │   ├── 008_composite_indexes.sql
│   │   ├── 009_lgpd.sql
│   │   ├── 010_lgpd_followups.sql
│   │   ├── 011_notifications_and_satisfaction.sql
│   │   ├── 012_n8n_functions.sql
│   │   ├── 013_multi_tenant.sql           # organizations, units, unit_members, platform_admins, whatsapp_channels + RLS multi-tenant
│   │   └── 014_operacional.sql            # walk_ins, waitlist + RLS
│   │
│   └── functions/
│       ├── _shared/
│       │   ├── ai-providers.ts            # Abstração multi-provedor (runAgentLoop)
│       │   ├── email.ts                   # Wrapper Resend (fetch, timeout 15s, log estruturado)
│       │   └── whatsapp-providers.ts      # Abstração WhatsApp: parseInbound / sendOutbound por provider
│       ├── webhook-whatsapp/
│       │   └── index.ts                   # Webhook unificado — resolve canal por ?channel=<id>
│       ├── webhook-zapi/
│       │   └── index.ts                   # Mantido por compatibilidade (redireciona internamente)
│       ├── send-whatsapp/
│       │   └── index.ts                   # Aceita channel_id ou unit_id; fallback Z-API legacy
│       ├── send-confirmation/
│       │   └── index.ts                   # WhatsApp + e-mail (Resend) em paralelo; resolve canal via unit_id
│       ├── manage-channels/
│       │   └── index.ts                   # CRUD de whatsapp_channels (valida papel gerente/owner)
│       └── manage-members/
│           └── index.ts                   # Substitui manage-admins; escopo por unidade
│
├── .env.example
├── tailwind.config.ts
├── vite.config.ts
└── CLAUDE.md                          # Este arquivo
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
| `units` | Restaurante físico — `organization_id`, `name`, `slug` unique, `address`, `timezone` |
| `unit_members` | Membros com papel por unidade — `user_id`, `unit_id`, `role` |
| `platform_admins` | Admins internos do SaaS (suporte) |
| `customers` | Clientes — `name`, `phone` unique por `organization_id`, `email` |
| `reservations` | Reservas — `unit_id`, `customer_id`, `table_id`, `date`, `time`, `party_size`, `status`, `reservation_code` |
| `tables` | Mesas — `unit_id`, `number` unique por unidade, `capacity`, `location`, `active` |
| `conversations` | Histórico de chats WhatsApp — `unit_id`, `messages` JSONB |
| `business_hours` | Horários — `unit_id`, `day_of_week` (0=dom…6=sáb), `open_time`, `close_time`, `is_closed` |
| `settings` | Configurações chave-valor — `unit_id`, `key`, `value` |
| `table_blocks` | Bloqueios de mesa — `table_id`, `blocked_from`/`blocked_to`, `reason` |
| `special_dates` | Datas especiais — `unit_id`, `date` unique por unidade, `is_closed`, `open_time`, `close_time` |
| `audit_log` | Trilha LGPD — `unit_id`, `table_name`, `operation`, `old_values`, `new_values`, `actor_id` |
| `notifications_sent` | Log/idempotência outbound — `unit_id`, `reservation_id`, `kind`, `status` |
| `whatsapp_channels` | Canais WhatsApp por unidade — `unit_id`, `provider` (zapi/waha/official), `credentials` JSONB criptografado, `status`, `display_phone` |
| `walk_ins` | Clientes sem reserva no dia — `unit_id`, `customer_name`, `party_size`, `table_id?`, `status` (waiting/seated/left/no_show) |
| `waitlist` | Fila de espera — `unit_id`, `customer_name`, `party_size`, `priority`, `status` (waiting/notified/seated/cancelled) |

### Status de reserva

`pending` → `confirmed` → `no_show`  
`pending` ou `confirmed` → `cancelled`

### Status de walk-in

`waiting` → `seated` → `left`  
`waiting` → `no_show`

### Status de fila (waitlist)

`waiting` → `notified` → `seated`  
`waiting` ou `notified` → `cancelled`

### RLS

- Anon: pode inserir e ler `customers` e `reservations` (portal público)
- Authenticated: acesso escopado por `is_unit_member(auth.uid(), unit_id)` — nunca vê dados de outra unidade
- Edge Functions usam `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS)

### Rodar migrações

```bash
supabase db push
# ou manualmente no SQL Editor do painel Supabase
```

---

## Agente IA — Arquitetura

### Fluxo de uma mensagem WhatsApp

```
Cliente → Provider WhatsApp → webhook-whatsapp (Edge Function)
  → resolve unit_id pelo canal (?channel=<id>)
  → carrega histórico da conversa (Supabase)
  → monta system prompt + history + tools
  → runAgentLoop() [_shared/ai-providers.ts]
    → loop: chama IA → executa tools → repete até end_turn
  → salva resposta no histórico
  → sendOutbound() [_shared/whatsapp-providers.ts] → Cliente
```

### Provedores de IA suportados

| Provedor | Env var da chave | Modelo padrão |
|---|---|---|
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| Gemini (Google) | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Grok (xAI) | `GROK_API_KEY` | `grok-3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |

O provedor ativo e o system prompt são configurados por unidade em **Gestão → Automação → Provedor de IA**.

### Provedores WhatsApp suportados

| Provider | Configuração | Webhook URL |
|---|---|---|
| Z-API | `instance_id`, `token`, `client_token` | `.../webhook-whatsapp?channel=<id>` |
| WAHA | `base_url`, `api_key`, `session_name` | `.../webhook-whatsapp?channel=<id>` |
| Meta Cloud API | `phone_number_id`, `access_token`, `app_secret` | `.../webhook-whatsapp?channel=<id>` |

Canais são configurados por unidade em **Gestão → Automação → Canais WhatsApp**. Cada canal tem um `webhook_secret` individual (substitui o global `ZAPI_WEBHOOK_SECRET`).

### Tools do agente

| Tool | O que faz |
|---|---|
| `check_availability` | Verifica mesas disponíveis para data/hora/pessoas |
| `create_reservation` | Cria reserva e atualiza/cria o customer pelo telefone |
| `get_reservation` | Busca reserva por código ou telefone |
| `update_reservation` | Altera data, hora, pessoas ou observações |
| `cancel_reservation` | Cancela reserva (status → cancelled) |
| `list_customer_reservations` | Lista reservas ativas do cliente |

### Resiliência do agente

- **Truncamento de histórico** — apenas as últimas 20 mensagens entram no contexto
- **Prompt caching do Claude** — `system` com `cache_control: ephemeral`, ~90% de redução de custo
- **Timeout** — `AbortController` de 45s por chamada
- **Telemetria** — log `evt: "agent_usage"` com token counts

---

## Módulo Operacional

### Fila de espera (`/o/:slug/fila`)

- Clientes aguardam mesa sem reserva prévia
- Ações: Notificar via WhatsApp, Sentar, Confirmar entrada (após notificado), Remover
- Timer colorido: verde <15min, âmbar 15–30min, vermelho ≥30min

### Walk-ins (`/o/:slug/passantes`)

- Registro imediato de clientes que chegaram sem reserva
- Alocação de mesa via dropdown antes de "Sentar"
- Ações: Sentar, Não apareceu, Foi embora, Remover

---

## Membros e papéis

| Papel | Permissões |
|---|---|
| `owner` | Acesso total, incluindo criação de outras unidades |
| `gerente` | Configurações, automação, membros, todos os dados da unidade |
| `operador` | Reservas, fila, walk-ins (acesso operacional apenas) |

O cadastro/remoção de membros é feito via Edge Function `manage-members`, que valida papel `owner` ou `gerente` antes de executar.

---

## Deploy

### Frontend (Vercel)

Integração via GitHub — cada push em `main` dispara deploy de produção.

**Configuração no Vercel:**
- **Framework Preset**: Vite (auto-detectado)
- **Build Command** / **Output Directory**: padrões do Vite (`npm run build` / `dist`)
- **Variáveis de ambiente** (Production + Preview):
  ```
  VITE_SUPABASE_URL=...
  VITE_SUPABASE_ANON_KEY=...
  ```

> O arquivo `.npmrc` força `legacy-peer-deps=true` (necessário pelo conflito `react-day-picker` vs `date-fns v4`). Não remover.

**Pós-deploy:** em **Supabase → Authentication → URL Configuration**:
- **Site URL**: URL Vercel de produção
- **Redirect URLs**: `https://<sua-url-vercel>/**`

### Edge Functions

```bash
supabase functions deploy webhook-whatsapp
supabase functions deploy send-whatsapp
supabase functions deploy send-confirmation
supabase functions deploy manage-channels
supabase functions deploy manage-members
```

### Webhook WhatsApp

Para cada canal configurado em **Automação**, a URL do webhook é exibida na UI:
```
https://<project-ref>.supabase.co/functions/v1/webhook-whatsapp?channel=<channel-id>
```

Configure essa URL no painel do provider (Z-API, WAHA ou Meta).

### Database Webhook (confirmação automática)

No painel Supabase → **Database → Webhooks**:
- Tabela: `reservations`
- Evento: `INSERT`
- URL: `https://<project-ref>.supabase.co/functions/v1/send-confirmation`

### Automações N8N (lembrete D-1, pesquisa D+1)

Orquestração em N8N. Setup e workflows em [`docs/n8n/README.md`](docs/n8n/README.md).

**RPCs disponíveis para N8N** (`SECURITY DEFINER`, acesso exclusivo ao `service_role`):

| RPC | Assinatura | O que faz |
|---|---|---|
| `check_rate_limit` | `(phone, window_seconds, max, unit_id) → bool` | Rate limit por (phone, unit) |
| `append_message` | `(conv_id, role, content) → void` | Append mensagem no histórico |
| `get_upcoming_reservations` | `(from_date, to_date, unit_id) → table` | Reservas no intervalo |

---

## Padrões de código

- Componentes em **PascalCase**, hooks em **camelCase** com prefixo `use`
- Queries/mutations via **TanStack React Query** — nunca `useState` + `useEffect` para dados remotos
- **Todo hook de dados aceita `unitId` como primeiro parâmetro** — usar `useCurrentUnit()` para obtê-lo
- Formulários via **React Hook Form + Zod** — schemas de validação em `zod`
- Notificações via **`toast` do Sonner** (`import { toast } from "sonner"`)
- Classes CSS via **`cn()`** de `@/lib/utils` — nunca template literals diretos com Tailwind
- Path alias `@/` aponta para `src/`
- Datas sempre em formato `YYYY-MM-DD` no banco; exibição via `formatDateBR()` de `@/lib/utils`
- Telefones sem formatação no banco (apenas dígitos); exibição via `formatPhone()`

## Adicionando novos componentes shadcn/ui

Os componentes ficam em `src/components/ui/`. Para adicionar um novo, copie do projeto `moralles-agenda` (referência de stack):
```
/Users/yurimoraes/Documents/APPs Moralles/moralles-agenda/src/components/ui/<componente>.tsx
```

## Custo estimado mensal

| Serviço | Custo |
|---|---|
| Supabase (Free tier) | Gratuito |
| Z-API | ~R$97/mês |
| Anthropic / OpenAI / etc. | ~$5–20/mês (por volume) |
| Vercel (Hobby) | Gratuito |
