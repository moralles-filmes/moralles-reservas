# moralles-reservas

Sistema de reservas de mesa para restaurante com agente de IA via WhatsApp.

## Visão geral

- **Portal público** (`/`) — clientes fazem reservas via formulário web ou consultam pelo código
- **Agente IA WhatsApp** — responde clientes, cria/altera/cancela reservas conversacionalmente
- **Painel admin** (`/admin`) — gestão completa de reservas, clientes, mesas e configurações

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
| WhatsApp | Z-API |
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

# 3. Aplicar migrations 001–003 (SQL Editor no painel ou `supabase db push`)

# 4. Criar o auth user inicial (será o super_admin)
#    Painel: Authentication > Users > Add user (marcar "Auto Confirm User")
#    Ou via Auth Admin API:
curl -X POST "$VITE_SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"voce@exemplo.com","password":"…","email_confirm":true}'

# 5. Aplicar migration 004 (seed promove o e‑mail a super_admin)
#    Se for fork: troque o e‑mail hardcoded em 004_admin_users.sql antes de rodar.

# 6. Subir
npm run dev   # http://localhost:8080/auth
```

---

## Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha:

```bash
VITE_SUPABASE_URL=       # Settings > API no painel Supabase
VITE_SUPABASE_ANON_KEY=  # Settings > API no painel Supabase
```

As demais variáveis (API keys, Z-API, service role key) são **secrets das Edge Functions** — nunca vão no `.env` do frontend:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
supabase secrets set ZAPI_INSTANCE_ID=...
supabase secrets set ZAPI_TOKEN=...
supabase secrets set ZAPI_CLIENT_TOKEN=...

# Hardening — gere ambos com `openssl rand -hex 32`
supabase secrets set ZAPI_WEBHOOK_SECRET=...   # validar origem do webhook (header X-Webhook-Secret no painel Z-API)
supabase secrets set INTERNAL_API_KEY=...      # auth do send-whatsapp / send-confirmation (header X-Internal-Key no DB Webhook)

# Apenas o provedor de IA ativo precisa estar configurado:
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # Claude
supabase secrets set OPENAI_API_KEY=sk-...          # OpenAI
supabase secrets set GEMINI_API_KEY=AIza...         # Gemini
supabase secrets set GROK_API_KEY=xai-...           # Grok
supabase secrets set DEEPSEEK_API_KEY=sk-...        # DeepSeek
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
│   │   └── reserva.ts                 # Tipos: Reserva, Customer, Mesa, Conversation...
│   │
│   ├── lib/
│   │   ├── supabase.ts                # Cliente Supabase (singleton)
│   │   ├── utils.ts                   # cn(), formatDateBR(), formatPhone()
│   │   └── zapi.ts                    # Templates de mensagem WhatsApp (referência)
│   │
│   ├── hooks/
│   │   ├── useReservas.ts             # CRUD de reservas via React Query
│   │   ├── useAuth.ts                 # Autenticação + updateEmail/updatePassword + isSuperAdmin
│   │   ├── useAdminUsers.ts           # Listar/criar/excluir admins (via Edge Function)
│   │   ├── useCustomers.ts            # Update customer + get_customer_stats + anonymize_customer
│   │   ├── useTableBlocks.ts          # CRUD de bloqueios de mesa
│   │   ├── useSpecialDates.ts         # CRUD de datas especiais (feriados)
│   │   └── useAuditLog.ts             # Lista de audit_log (LGPD)
│   │
│   ├── stores/
│   │   └── reservaStore.ts            # Filtros do painel admin (Zustand)
│   │
│   ├── components/
│   │   ├── ui/                        # shadcn/ui — não editar diretamente
│   │   ├── reserva/
│   │   │   ├── ReservaForm.tsx        # Formulário público de reserva
│   │   │   └── ReservaCard.tsx        # Card de reserva com ações de status
│   │   └── admin/
│   │       └── AdminLayout.tsx        # Sidebar + layout das páginas admin
│   │
│   └── pages/
│       ├── Index.tsx                  # Landing pública: formulário + consulta
│       ├── Auth.tsx                   # Login admin
│       └── admin/
│           ├── Dashboard.tsx          # Métricas do dia
│           ├── Reservas.tsx           # Lista com filtros
│           ├── Calendario.tsx         # Visão calendário mensal
│           ├── Clientes.tsx           # Histórico de clientes
│           ├── Conversas.tsx          # Histórico de chats WhatsApp
│           ├── Mesas.tsx              # Gestão de mesas + bloqueios
│           ├── Auditoria.tsx          # Trilha LGPD de quem alterou o quê
│           └── Configuracoes.tsx      # Horários, datas especiais, provedor IA, conta + admins
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_create_tables.sql           # Schema: customers, reservations, tables...
│   │   ├── 002_rls_policies.sql            # RLS + trigger updated_at
│   │   ├── 003_ai_config_setting.sql       # Seed do ai_config no settings
│   │   ├── 004_admin_users.sql             # Tabela admin_users (role + seed do super admin)
│   │   ├── 005_hardening.sql               # Fecha leitura anon, RPC get_reservation_by_code, idempotência, rate limit
│   │   ├── 006_hardening_followups.sql     # Revoke check_rate_limit + lock search_path em update_updated_at
│   │   ├── 007_product_features.sql        # table_blocks, special_dates, prefs do customer, get_customer_stats
│   │   ├── 008_composite_indexes.sql       # Índices compostos (status,date) (date,time) (customer_id,created_at)
│   │   ├── 009_lgpd.sql                    # audit_log + triggers, anonymize_customer, customers.deleted_at
│   │   ├── 010_lgpd_followups.sql          # Revoke audit_trigger_func de anon/auth
│   │   └── 011_notifications_and_satisfaction.sql  # notifications_sent + reservations.satisfaction_rating + RPCs do N8N
│   │
│   └── functions/
│       ├── _shared/
│       │   └── ai-providers.ts        # Abstração multi-provedor (runAgentLoop)
│       ├── webhook-zapi/
│       │   └── index.ts               # Recebe msgs Z-API → executa agente IA
│       ├── send-whatsapp/
│       │   └── index.ts               # Envia mensagem via Z-API REST
│       ├── send-confirmation/
│       │   └── index.ts               # Confirmação automática ao criar reserva
│       └── manage-admins/
│           └── index.ts               # Cadastrar/excluir admins (super admin only)
│
├── .env.example                       # Template de variáveis de ambiente
├── tailwind.config.ts
├── vite.config.ts
└── CLAUDE.md                          # Este arquivo
```

