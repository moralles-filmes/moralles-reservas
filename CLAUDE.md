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
npm run dev        # servidor local em http://localhost:8080
npm run build      # build de produção em dist/
npm run preview    # servir o build local

# instalar dependências (legacy-peer-deps necessário por react-day-picker vs date-fns v4)
npm install --legacy-peer-deps
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
│   │   └── useAuth.ts                 # Autenticação Supabase Auth
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
│           ├── Mesas.tsx              # Gestão de mesas
│           └── Configuracoes.tsx      # Horários, provedor IA, system prompt
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_create_tables.sql      # Schema: customers, reservations, tables...
│   │   ├── 002_rls_policies.sql       # RLS + trigger updated_at
│   │   └── 003_ai_config_setting.sql  # Seed do ai_config no settings
│   │
│   └── functions/
│       ├── _shared/
│       │   └── ai-providers.ts        # Abstração multi-provedor (runAgentLoop)
│       ├── webhook-zapi/
│       │   └── index.ts               # Recebe msgs Z-API → executa agente IA
│       ├── send-whatsapp/
│       │   └── index.ts               # Envia mensagem via Z-API REST
│       └── send-confirmation/
│           └── index.ts               # Confirmação automática ao criar reserva
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

### Status de reserva

`pending` → `confirmed` → `no_show`  
`pending` ou `confirmed` → `cancelled`

### RLS

- Anon: pode inserir e ler `customers` e `reservations` (portal público)
- Authenticated: acesso total a todas as tabelas (admin)
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

### Personalizar o agente

No painel admin → **Configurações → Instruções do Agente IA**, o texto adicional é salvo em `settings.ai_system_prompt` e concatenado ao system prompt base.

---

## Deploy

### Frontend (Vercel)

```bash
# Variáveis de ambiente no painel Vercel:
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

### Edge Functions (Supabase)

```bash
supabase functions deploy webhook-zapi
supabase functions deploy send-whatsapp
supabase functions deploy send-confirmation
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