---

## Banco de dados (Supabase)

### Tabelas

| Tabela | Descrição |
|---|---|
| `customers` | Clientes — `name`, `phone` (unique), `email` |
| `reservations` | Reservas — `customer_id`, `table_id`, `date`, `time`, `party_size`, `status`, `reservation_code` (unique) |
| `tables` | Mesas do restaurante — `number`, `capacity`, `location`, `active` |
| `conversations` | Histórico de chats WhatsApp — `messages` (JSONB array) |
| `business_hours` | Horários por dia da semana — `open_time`, `close_time`, `is_closed` |
| `settings` | Configurações chave-valor — `restaurant_name`, `ai_system_prompt`, `ai_config` |
| `admin_users` | Admins do painel — `id` (FK `auth.users`), `email`, `role` (`admin`/`super_admin`), `created_by` |
| `table_blocks` | Bloqueios de mesa por intervalo (`blocked_from`/`blocked_to` timestamptz, `reason`) — manutenção, evento privado |
| `special_dates` | Feriados/datas especiais — sobrescreve `business_hours` numa data exata. Campos: `date` unique, `name`, `is_closed`, `open_time`, `close_time`, `max_party_size`, `notes` |
| `audit_log` | Trilha de auditoria de `customers` e `reservations` (LGPD). Triggers AFTER INSERT/UPDATE/DELETE registram `old_values`/`new_values`/`actor_id`/`actor_email`. Visível em `/admin/auditoria` |
| `notifications_sent` | Log/idempotência de mensagens outbound disparadas pelo N8N (`kind` ∈ `confirmation`/`reminder_d1`/`survey_d1`). `unique(reservation_id, kind)` impede duplicação. As RPCs `get_reservations_for_reminder` / `get_reservations_for_survey` filtram pela ausência do registro |

### Status de reserva

`pending` → `confirmed` → `no_show`  
`pending` ou `confirmed` → `cancelled`

### RLS

- Anon: pode inserir e ler `customers` e `reservations` (portal público)
- Authenticated: acesso total a todas as tabelas (admin)
- `admin_users`: authenticated tem **só leitura**; toda escrita passa pela Edge Function `manage-admins` (service role)
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
Cliente → Z-API → webhook-zapi (Edge Function)
  → carrega histórico da conversa (Supabase)
  → monta system prompt + history + tools
  → runAgentLoop() [_shared/ai-providers.ts]
    → loop: chama IA → executa tools → repete até end_turn
  → salva resposta no histórico
  → envia resposta via Z-API → Cliente
```

### Provedores suportados

| Provedor | Env var da chave | Modelo padrão |
|---|---|---|
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| Gemini (Google) | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Grok (xAI) | `GROK_API_KEY` | `grok-3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |

O provedor ativo é configurado no painel admin em **Configurações → Provedor de IA** e salvo na tabela `settings` com a chave `ai_config`.

### Tools do agente

Definidas em `webhook-zapi/index.ts` como `agentTools: AgentTool[]`:

| Tool | O que faz |
|---|---|
| `check_availability` | Verifica mesas disponíveis para data/hora/pessoas |
| `create_reservation` | Cria reserva e atualiza/cria o customer pelo telefone |
| `get_reservation` | Busca reserva por código ou telefone |
| `update_reservation` | Altera data, hora, pessoas ou observações |
| `cancel_reservation` | Cancela reserva (status → cancelled) |
| `list_customer_reservations` | Lista reservas ativas do cliente (sem precisar de código) |

O **system prompt é montado dinamicamente** com horários do `business_hours`, próximas `special_dates` (60 dias) e preferências do cliente (alergias, restrições, VIP, mesa preferida) quando existirem.

### Resiliência do agente

- **Truncamento de histórico** — apenas as últimas 20 mensagens entram no contexto (configurável via `maxHistoryMessages`).
- **Prompt caching do Claude** — `system` enviado como bloco com `cache_control: ephemeral`, ~90% de redução de custo em cache hit.
- **Timeout** — `AbortController` de 45s por chamada (Edge Function tem limite de 60s).
- **Telemetria** — log estruturado `evt: "agent_usage"` por mensagem com `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_creation_tokens`.

### Personalizar o agente

No painel admin → **Configurações → Instruções do Agente IA**, o texto adicional é salvo em `settings.ai_system_prompt` e concatenado ao system prompt base.

---

## Usuários do painel

Há dois papéis em `admin_users`:

- **`super_admin`** — pode cadastrar e excluir outros admins. Definido por seed na migration `004_admin_users.sql` (e‑mail `morallesfilms@gmail.com`).
- **`admin`** — acesso total ao painel, mas não vê o card de gestão de usuários.

Em **Configurações** todo admin pode trocar o próprio e‑mail e a própria senha. O cadastro/exclusão de outros admins é feito pela Edge Function `manage-admins`, que valida o JWT do chamador e exige `role = 'super_admin'` antes de chamar `auth.admin.createUser` / `auth.admin.deleteUser`. A coluna `id` em `admin_users` referencia `auth.users(id) on delete cascade`, então excluir o auth user limpa o registro automaticamente.

---

## Deploy

### Frontend (Vercel)

Integração via GitHub — cada push em `main` dispara deploy de produção, cada PR cria preview URL.

**Configuração no Vercel:**
- **Framework Preset**: Vite (auto-detectado)
- **Root Directory**: `./`
- **Build Command** / **Output Directory**: padrões do Vite (`npm run build` / `dist`)
- **Variáveis de ambiente** (Production + Preview):
  ```
  VITE_SUPABASE_URL=...
  VITE_SUPABASE_ANON_KEY=...
  ```

> O arquivo `.npmrc` na raiz força `legacy-peer-deps=true` no `npm install` do build (necessário pelo conflito `react-day-picker` vs `date-fns v4`). Não remover.

**Pós-deploy — obrigatório:** em **Supabase → Authentication → URL Configuration**, configurar:
- **Site URL**: URL Vercel de produção
- **Redirect URLs**: `https://<sua-url-vercel>/**`

Sem isso o login no `/auth` falha em produção (Supabase rejeita redirect de domínio não autorizado).

### Edge Functions (Supabase)

```bash
supabase functions deploy webhook-zapi
supabase functions deploy send-whatsapp
supabase functions deploy send-confirmation
supabase functions deploy manage-admins
```

### Webhook Z-API

No painel da Z-API, configure o webhook de **mensagens recebidas** apontando para:
```
https://<project-ref>.supabase.co/functions/v1/webhook-zapi
```

### Database Webhook (confirmação automática)

No painel Supabase → **Database → Webhooks**, crie um webhook:
- Tabela: `reservations`
- Evento: `INSERT`
- URL: `https://<project-ref>.supabase.co/functions/v1/send-confirmation`

### Automações N8N (lembrete D-1, pesquisa D+1)

Outbound agendado fica fora das Edge Functions e é orquestrado por N8N. Setup, credenciais e testes em [`docs/n8n/README.md`](docs/n8n/README.md). Os workflows ficam em [`docs/n8n/workflow-reminder-d1.json`](docs/n8n/workflow-reminder-d1.json) e [`docs/n8n/workflow-survey-d1.json`](docs/n8n/workflow-survey-d1.json) (importáveis no N8N v1.x).

A captura da nota 1-5 da pesquisa é feita pelo `webhook-zapi` antes de invocar o agente IA — busca em `notifications_sent` se houve `survey_d1` enviado nas últimas 36h e atualiza `reservations.satisfaction_rating` direto.

---

## Padrões de código

- Componentes em **PascalCase**, hooks em **camelCase** com prefixo `use`
- Queries/mutations via **TanStack React Query** — nunca `useState` + `useEffect` para dados remotos
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
