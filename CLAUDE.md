# moralles-reservas

Sistema de reservas de mesa para restaurante com agente de IA via WhatsApp. Arquitetura **multi-tenant**: organizations → units → unit_members.

## Visão geral

- **Landing pública** (`/`) — descobrir restaurantes por cidade, busca por nome, redireciona para o portal escolhido
- **Portal público do restaurante** (`/r/:slug`) — landing rica com hero, logo, descrição, faixa de preço, mapa; CTAs para reservar e entrar na fila; consulta por código. Suporta `?mode=embed` (versão limpa só com os CTAs, pra iframe/bio do Insta) e `?action=reservar|waitlist` (auto-abre o dialog correspondente). Combina: `?mode=embed&action=reservar` é o caminho default pra "link de reserva limpo"
- **Widget de reserva** (`/w/:slug`) — link compartilhável **com campos personalizados por widget** (`field_config`, `client_instructions`). Cada unit pode ter N widgets pra campanhas distintas. Pra link simples sem customização, prefira `/r/:slug?mode=embed` em vez de criar widget
- **Agente IA WhatsApp** — responde clientes, cria/altera/cancela reservas conversacionalmente
- **Painel de Gestão** (`/g/:unitSlug`) — configurações, relatórios, clientes, auditoria, **edição da página pública**
- **Painel Plataforma** (`/platform`) — exclusivo do super-admin: empresas, unidades e automação (canais WhatsApp + chaves de IA + system prompt)
- **Painel Operacional** (`/o/:unitSlug`) — reservas do dia, fila de espera, walk-ins (uso em tempo real)

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
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm test             # Vitest (run once)
npm run test:watch   # Vitest em watch mode

# instalar dependências (legacy-peer-deps necessário por react-day-picker vs date-fns v4)
npm install --legacy-peer-deps
```

### Travou com "Failed to fetch dynamically imported module"

Sintoma: rota lazy (ex.: `/r/:slug`) cai no `ErrorBoundary` mesmo após reload. Causa quase sempre é cache do Vite corrompido — em especial quando o repo está em pasta sincronizada por iCloud Drive (`~/Documents`), porque o iCloud renomeia `node_modules/.vite/deps/` para `deps 2/`, `deps 3/` durante a otimização e os hashes `?v=...` dos imports param de bater.

```bash
# mata o vite, limpa cache, sobe limpo
lsof -ti:8080 | xargs kill 2>/dev/null
rm -rf node_modules/.vite
npm run dev
# no browser: Cmd+Shift+R; se persistir, sessionStorage.clear() no DevTools
```

Se `node_modules/.vite/` voltar a aparecer com `deps 2/`, `deps 3/`, mover o projeto pra fora de `~/Documents` (ex.: `~/Code/`) é a única solução definitiva — iCloud não é compatível com `node_modules`.

---

## Primeira execução

Bootstrap do zero (ordem importa — o seed da migration `004` espera o auth user existir):

```bash
# 1. Dependências
npm install --legacy-peer-deps

# 2. .env do frontend (preencher VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY)
cp .env.example .env

# 3. Aplicar migrations 001–019 (SQL Editor no painel ou `supabase db push`)

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

# Legado Z-API — fallback caso `whatsapp_channels` não tenha canal connected
# para a unit. Cada canal moderno tem seu próprio webhook_secret per-channel,
# então ZAPI_WEBHOOK_SECRET só era usado pelo endpoint legacy /webhook-zapi
# (hoje 410 Gone — todo webhook passa pelo path multi-tenant
# /webhook-whatsapp?channel=<id>&secret=<webhook_secret>). Pode ser removido
# após confirmar que nenhum canal externo aponta pro legacy.
supabase secrets set ZAPI_INSTANCE_ID=...
supabase secrets set ZAPI_TOKEN=...
supabase secrets set ZAPI_CLIENT_TOKEN=...

# Hardening geral
supabase secrets set INTERNAL_API_KEY=...      # auth do send-whatsapp / send-confirmation / process-* (outbox, voucher, reminder, survey)

# pg_cron precisa ler INTERNAL_API_KEY pra invocar 4 workers:
#   • process-notification-outbox  (a cada 1min)  — confirmação
#   • process-voucher-triggers     (12:00 UTC)    — giftback
#   • process-reservation-reminders (13:00 UTC = 10:00 BRT) — lembrete D-1
#   • process-satisfaction-surveys (17:00 UTC = 14:00 BRT) — pesquisa D+1
# Como pg_cron roda no Postgres (não tem acesso aos Edge Function secrets),
# o valor TAMBÉM precisa estar no Supabase Vault como `internal_api_key`:
#   select vault.create_secret('SEU_INTERNAL_API_KEY', 'internal_api_key');
# Sem isso, os crons logam 'internal_api_key ausente' e não disparam (não quebram).
# Se rotacionar a chave, atualizar nos DOIS lugares (secrets Edge Function + Vault).

# E-mail (Resend) — opcional. Sem isso, send-confirmation só manda WhatsApp.
# Cadastre domínio em resend.com e configure SPF/DKIM/DMARC antes de produção.
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set RESEND_FROM_EMAIL="Moralles Reservas <reservas@seudominio.com.br>"

# Provedor de IA — duas opções:
#
# 1) BYOK por unidade via UI (preferencial): super-admin cadastra a chave de
#    cada unidade em Plataforma → Automação → <unidade> → Provedor de IA. Vai
#    pra tabela ai_provider_credentials, isolada por RLS + service_role.
#
# 2) Secret global (fallback): só usado se a unidade não tiver chave no banco.
#    Útil pra setup inicial ou enquanto migra clientes.
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # Claude
supabase secrets set OPENAI_API_KEY=sk-...          # OpenAI
supabase secrets set GEMINI_API_KEY=AIza...         # Gemini
supabase secrets set GROK_API_KEY=xai-...           # Grok
supabase secrets set DEEPSEEK_API_KEY=sk-...        # DeepSeek
```

---

## Roteamento

```
/                            → Index.tsx — landing pública: seletor de cidade + busca + grid de restaurantes
/r/:slug                     → PublicPortal.tsx — landing do restaurante: hero, logo, sobre, preço, mapa,
                                CTAs (Reservar / Entrar na Fila) em Dialog, consulta por código.
                                Query params: ?mode=embed (esconde hero/sobre/mapa/footer, só CTAs centralizados)
                                e ?action=reservar|waitlist (auto-abre o dialog correspondente)
/w/:slug                     → WidgetPortal.tsx — widget de reserva minimalista (card flutuante);
                                renderiza ReservaForm com field_config/client_instructions customizados por widget.
                                Pra link simples sem customização, use /r/:slug?mode=embed
/m/:slug                     → MenuPortal.tsx — cardápio digital público (galeria de imagens) com
                                paleta customizada, banners da home (carrossel topo) e de conteúdo (rodapé)
/admin/login                 → Auth.tsx — login (já logado é redirecionado para /admin)
/admin                       → redireciona conforme auth state:
                                  • deslogado → /admin/login
                                  • com unit → /g/<defaultSlug>
                                  • platform_admin sem unit → /platform
                                  • logado sem nada → mensagem "Sem acesso a nenhuma unidade"

/g/:unitSlug                 → Painel de Gestão (GestaoLayout)
  ├── /                      → Dashboard
  ├── /relatorios ▼          → Menu collapsable Relatórios
  │   ├── /relatorios/fluxo-clientes  → 4 tabs internas (Visão geral / Reserva / Fila / Passante) + KPIs + 3 charts + DateRangePicker + Export CSV
  │   ├── /relatorios/vendas          → Stub "em breve" (depende de pagamentos integrados)
  │   ├── /relatorios/comunicacao     → 6 tabs (Visão geral / Reserva / Fila / Marketing(em breve) / Avaliação / Giftback(em breve)). KPIs WhatsApp+Email+taxa entrega+falhas, charts envios diário e por kind, tabela de falhas recentes na Visão geral
  │   ├── /relatorios/avaliacoes      → 2 tabs (Visão geral / Respostas). Visão geral: média + distribuição + taxa de resposta + cards "em breve" (perguntas de escala/escolha única). Respostas: tabela paginada com filtro por nota + tooltip do comentário + export CSV. DateRangePicker.
  │   └── /relatorios/giftback        → KPIs (emitidos/usados/conversão/cancelados) + LineChart emissões vs. usos por dia + BarChart por gatilho + tabela "Últimos vouchers". DateRangePicker.
  ├── /reservas ▼            → Menu collapsable
  │   ├── /reservas          → Lista de reservas com filtros
  │   ├── /reservas/calendario        → Visão calendário mensal
  │   ├── /reservas/saloes            → Salões (substitui /mesas) — lista de salões
  │   ├── /reservas/saloes/:hallId    → Detalhe do salão: grade horária, mesas, "cadeira vazia"
  │   ├── /reservas/datas-especiais   → Override de horário/cobrança por intervalo de datas
  │   ├── /reservas/bloqueios         → Bloqueios macro (intervalo de datas) + toggle "Permitir overbooking"
  │   ├── /reservas/widget            → Widgets de reserva (link público customizável)
  │   ├── /reservas/widget/:widgetId  → Detalhe widget: 3 tabs (Compartilhamento/Personalização/Integrações)
  │   ├── /reservas/formulario        → Personalizar formulário (campos texto/opções/arquivo)
  │   ├── /reservas/comunicacao       → Templates customizáveis de lembrete D-1 e pesquisa D+1 (renderiza via {{cliente_nome}}/{{horario}}/{{party_size}}/{{codigo}}/{{unidade_nome}})
  │   └── /reservas/ajustes           → Ajustes (janela, duração, tolerância, regras, info adicional, toggles reminder_d1_enabled/survey_d1_enabled, pagamentos)
  ├── /fila ▼                → Menu collapsable Fila de espera
  │   ├── /fila/comunicacao  → 2 tabs: Customização de mensagens (templates WhatsApp por evento) + Configurações (stub)
  │   └── /fila/ajustes      → QR Code, modal prioritários, código min/max, tolerância, entrada remota + sidebar download QR
  ├── /cardapios ▼           → Menu collapsable Cardápios
  │   ├── /cardapios/meus-cardapios            → Lista de cardápios + sidebar Compartilhar+QR (do selecionado) + modal Adicionar
  │   ├── /cardapios/meus-cardapios/:menuId    → Detalhe: 3 tabs (Compartilhamento, Galeria, Personalização)
  │   ├── /cardapios/banners                   → 2 tabs: Banners da home (1080×1919) | Banners de conteúdo (1080×1080)
  │   └── /cardapios/ajustes                   → Integrações (Google Menu stub "em breve")
  ├── /giftback ▼            → Menu collapsable Giftback
  │   ├── /giftback/regras                     → Lista de regras de emissão + dialog de criação/edição (4 gatilhos: after_rating/manual/birthday/frequency). Toggle ativa por linha
  │   ├── /giftback/vouchers                   → Tabela paginada de vouchers emitidos (código, cliente, %, gatilho, validade, status). Filtro por status + emissão manual + cancelar voucher ativo
  │   └── /giftback/ajustes                    → Canais de envio (WhatsApp on / Email "em breve") + template da mensagem com chips de variáveis e preview
  ├── /clientes              → Histórico e perfil de clientes
  ├── /conversas             → Histórico de chats WhatsApp
  ├── /configuracoes         → Informações da unidade (nome, endereço, contato) + minha conta (sem membros — moveram pra /usuarios)
  ├── /pagina-publica        → Edição da página pública: hero, logo, descrição, faixa de preço, endereço
  ├── /auditoria             → Trilha LGPD
  └── /usuarios              → 2 tabs: Gerentes (owner+gerente) | Operadores. Modal "+ Adicionar". Dropdown actions (editar nome, trocar papel, remover)

# Redirects legados:
#  /g/:unitSlug/avaliacoes  → /g/:unitSlug/relatorios/avaliacoes

# Redirects legados:
#  /g/:unitSlug/calendario  → /g/:unitSlug/reservas/calendario
#  /g/:unitSlug/mesas       → /g/:unitSlug/reservas/saloes

/o/:unitSlug                 → Painel Operacional (OperacionalLayout)
  ├── /                      → Reservas do dia (agrupadas por status)
  ├── /fila                  → Fila de espera (waitlist)
  ├── /passantes             → Walk-ins (clientes sem reserva)
  ├── /giftback              → Validar voucher: input de código → exibe cliente/%/validade/origem → "Marcar como usado" / "Cancelar voucher"
  └── /conversas             → Histórico de chats WhatsApp (mesma tela da Gestão)

/platform                    → Painel Plataforma (PlatformLayout) — só platform_admin
  ├── /empresas              → CRUD de organizations + unidades
  └── /automacao             → Seleciona unidade (cross-org)
      └── /:unitSlug         → 4 abas: Canais WhatsApp + Provedor de IA + Instruções do agente + Diagnóstico
```

> **Automação é exclusiva do super-admin (platform_admin).** Owner/gerente da unidade
> não tem mais o item no menu de Gestão; o fluxo todo (canais WhatsApp, chave de IA,
> system prompt) vive em `/platform/automacao`. As Edge Functions `manage-channels`
> e `manage-ai-providers` validam `platform_admin` no JWT — chamada direta de
> owner/gerente retorna 403.

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
│   │   ├── zapi.ts                    # Templates de mensagem WhatsApp (referência)
│   │   ├── exportCsv.ts               # exportClientesCsv(unitId, range) — gera CSV com BOM utf-8, agrupa reservations por customer_id
│   │   └── validators/
│   │       └── organization.ts        # Schemas Zod de criação/edição de organization
│   │
│   ├── hooks/
│   │   ├── useReservas.ts             # CRUD de reservas via React Query — aceita hall_id/widget_id/custom_field_values
│   │   ├── useAuth.ts                 # Autenticação + memberships + defaultUnitSlug
│   │   ├── useCurrentUnit.ts          # Lê :unitSlug da URL, retorna unit + org + role
│   │   ├── useAllUnits.ts             # Lista global de unidades (cross-org) + useUnitBySlug — só funciona pra platform_admin
│   │   ├── useUnitMembers.ts          # Lista/cria/remove membros (CRUD via manage-members) + useUpdateMemberName (atualiza name de unit_members)
│   │   ├── useCustomers.ts            # Update customer + get_customer_stats + anonymize
│   │   ├── useHalls.ts                # CRUD de salões (halls) por unidade
│   │   ├── useHallSchedules.ts        # CRUD de janelas horárias por salão (multi-janela por dia)
│   │   ├── useHallTables.ts           # CRUD de mesas com range capacity (min/max) — substitui query inline em Passantes
│   │   ├── useTableBlocks.ts          # CRUD de bloqueios macro (intervalo) + useOverbookingFlag (settings.allow_overbooking)
│   │   ├── useSpecialDates.ts         # CRUD de datas especiais com range, hall_id e override completo (escala/desconto/cobrança)
│   │   ├── useWidgets.ts              # CRUD de reservation_widgets (slug auto-gerado, field_config por widget)
│   │   ├── useCustomFields.ts         # CRUD de campos personalizados do form (texto/opções/arquivo)
│   │   ├── useAuditLog.ts             # Lista de audit_log (LGPD)
│   │   ├── useWalkIns.ts              # CRUD de walk-ins (Operacional)
│   │   ├── useWalkInStatsToday.ts     # Count de walk-ins do dia + breakdown por status (Dashboard)
│   │   ├── useWaitlist.ts             # CRUD de fila + useAnonAddToWaitlist (gera code via RPC + priority_category)
│   │   ├── useWaitlistTemplates.ts    # CRUD de waitlist_message_templates + WAITLIST_TEMPLATES (defaults) + renderWaitlistTemplate
│   │   ├── useWaitlistSettings.ts     # Wrapper das keys waitlist_* em settings (qr_enabled, code_min/max, tolerance, remote_entry...)
│   │   ├── useReservationTemplates.ts # CRUD de reservation_message_templates (reminder_d1/survey_d1) + RESERVATION_TEMPLATES (defaults sincronizados com workers) + renderReservationTemplate
│   │   ├── useMenus.ts                # CRUD de menus (cardápios) + generateMenuSlug
│   │   ├── useMenuPages.ts            # CRUD de menu_pages (galeria) + reorder via drag&drop
│   │   ├── useMenuBanners.ts          # CRUD de menu_banners (home/content) por unit
│   │   ├── useDashboardMetrics.ts     # KPIs/charts/listas do Dashboard — query única + agregações em useMemo
│   │   ├── useFluxoClientes.ts        # Agrega reservations + waitlist + walk_ins por DateRange — KPIs por tab + daily/dow/partySize charts
│   │   ├── useComunicacao.ts          # Agrega notifications_sent por DateRange — KPIs por tab (geral/reserva/fila/avaliacao) + daily + byKind + recentFailures (com phone mascarado)
│   │   ├── useAvaliacoes.ts           # Agrega reservations.satisfaction_* por DateRange — total/média/distribuição (5..1) + taxa de resposta vs. survey_d1 enviadas + rows com customer (name/phone/email)
│   │   ├── useVouchers.ts             # CRUD de voucher_rules + vouchers + issue manual + redeem + cancel + lookup por código (operacional). Gera código 8-chars com retry (alfabeto sem 0/O/1/I)
│   │   ├── useGiftbackSettings.ts     # Wrapper das keys giftback_* em settings (whatsapp_enabled, email_enabled, message_template) + renderGiftbackTemplate
│   │   ├── useGiftbackRelatorio.ts    # Agrega vouchers por DateRange — KPIs (emitidos/usados/conversão/cancelados) + daily issued/used + breakdown por gatilho + recent (top 20)
│   │   ├── useOrganizations.ts        # Plataforma — list/create/update via manage-organizations
│   │   ├── useWhatsAppChannels.ts     # CRUD de whatsapp_channels via manage-channels
│   │   ├── useWhatsAppHealth.ts       # Saúde do canal + estatísticas 24h (consome whatsapp-health) — alimenta a aba Diagnóstico
│   │   ├── useConversations.ts        # Histórico de chats WhatsApp
│   │   ├── useAwaitingHumanCount.ts   # Badge de conversas aguardando handoff humano
│   │   ├── useSendManualMessage.ts    # Envio manual de mensagem (handoff humano)
│   │   ├── useUnitPublicContent.ts    # Read/update do conteúdo da página pública (descrição, preço, address, URLs)
│   │   ├── useUnitAssetUpload.ts      # Upload de logo/hero pro bucket unit-assets (Storage)
│   │   ├── useDiscoverUnits.ts        # Landing — usePublicCities, usePublicUnits({city,search})
│   │   └── useAdminUsers.ts           # Legacy admin_users (será removido pós migration 013)
│   │
│   ├── stores/
│   │   └── reservaStore.ts            # Filtros do painel (Zustand)
│   │
│   ├── components/
│   │   ├── ui/                        # shadcn/ui — não editar diretamente
│   │   ├── reserva/
│   │   │   ├── ReservaForm.tsx        # Formulário público — props: unit, halls, widgetConfig, widgetId,
│   │   │   │                          # customFields, bookingWindowDays. Slots por hall_schedules,
│   │   │   │                          # step de salão se 2+ ativos, render de extras (widget) e custom fields.
│   │   │   │                          # Captura "Aniversário (opcional)" sempre visível no /r/:slug; widget que
│   │   │   │                          # tenha data_nascimento habilitado tem prioridade. Valor vai pra
│   │   │   │                          # customers.birthday (não em notes) — alimenta giftback de aniversário.
│   │   │   └── ReservaCard.tsx        # Card de reserva com ações de status
│   │   ├── waitlist/
│   │   │   └── WaitlistFormPublic.tsx # Form anônimo para "Entrar na Fila" no portal público — gera code (RPC),
│   │   │                              # mostra select de prioritários (controlado por waitlist_priority_enabled),
│   │   │                              # exibe senha #N na confirmação. Aceita ?action=waitlist via PublicPortal pra auto-abrir
│   │   ├── menus/
│   │   │   ├── MenuPagesEditor.tsx    # Galeria de imagens com upload múltiplo + reorder drag&drop nativo + delete
│   │   │   ├── MenuBannerEditor.tsx   # Card de banner editável (image, link, ativo) com aspect 9/16 ou 1/1
│   │   │   └── ThemeEditor.tsx        # 5 color pickers (font/bg primary/secondary + accent) + reset por cor + reset all
│   │   ├── share/
│   │   │   ├── DownloadCard.tsx       # QR Code + download PNG via lib qrcode (reutilizado por Fila/Ajustes e Cardápios)
│   │   │   └── ShareCard.tsx          # Link público + copy button com feedback (reutilizado por WidgetDetail e Cardápios)
│   │   ├── relatorios/
│   │   │   ├── DateRangePicker.tsx    # Popover com presets (Últimos 7/15/30/60/90 dias) + Calendar mode="range"
│   │   │   ├── FluxoLineChart.tsx     # Line chart de mesas por dia, cor varia por tab (geral/reserva/fila/passante)
│   │   │   ├── PartySizeChart.tsx     # Bar chart horizontal por bucket de party_size (stacked em Visão geral)
│   │   │   ├── DowChart.tsx           # Bar chart vertical por dia da semana (Seg-Dom) com toggle Mesas/Pessoas
│   │   │   ├── ComunicacaoLineChart.tsx  # Line chart envios por dia — séries WhatsApp (verde) + Email (azul)
│   │   │   ├── ComunicacaoKindBar.tsx    # Bar chart por kind, stacked sent (verde) / failed (red) / skipped (cinza)
│   │   │   └── avaliacoes/
│   │   │       ├── ResponseRateCard.tsx     # KPI verde — total respostas + barra de % vs. survey_d1 enviadas
│   │   │       ├── LockedQuestionCard.tsx   # Card disabled "em breve" reutilizável (perguntas de escala / escolha única)
│   │   │       └── RespostasTable.tsx       # Tabela paginada com filtro por nota + tooltip do comentário + botão Export CSV
│   │   ├── giftback/
│   │   │   ├── VoucherStatusBadge.tsx       # Badge colorido por status (active verde / used azul / expired cinza / cancelled rosa)
│   │   │   ├── VoucherRuleDialog.tsx        # Modal de criação/edição de regra — campos condicionais por trigger_type
│   │   │   └── IssueVoucherDialog.tsx       # Modal de emissão manual: search de cliente (nome/phone) + % desconto + validade + nota interna
│   │   ├── halls/                     # Componentes do redesign de Salões
│   │   │   ├── HallCard.tsx           #   Card do salão na lista (gráfico semanal D-S)
│   │   │   ├── HallScheduleGrid.tsx   #   Tabela "Grade horária" com tabs por dia
│   │   │   ├── HallScheduleSheet.tsx  #   Modal "Adicionar novo horário" (escala/antecedência/desconto/cobrança)
│   │   │   └── TablesRangeInput.tsx   #   Input "X mesas de Y a Z lugares" (range capacity)
│   │   ├── widgets/
│   │   │   └── WidgetFieldEditor.tsx  # Collapsable de campos do widget (Habilitado/Opcional/Título customizado)
│   │   ├── dashboard/                 # Componentes do Dashboard analítico (Bloco A-F)
│   │   │   ├── KpiCard.tsx            #   Card de KPI com seta de delta (% ou abs) + sufixo
│   │   │   ├── ChartCard.tsx          #   Wrapper Card com altura fixa + estados loading/empty
│   │   │   ├── PeriodFilter.tsx       #   Tabs Hoje/7d/30d/90d controlado
│   │   │   ├── ReservationsByDayChart.tsx  # LineChart confirmadas vs cancel./no-show (Recharts)
│   │   │   ├── OccupancyByHourChart.tsx    # BarChart 8h-23h, reservas confirmadas
│   │   │   ├── RatingsSummary.tsx     #   Card média + distribuição 1-5 (reusado em Avaliacoes)
│   │   │   ├── RatingDistributionBars.tsx  # Barras horizontais 5..1 estrelas
│   │   │   ├── StarRating.tsx         #   Renderiza N estrelas (sm/md)
│   │   │   ├── RecentRatingsList.tsx  #   Lista compacta últimas avaliações
│   │   │   └── EmptyChartCard.tsx     #   Estado vazio padrão pra charts/listas
│   │   ├── layouts/
│   │   │   ├── GestaoLayout.tsx       # Sidebar + layout das páginas de gestão
│   │   │   ├── OperacionalLayout.tsx  # Header minimalista + navegação operacional
│   │   │   └── PlatformLayout.tsx     # Sidebar do painel /platform (só super-admin)
│   │   └── UnitSwitcher.tsx           # Dropdown de troca de unidade no header
│   │
│   └── pages/
│       ├── Index.tsx                  # Landing pública — seletor de cidade, busca, grid de restaurantes
│       ├── PublicPortal.tsx           # Portal público do restaurante — hero/sobre/preço/mapa/CTAs.
│       │                              # Lê unit_settings (regras, info adicional, booking_window_days) + halls + custom_fields.
│       │                              # Query params: ?mode=embed (versão limpa) + ?action=reservar|waitlist (auto-open)
│       ├── WidgetPortal.tsx           # /w/:slug — widget com field_config/client_instructions customizados por widget
│       ├── Auth.tsx                   # Login
│       ├── gestao/
│       │   ├── Dashboard.tsx          # KPIs analíticos com filtro de período (Hoje/7d/30d/90d) — operação de hoje + 6 KPIs c/ delta + 2 charts (reservas por dia, ocupação por horário) + avaliações + fila/walk-ins live. Charts via lazy-load.
│       │   ├── Reservas.tsx           # Lista com filtros amplos
│       │   ├── Calendario.tsx         # Visão calendário mensal
│       │   ├── Clientes.tsx           # Histórico de clientes (escopado por organização)
│       │   ├── Conversas.tsx          # Histórico de chats WhatsApp
│       │   ├── Configuracoes.tsx      # Conta, membros, info da unidade (sem horários/datas especiais)
│       │   ├── Automacao.tsx          # WhatsApp channels + Provedor de IA + System prompt — agora montada em /platform/automacao/:unitSlug
│       │   ├── Avaliacoes.tsx         # Relatório de avaliações — 2 tabs (Visão geral / Respostas), DateRangePicker, export CSV. Reusa RatingsSummary; tabela com filtro por nota + tooltip do comentário
│       │   ├── PaginaPublica.tsx      # Editor de conteúdo público — upload logo/hero, descrição, preço, endereço
│       │   ├── Auditoria.tsx          # Trilha LGPD
│       │   ├── Usuarios.tsx           # Gerencia membros da unit — 2 tabs (Gerentes/Operadores) + modal Adicionar + DropdownMenu (editar nome/trocar papel/remover). Substitui o bloco antigo em Configuracoes.tsx
│       │   ├── reservas/              # Módulo de Reservas (sub-abas)
│       │   │   ├── Saloes.tsx                # Lista de salões + sidebar "Turnos da Reserva"
│       │   │   ├── SalaoDetalhe.tsx          # Grade horária, mesas, mapa stub, toggle "cadeira vazia"
│       │   │   ├── DatasEspeciais.tsx        # Range de datas + hall_id + override completo (escala/desconto/cobrança)
│       │   │   ├── Bloqueios.tsx             # Modelo macro + sidebar "Permitir overbooking"
│       │   │   ├── Widget.tsx                # Lista de widgets + sidebar "Banner de cardápio" (stub)
│       │   │   ├── WidgetDetail.tsx          # 3 tabs: Compartilhamento (URL+Copiar) / Personalização / Integrações (stub)
│       │   │   ├── Formulario.tsx            # Custom fields personalizados (3 tipos: texto/opções/arquivo)
│       │   │   ├── Comunicacao.tsx           # Customização dos templates de lembrete D-1 e pesquisa D+1 (mesma UX do módulo Fila/Comunicação) com chips de variáveis e preview ao vivo
│       │   │   └── Ajustes.tsx               # 2 tabs: Informações gerais (janela/duração/tolerância/regras + toggles reminder_d1_enabled e survey_d1_enabled) + Pagamentos (stub)
│       │   ├── fila/                  # Módulo de Fila de espera (sub-abas)
│       │   │   ├── Comunicacao.tsx           # 2 tabs: Customização de mensagens (templates WhatsApp por evento) + Configurações (stub)
│       │   │   └── Ajustes.tsx               # QR Code controls + Configurações gerais (code min/max + tolerância) + Entrada remota + sidebar download QR
│       │   ├── cardapios/             # Módulo de Cardápios (galeria de imagens)
│       │   │   ├── MeusCardapios.tsx         # Lista + modal Adicionar (cover + nome) + sidebar Compartilhar+QR do selecionado
│       │   │   ├── MenuDetail.tsx            # 3 tabs: Compartilhamento (link+detalhes), Galeria (MenuPagesEditor), Personalização (ThemeEditor)
│       │   │   ├── Banners.tsx               # 2 tabs: home (story 9:16) | content (1:1). Adiciona via upload imediato em menu_banners
│       │   │   └── Ajustes.tsx               # Tab única "Integrações" — Google Menu stub disabled "em breve"
│       │   ├── giftback/              # Módulo de Giftback (sub-abas)
│       │   │   ├── Regras.tsx                # Lista de voucher_rules + dialog criação/edição + toggle ativa + remover
│       │   │   ├── Vouchers.tsx               # Tabela paginada de vouchers emitidos com filtro por status + emissão manual + cancelar voucher
│       │   │   └── Ajustes.tsx                # Canais (WhatsApp/Email) + template da mensagem com chips de variáveis e preview
│       │   └── relatorios/            # Módulo de Relatórios (sub-abas)
│       │       ├── FluxoClientes.tsx         # 4 tabs internas (Visão geral / Reserva / Fila / Passante) com KPIs específicos + 3 charts + DateRangePicker + Export CSV. Cores por tab (azul/verde/laranja/cinza)
│       │       ├── Vendas.tsx                # Stub "em breve" (depende de pagamentos integrados)
│       │       ├── Comunicacao.tsx           # 6 tabs (Visão geral/Reserva/Fila/Marketing(em breve)/Avaliação/Giftback(em breve)) consumindo useComunicacao. KPIs WhatsApp+Email+taxa entrega+falhas, charts diário multi-série e barras por kind (stacked sent/failed/skipped), tabela de últimas falhas na Visão geral
│       │       └── Giftback.tsx              # KPIs + LineChart emissões vs. usos + BarChart por gatilho (cores semânticas) + tabela últimos vouchers. Reusa KpiCard, VoucherStatusBadge, BreadcrumbRelatorios, DateRangePicker
│       ├── operacional/
│       │   ├── ReservasDia.tsx        # Reservas do dia agrupadas por status
│       │   ├── Fila.tsx               # Fila de espera com timers, exibe code #N + badge categoria prioridade, notificação WhatsApp via template
│       │   ├── Passantes.tsx          # Walk-ins — registro, alocação de mesa, status
│       │   ├── Giftback.tsx           # Validação de voucher por código — busca + card visual com %/cliente/validade + ações (marcar usado / cancelar)
│       │   └── Conversas.tsx          # Re-export de gestao/Conversas.tsx (handoff humano no piso)
│       └── platform/
│           ├── Empresas.tsx           # CRUD de organizations + unidades (super-admin)
│           └── Automacao.tsx          # Seletor de unidade cross-org → /platform/automacao/:unitSlug
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
│   │   ├── 014_operacional.sql            # walk_ins, waitlist + RLS
│   │   ├── 015_whatsapp_handoff_and_scope.sql  # status human_active/awaiting_human + agent_mode
│   │   ├── 016_reservation_duration_default.sql  # duração padrão de reserva
│   │   ├── 017_email_notifications.sql    # kinds *_email em notifications_sent
│   │   ├── 018_ai_provider_credentials.sql # BYOK: chaves de IA por unidade (RLS + FORCE)
│   │   ├── 019_public_page_content.sql    # colunas de conteúdo público em units + bucket unit-assets + anon waitlist
│   │   ├── 020_cancellation_notification.sql   # adiciona 'cancellation' ao CHECK de notifications_sent.kind
│   │   ├── 021_confirmation_email_kind.sql     # adiciona 'confirmation_email' ao CHECK de notifications_sent.kind
│   │   ├── 022_reservation_source.sql          # coluna reservations.source ('web'|'whatsapp') + trigger condicional
│   │   ├── 023a_public_rpcs_and_rate_limit.sql # RPCs públicas (get_unit_public_full, get_public_business_hours) + check_rate_limit/4 NOT NULL
│   │   ├── 023b_lock_anon_policies.sql         # dropa policies anon abertas (tables/business_hours/settings/special_dates) + FORCE RLS em whatsapp_channels + rate_limit_events.unit_id NOT NULL
│   │   ├── 024_drop_unit_assets_listing.sql    # remove SELECT policy do bucket unit-assets (CDN público continua, listing bloqueado)
│   │   ├── 025_processed_messages_outcome.sql  # Idempotência segura: started_at/completed_at/outcome/error em processed_messages
│   │   ├── 026_webhook_executions.sql          # Tabela de telemetria de cada execução do webhook-whatsapp
│   │   ├── 027_handoff_ux.sql                  # last_silenced_reply_at em conversations (auto-resolve + throttle do lembrete)
│   │   ├── 028_notification_outbox.sql         # Outbox de confirmação + trigger novo (substitui 022 http_request direto)
│   │   ├── 029_outbox_cron.sql                 # pg_cron + trigger_outbox_processor() lendo INTERNAL_API_KEY do Vault
│   │   ├── 030_halls_and_schedules.sql         # halls, hall_schedules, range capacity em tables (min/max), 1 "Salão Principal" por unit + RPC get_public_hall_schedules
│   │   ├── 031_special_dates_overrides.sql     # special_dates ganha end_date (range), hall_id, slot_minutes, min_advance, discount, charge
│   │   ├── 032_table_blocks_macro.sql          # table_blocks: unit_id direto, hall_id, title, table_id nullable (modelo macro)
│   │   ├── 033_reservation_widgets.sql         # reservation_widgets (slug, field_config) + RPC get_widget_public
│   │   ├── 034_unit_custom_fields.sql          # unit_custom_fields (texto/opções/arquivo) + reservations.custom_field_values JSONB
│   │   ├── 035_unit_settings_in_rpcs.sql       # RPCs públicas retornam unit_settings (booking_window_days, regras, info)
│   │   ├── 036_waitlist_module.sql             # waitlist_message_templates + waitlist.code/priority_category + RPC next_waitlist_code (cíclica)
│   │   ├── 037_public_rpcs_waitlist.sql        # estende RPCs públicas com waitlist_priority_enabled / remote_entry_* / qr_enabled / menu_link_enabled
│   │   ├── 038_menus_module.sql                # menus + menu_pages + menu_banners + RPC get_menu_public (galeria de imagens com tema)
│   │   ├── 039_unit_members_profile.sql        # adiciona email + name em unit_members (denormalizado) + backfill via auth.users
│   │   ├── 040_notifications_waitlist_kinds.sql # estende kind enum com waitlist_entered/table_ready/feedback + relaxa reservation_id NULLABLE
│   │   ├── 041_satisfaction_comment.sql        # adiciona reservations.satisfaction_comment (text NULL) — capturado pelo webhook após nota D+1 (janela 30min)
│   │   ├── 042_giftback_module.sql             # voucher_rules + vouchers (RLS membro), customers.birthday, kind 'voucher_issued', função expire_vouchers()
│   │   ├── 043_giftback_cron.sql               # pg_cron diário 12:00 UTC + trigger_voucher_processor() lendo INTERNAL_API_KEY do Vault
│   │   ├── 044_reservation_message_templates.sql # reservation_message_templates (event=reminder_d1/survey_d1) + estende RPCs get_reservations_for_reminder/survey com p_unit_id e retorno unit_id (retrocompatível)
│   │   └── 045_reservation_automation_cron.sql # 2 jobs pg_cron (10:00 BRT reminder, 14:00 BRT survey) + trigger_reminder_processor()/trigger_survey_processor() lendo INTERNAL_API_KEY do Vault — substitui workflows N8N (DEPRECATED)
│   │
│   └── functions/
│       ├── _shared/
│       │   ├── ai-providers.ts            # Abstração multi-provedor (runAgentLoop)
│       │   ├── cors.ts                    # corsHeadersFor — whitelist de Origin (localhost, *.vercel.app, reservas.moralles.com.br) pra manage-*
│       │   ├── email.ts                   # Wrapper Resend (fetch, timeout 15s, log estruturado)
│       │   ├── whatsapp-providers.ts      # Abstração WhatsApp: parseInbound / sendOutbound por provider. Exporta SendResult (estruturado, em vez de boolean) e validateMetaSignature (HMAC-SHA256 do body cru com app_secret)
│       │   ├── whatsapp-send.ts           # Helper sendWhatsApp — retorna SendResult ({ ok, status, error, bodySnippet, missingCreds }); exige pareamento channel_id+unit_id; sem fallback se mismatch
│       │   ├── retry.ts                   # fetchWithRetry com exponential backoff
│       │   └── security.ts                # requireInternalAuth / sanitizePhone / jsonLog
│       ├── webhook-whatsapp/
│       │   └── index.ts                   # Webhook unificado — resolve canal por ?channel=<id>. UX handoff (auto-resolve 12h + lembrete 6h), idempotência segura com outcome, gravação em webhook_executions, HMAC SHA-256 para provider 'official', fallback de resposta vazia, remap role:'human' → 'assistant' antes do agente. Survey: comment intercept (texto livre na janela 30min após nota → satisfaction_comment) precede o rating intercept (regex 1-5 → satisfaction_rating, mensagem combina agradecimento + voucher se houver rule after_rating ativa + convite a comentar). Giftback: maybeIssueGiftbackVoucher() respeita settings (whatsapp_enabled, template), busca voucher_rules.trigger_type='after_rating' com min_rating ≤ rating, gera código 8-chars unique, registra em notifications_sent kind='voucher_issued'
│       ├── webhook-zapi/
│       │   └── index.ts                   # 410 Gone — endpoint legacy global, substituído pelo path multi-tenant em webhook-whatsapp
│       ├── send-whatsapp/
│       │   └── index.ts                   # Aceita channel_id+unit_id; exige pareamento. Auth: x-internal-key OU JWT de membro da unit (autorização dual). Aceita kind opcional (waitlist_*, voucher_issued) — quando presente, grava em notifications_sent com status sent/failed e error message. Propaga SendResult no body
│       ├── send-confirmation/
│       │   └── index.ts                   # WhatsApp + e-mail (Resend) em paralelo; valida unit_id da reserva quando record.unit_id presente
│       ├── send-cancellation/
│       │   └── index.ts                   # Notifica cliente via WhatsApp ao cancelar reserva. Usa _shared/whatsapp-send (sem cópia local de helpers)
│       ├── create-reservation/
│       │   └── index.ts                   # Endpoint público (verify_jwt=false) para criar reserva via portal/widget. Usa _shared/availability.reserveSlot. Upsert de customer org-scoped + fill-if-null em customers.birthday quando body.customer.birthday presente (nunca sobrescreve). Rate limit por (phone, unit) via check_rate_limit. Valida ownership unit↔organization
│       ├── manage-channels/
│       │   └── index.ts                   # CRUD de whatsapp_channels — exige platform_admin (super-admin)
│       ├── manage-ai-providers/
│       │   └── index.ts                   # CRUD de chaves de IA por unidade (BYOK) — exige platform_admin; nunca devolve api_key cru
│       ├── manage-members/
│       │   └── index.ts                   # CRUD de unit_members — escopo por unidade. Actions: create_member (owner-only, popula email+name), update_role (owner-only), update_member (owner ou self → name), delete_member (owner-only)
│       ├── manage-organizations/
│       │   └── index.ts                   # list/create/update organization+unit+owner (platform_admin)
│       ├── send-manual-message/
│       │   └── index.ts                   # Envio manual de mensagem WhatsApp (handoff humano). Usa _shared/whatsapp-send
│       ├── whatsapp-health/
│       │   └── index.ts                   # Diagnóstico (canal + IA + stats 24h + últimas execuções) — consumido pela aba Diagnóstico em /platform/automacao
│       ├── process-notification-outbox/
│       │   └── index.ts                   # Worker do outbox de confirmação — chamado pelo pg_cron a cada 1 min
│       ├── process-voucher-triggers/
│       │   └── index.ts                   # Worker dos gatilhos de Giftback — chamado pelo pg_cron diário (12:00 UTC). Expira vouchers vencidos, emite por aniversário (mes/dia matching) e por frequência (visits_required em days_window). Idempotente em ambos os casos. Envia WhatsApp via send-whatsapp com kind='voucher_issued'
│       ├── process-reservation-reminders/
│       │   └── index.ts                   # Worker do lembrete D-1 — pg_cron diário 13:00 UTC = 10:00 BRT. Itera units, lê settings.reminder_d1_enabled (default true), carrega template de reservation_message_templates ou DEFAULT_REMINDER_BODY, chama RPC get_reservations_for_reminder(amanhã, unit_id) e dispara send-whatsapp com kind='reminder_d1' + reservation_id. Idempotência via UNIQUE (reservation_id, kind) em notifications_sent
│       └── process-satisfaction-surveys/
│           └── index.ts                   # Worker da pesquisa D+1 — pg_cron diário 17:00 UTC = 14:00 BRT. Mesmo padrão do reminder, com target_date=ontem, RPC get_reservations_for_survey, kind='survey_d1'. Resposta 1-5 e comentário em texto livre são interceptados pelo webhook-whatsapp (não passam por aqui)
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
| `units` | Restaurante físico — `organization_id`, `name`, `slug` unique, `address` (jsonb com street/number/neighborhood/city/state/cep/full), `timezone`, `description`, `price_range_min/max`, `hero_image_url`, `logo_url` |
| `unit_members` | Membros com papel por unidade — `user_id`, `unit_id`, `role`, `email` (denorm), `name` (opcional). `email` é populado por `manage-members` no create; backfill via `auth.users` na migration 039. Pode ficar desync se usuário trocar e-mail via Auth — fora de escopo |
| `platform_admins` | Admins internos do SaaS (suporte) |
| `customers` | Clientes — `name`, `phone` unique por `organization_id`, `email` |
| `reservations` | Reservas — `unit_id`, `customer_id`, `table_id`, `date`, `time`, `party_size`, `status`, `reservation_code`, `source` (`'web'\|'whatsapp'`), `custom_field_values` JSONB (respostas de `unit_custom_fields`), `satisfaction_rating` (1-5 nullable), `satisfaction_at` (timestamptz), `satisfaction_comment` (text nullable, capturado D+1 pelo webhook) |
| `tables` | Mesas — `unit_id`, `hall_id`, `number` unique por unidade, `min_capacity`/`max_capacity` (range, mesa fixa = min=max), `capacity` (legacy, sincronizado com max via trigger), `location`, `active` |
| `halls` | Salões por unidade — `unit_id`, `name` (unique por unit), `description`, `active`, `allow_empty_seat` (aceita 1 cadeira vazia), `sort_order` |
| `hall_schedules` | Janelas horárias por salão — `hall_id`, `day_of_week`, `open_time`, `close_time`, `slot_minutes` (5-60), `min_advance_minutes`, `discount_percent`, `charge_enabled`, `charge_amount_cents`. Múltiplas janelas por dia (almoço/jantar) |
| `conversations` | Histórico de chats WhatsApp — `unit_id`, `messages` JSONB, `status` (ai_active/awaiting_human/human_active), `handoff_reason`, `handoff_at`, `last_silenced_reply_at` (throttle do lembrete enquanto silenciada) |
| `business_hours` | **DEPRECATED** (transicional). Mantido como fallback do `availability.ts` quando unit ainda não tem `halls`. Drop futuro em 036+ |
| `settings` | Configurações chave-valor — `unit_id`, `key`, `value`. Keys: `reservation_duration_minutes`, `booking_window_days`, `reservation_tolerance_minutes`, `rules_and_conditions`, `additional_info`, `allow_overbooking` |
| `table_blocks` | Bloqueios — `unit_id` (NOT NULL), `hall_id` opcional, `table_id` nullable (modelo macro), `title`, `blocked_from`/`blocked_to`, `reason` (legacy). table_id IS NULL = bloqueio macro do hall/unit |
| `special_dates` | Datas especiais — `unit_id`, `hall_id` opcional, `date`/`end_date` (range), `name`, `is_closed`, override (`open_time`/`close_time`/`slot_minutes`/`min_advance_minutes`/`discount_percent`/`charge_enabled`/`charge_amount_cents`) |
| `reservation_widgets` | Widgets de reserva — `unit_id`, `slug` unique global (8 chars), `name`, `field_config` JSONB (toggles por campo), `client_instructions`, `show_menu_banner`, `active` |
| `unit_custom_fields` | Campos personalizados do form — `unit_id`, `label`, `type` (`text`/`options`/`file`), `options` JSONB, `required`, `sort_order`, `active`. Respostas em `reservations.custom_field_values` |
| `audit_log` | Trilha LGPD — `unit_id`, `table_name`, `operation`, `old_values`, `new_values`, `actor_id` |
| `notifications_sent` | Log/idempotência outbound — `unit_id`, `reservation_id` (nullable a partir de mig 040), `kind` (`confirmation`/`confirmation_email`/`reminder_d1`/`survey_d1`/`cancellation`/`waitlist_entered`/`waitlist_table_ready`/`waitlist_feedback`/`voucher_issued`), `status` (`sent`/`failed`/`skipped`), `error`, `sent_at`. Alimenta Relatórios → Comunicação |
| `processed_messages` | Idempotência de mensagens inbound do WhatsApp — `message_id` (PK), `unit_id`, `started_at`/`completed_at` + `outcome`/`error`. Mensagem fica "presa" se `started_at` antigo + `completed_at NULL` → retransmissão pode reprocessar após 90s. RLS + FORCE: só `service_role` |
| `whatsapp_channels` | Canais WhatsApp por unidade — `unit_id`, `provider` (zapi/waha/official), `credentials` JSONB, `webhook_secret`, `status`, `display_phone`. RLS + FORCE: leitura só pelo `service_role` (UI consome via `manage-channels` action `list`) |
| `ai_provider_credentials` | Chaves de API de IA por unidade (BYOK) — `unit_id`, `provider` (claude/openai/gemini/grok/deepseek), `api_key`, `last4`, `active`. RLS + FORCE: leitura só pelo `service_role` |
| `webhook_executions` | Telemetria de cada execução do webhook-whatsapp — `request_id`, `unit_id`, `channel_id`, `phone_hash`, `outcome`, `error`, `duration_ms`, `meta`. RLS + FORCE: só `service_role`. Alimenta a aba Diagnóstico. TTL 30 dias via `cleanup_webhook_executions()` |
| `notification_outbox` | Fila de confirmações com retry exponencial — `reservation_id`, `unit_id`, `kind`, `attempts`, `next_attempt_at`, `status` (pending/processing/done/dead), `last_error`. RLS + FORCE: só `service_role`. Backoff: 1m→5m→15m→1h→4h, vira `dead` após 5 tentativas |
| `walk_ins` | Clientes sem reserva no dia — `unit_id`, `customer_name`, `party_size`, `table_id?`, `status` (waiting/seated/left/no_show) |
| `waitlist` | Fila de espera — `unit_id`, `customer_name`, `party_size`, `priority` (legacy int derivado por trigger), `priority_category` (`normal`/`senior`/`pregnant`/`disabled`/`other`), `code` (senha cíclica via RPC `next_waitlist_code`), `status` (waiting/notified/seated/cancelled). Unique parcial em `(unit_id, code)` p/ ativos |
| `waitlist_message_templates` | Templates WhatsApp por unit×event — `event` (`entered`/`table_ready`/`feedback`), `customized` boolean, `body` text. Unique `(unit_id, event)`. RLS membro da unit. Variáveis: `{{cliente_nome}}`, `{{unidade_nome}}`, `{{party_size}}`, `{{codigo_fila}}`, `{{link_status}}` |
| `reservation_message_templates` | Templates WhatsApp de **reserva** por unit×event — `event` (`reminder_d1`/`survey_d1`), `customized` boolean, `body` text. Unique `(unit_id, event)`. RLS membro da unit. Lido pelos workers `process-reservation-reminders` e `process-satisfaction-surveys`. Variáveis: `{{cliente_nome}}`, `{{horario}}`, `{{party_size}}`, `{{codigo}}`, `{{unidade_nome}}` (survey usa só nome/codigo/unidade) |
| `menus` | Cardápios digitais (galeria) — `unit_id`, `slug` unique global (8 chars), `name`, `cover_image_url`, `theme` JSONB (5 cores), `active`, `sort_order`. RLS membro da unit; leitura anon só via RPC `get_menu_public` |
| `menu_pages` | Imagens ordenadas do cardápio — `menu_id`, `image_url`, `sort_order`. RLS escopo via menu pai. Reorder via bulk update |
| `menu_banners` | Banners da unit — `unit_id`, `type` (`home` 9:16 / `content` 1:1), `image_url`, `link_url?`, `active`, `sort_order`. Compartilhados entre cardápios da mesma unit |
| `voucher_rules` | Regras de Giftback por unit — `unit_id`, `name`, `trigger_type` (`after_rating`/`manual`/`birthday`/`frequency`), `discount_percent` (1-100), `validity_days`, `active`. Configs por trigger: `min_rating` (after_rating), `visits_required`+`days_window` (frequency). RLS membro |
| `vouchers` | Instâncias emitidas — `unit_id`, `rule_id` (nullable, manual avulso pode ser null), `customer_id`, `code` (8 chars, unique parcial WHERE active), `discount_percent`, `status` (`active`/`used`/`expired`/`cancelled`), `issued_at`, `expires_at`, `used_at`, `used_by_user_id`, `reservation_id` (nullable). RLS membro |
| `customers` (campo novo) | `birthday` (date nullable) — usado pelo trigger `birthday` do giftback. Capturado pelo portal `/r/:slug` (campo opcional) e widgets com `data_nascimento` habilitado; também editável em /g/:slug/clientes via modal de detalhes. Edge Function `create-reservation` faz "fill-if-null" — nunca sobrescreve data já cadastrada |

### Modelo de reservas (redesign 2026, migrations 030–035)

A disponibilidade é resolvida em [supabase/functions/_shared/availability.ts](supabase/functions/_shared/availability.ts) — fonte única de verdade compartilhada por `webhook-whatsapp` (agente IA) e `create-reservation` (portal/widget). Ordem de avaliação:

1. **Janela de reserva** (`settings.booking_window_days`) — rejeita se `date > today + N dias`
2. **`special_dates`** — pode haver várias por dia (uma global + uma por hall). Override fechado bloqueia; override aberto substitui janela do hall_schedule
3. **Halls ativos** — itera halls da unit (ou só o `hall_id` informado). Para cada hall: aplica special_date específico do hall > global, depois `hall_schedules` do dia da semana
4. **Antecedência mínima** — da janela específica que cobre o horário pedido
5. **Mesas compatíveis** — filtra por `hall_id` + `min_capacity ≤ partySize ≤ max_capacity`. `halls.allow_empty_seat=true` aceita também `partySize >= min_capacity - 1`
6. **`table_blocks`** — `table_id IS NULL` = bloqueio macro (fecha hall/unit). Bloqueio com `table_id` específico apenas remove aquela mesa
7. **Conflitos** — outras reservas no hall + floating (sem table_id) na unit. First-fit aloca menor mesa disponível
8. **Overbooking** (`settings.allow_overbooking=true`) — quando `no_capacity` pelo último passo, cria reserva floating (`table_id: null`) em vez de rejeitar. NÃO atravessa fechado/bloqueio macro nem party_size > maior mesa

**ReservaForm** ([src/components/reserva/ReservaForm.tsx](src/components/reserva/ReservaForm.tsx)) consome `get_unit_public_full(slug)` ou `get_widget_public(slug)` (mesmo shape) e renderiza:
- Step de seleção de salão se 2+ halls ativos
- Slots gerados por janela de hall_schedule (respeitando `slot_minutes` por janela)
- Campos extras do widget (`field_config`) e custom fields da unit (`unit_custom_fields`)
- Custom fields gravados em `reservations.custom_field_values` JSONB

**Páginas removidas/migradas:**
- `src/pages/gestao/Mesas.tsx` foi removida — conteúdo migrou para `Saloes.tsx` (mesas dentro do hall) + `Bloqueios.tsx` (bloqueios macro)
- Bloco "Horários de funcionamento" e "Datas especiais" saíram de `Configuracoes.tsx` — viraram `hall_schedules` e `DatasEspeciais.tsx`

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

- Anon: pode **inserir** customers (org pública), reservations e waitlist (unit pública); pode ler `organizations`/`units` públicas. **Não pode ler** `tables`/`business_hours`/`settings`/`special_dates`/`halls`/`hall_schedules`/`reservation_widgets`/`unit_custom_fields` direto — precisa passar pelas RPCs `SECURITY DEFINER` `get_unit_public_full(slug)`, `get_widget_public(slug)`, `get_public_business_hours(unit_id)`, `get_public_hall_schedules(hall_id, date)`. **Não pode ler** `whatsapp_channels` (FORCE RLS).
- Authenticated: acesso escopado por `is_unit_member(auth.uid(), unit_id)` — nunca vê dados de outra unidade. `whatsapp_channels` e `ai_provider_credentials` têm FORCE RLS sem policies — Edge Functions consomem via `service_role`.
- Owner/gerente: pode `UPDATE` em `units` (conteúdo da página pública) e gravar no bucket `unit-assets` (path `<unit_id>/...`)
- Edge Functions usam `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS)

### Storage

- Bucket público `unit-assets` — logos e hero images por unidade
- Path convention: `<unit_id>/logo-<timestamp>.<ext>`, `<unit_id>/hero-<timestamp>.<ext>`
- Read **público via CDN URL** (`/storage/v1/object/public/unit-assets/<path>`); listing (`/list/`) bloqueado pra anon
- Write apenas owner/gerente da unidade dona do path

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

O provedor ativo e o system prompt são configurados por unidade em **Plataforma → Automação → \<unidade\> → Provedor de IA** (exclusivo do super-admin). A própria chave da API também — fluxo BYOK (Bring Your Own Key): a chave é salva em `ai_provider_credentials` via Edge Function `manage-ai-providers`, que valida `platform_admin` no JWT. Quando ausente, o `webhook-whatsapp` cai no secret global `Deno.env.get(<ENV_VAR>)` como fallback. A chave nunca é devolvida ao frontend (só `last4` + `updated_at`).

### Provedores WhatsApp suportados

| Provider | Configuração | Webhook URL |
|---|---|---|
| Z-API | `instance_id`, `token`, `client_token` | `.../webhook-whatsapp?channel=<id>` |
| WAHA | `base_url`, `api_key`, `session_name` | `.../webhook-whatsapp?channel=<id>` |
| Meta Cloud API | `phone_number_id`, `access_token`, `app_secret` | `.../webhook-whatsapp?channel=<id>` |

Canais são configurados por unidade em **Plataforma → Automação → \<unidade\> → Canais WhatsApp** (exclusivo do super-admin via Edge Function `manage-channels` com check `platform_admin`). Cada canal tem um `webhook_secret` individual; o secret global `ZAPI_WEBHOOK_SECRET` foi descontinuado junto com o `webhook-zapi` (hoje 410 Gone). A UI de gestão consome a lista via action `list` em `manage-channels` — leitura direta da tabela `whatsapp_channels` está bloqueada (FORCE RLS).

### Tools do agente

| Tool | O que faz |
|---|---|
| `check_availability` | Verifica mesas disponíveis para data/hora/pessoas. Aceita `hall_name` opcional |
| `create_reservation` | Cria reserva e atualiza/cria o customer pelo telefone. Aceita `hall_name` opcional — se unit tem 2+ halls ativos e cliente não especificou, agente pergunta antes |
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
- Card mostra senha `#N` (de `waitlist.code`, gerada via RPC `next_waitlist_code` cíclica) e badge da categoria de prioridade quando aplicável
- Ações: Notificar via WhatsApp, Sentar, Confirmar entrada (após notificado), Remover
- "Notificar" usa o template `table_ready` configurado em **Gestão → Fila de espera → Comunicação** quando `customized=true`; caso contrário, fallback para o `defaultBody` em [src/hooks/useWaitlistTemplates.ts](src/hooks/useWaitlistTemplates.ts)
- Timer colorido: verde <15min, âmbar 15–30min, vermelho ≥30min

### Módulo Cardápios (`/g/:unitSlug/cardapios/*`) — gestão

Cardápio digital simples baseado em **galeria de imagens** (cardápio fotografado/desenhado, página por página). Sem categorias/itens estruturados — fase futura. Escolhas de escopo: só PT (sem i18n), tema por cardápio, banners por unit.

- **Meus Cardápios** ([src/pages/gestao/cardapios/MeusCardapios.tsx](src/pages/gestao/cardapios/MeusCardapios.tsx)) — lista + modal "Adicionar Cardápio" (cover + nome) + sidebar com `<ShareCard>` e `<DownloadCard>` do cardápio selecionado (dropdown trocar quando 2+).
- **Detalhe** ([src/pages/gestao/cardapios/MenuDetail.tsx](src/pages/gestao/cardapios/MenuDetail.tsx)) — 3 tabs:
  - **Compartilhamento**: `<ShareCard>` com URL `/m/<slug>` + edição de cover/nome/active.
  - **Galeria**: `<MenuPagesEditor>` com upload múltiplo (8MB/img), reorder drag&drop nativo, delete.
  - **Personalização**: `<ThemeEditor>` com 5 color pickers (font primary/secondary, bg primary/secondary, accent) + reset por cor + reset all.
- **Banners** ([src/pages/gestao/cardapios/Banners.tsx](src/pages/gestao/cardapios/Banners.tsx)) — 2 tabs (home 9:16 / content 1:1), upload imediato cria banner inativo; cada card é um `<MenuBannerEditor>`.
- **Ajustes** ([src/pages/gestao/cardapios/Ajustes.tsx](src/pages/gestao/cardapios/Ajustes.tsx)) — tab única "Integrações" com toggle Google Menu disabled "em breve".

**Portal público** ([src/pages/MenuPortal.tsx](src/pages/MenuPortal.tsx)) — `/m/<slug>` consome RPC `get_menu_public(slug)` (anon-safe, filtra unit/org public + menu.active). Layout: banners da home no topo (carrossel auto-rotação 6s), hero com cover + logo + nome, scroll vertical das `menu_pages` em ordem, banners de conteúdo no rodapé. Tema aplicado via inline `style` com hex direto (sem CSS vars do app — isolamento total da paleta).

**Reuso entre módulos**:
- `<DownloadCard>` ([src/components/share/DownloadCard.tsx](src/components/share/DownloadCard.tsx)) — extraído de `Fila/Ajustes`. Usado por Fila (URL `/r/<slug>?action=waitlist`) e Cardápios (URL `/m/<slug>`).
- `<ShareCard>` ([src/components/share/ShareCard.tsx](src/components/share/ShareCard.tsx)) — extraído de `WidgetDetail`. Usado por Widget de reserva e Cardápios.
- Slug 8 chars + retry segue padrão do `useWidgets.generateWidgetSlug`.

### Módulo Fila de espera (`/g/:unitSlug/fila/*`) — gestão

- **Comunicação** ([src/pages/gestao/fila/Comunicacao.tsx](src/pages/gestao/fila/Comunicacao.tsx)) — 2 tabs:
  - **Customização de mensagens**: dropdown com 3 eventos (`entered`/`table_ready`/`feedback`), toggle "Personalizar mensagem", textarea com chips de variáveis, preview com dados de exemplo. Salva em `waitlist_message_templates`.
  - **Configurações**: stub (horários/regras de retry virão depois).
- **Ajustes** ([src/pages/gestao/fila/Ajustes.tsx](src/pages/gestao/fila/Ajustes.tsx)) — chaves `waitlist_*` em `settings`:
  - `waitlist_qr_enabled` / `waitlist_menu_link_enabled` / `waitlist_priority_enabled`
  - `waitlist_code_min` / `waitlist_code_max` (range cíclico) / `waitlist_tolerance_minutes`
  - `waitlist_remote_entry_enabled` / `waitlist_remote_entry_limit`
  - Sidebar lateral: QR Code gerado client-side (lib `qrcode`) apontando pra `/r/<slug>?action=waitlist` (auto-abre o dialog "Entrar na fila"). Botão "Display" stub.
- **Operacional consome ambos**: senhas vêm do `code`, mensagens de notificação vêm do template `table_ready` (com fallback hardcoded).

### Walk-ins (`/o/:slug/passantes`)

- Registro imediato de clientes que chegaram sem reserva
- Alocação de mesa via dropdown antes de "Sentar"
- Ações: Sentar, Não apareceu, Foi embora, Remover

---

## Membros e papéis

| Papel | Permissões |
|---|---|
| `owner` | Acesso total, incluindo criação de outras unidades |
| `gerente` | Configurações, membros, todos os dados da unidade (não tem acesso à automação — restrita ao super-admin) |
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

> **Atenção pós-redesign**: ao alterar `_shared/availability.ts`, sempre redeploy `create-reservation` e `webhook-whatsapp` (compartilham o módulo). Mudanças em RPCs públicas (`get_unit_public_full`, `get_widget_public`) entram via migration, não via deploy.

### Webhook WhatsApp

Para cada canal configurado em **Plataforma → Automação → \<unidade\>**, a URL do webhook é exibida na UI:
```
https://<project-ref>.supabase.co/functions/v1/webhook-whatsapp?channel=<channel-id>
```

Configure essa URL no painel do provider (Z-API, WAHA ou Meta).

### Outbox de notificações (confirmação automática)

**Arquitetura atual** (migrations 028 e 029) — substitui o trigger HTTP direto que era usado até a 022.

Reservas criadas pelo site, portal público ou painel de gestão (`source <> 'whatsapp'`) disparam o trigger `enqueue_confirmation_after_insert` em `reservations`, que insere uma linha em `notification_outbox` com `status='pending'`. Reservas via WhatsApp não disparam (o agente já confirma na conversa).

A Edge Function `process-notification-outbox` é invocada **a cada 1 minuto** pelo `pg_cron` (job `process-notification-outbox`) via wrapper `trigger_outbox_processor()`, que lê o `INTERNAL_API_KEY` do Supabase Vault e dispara `pg_net.http_post` com `x-internal-key`. O worker pega lote de até 20 pendentes due, marca como `processing` (atomicidade via UPDATE…RETURNING), chama `send-confirmation` para cada uma, e atualiza outcome via `mark_outbox_done()` ou `mark_outbox_failed()`. Backoff exponencial: 1m, 5m, 15m, 1h, 4h. Após 5 tentativas a linha vira `dead` com `last_error` preservado.

> **Trigger antigo `send-confirmation-on-reservation`** (criado pelas migrations 019/022, chamava `supabase_functions.http_request` direto, sem retry, sem visibilidade) foi removido pela migration 028. **Não reativar.**

A Edge Function `send-cancellation` continua sendo invocada **client-side** quando uma reserva muda para `status='cancelled'` no painel (ver [src/hooks/useReservas.ts](src/hooks/useReservas.ts) `useUpdateReservaStatus`). Não tem trigger no banco.

### Lembrete D-1 e pesquisa de satisfação D+1 (sem N8N)

**Arquitetura atual** (migrations 044 e 045). Substitui os 2 workflows N8N que viviam em `docs/n8n/` (hoje DEPRECATED).

Mesmo padrão do outbox de confirmação e do giftback: `pg_cron` → wrapper `SECURITY DEFINER` lê `internal_api_key` do Vault → `pg_net.http_post` chama Edge Function com `x-internal-key`.

| Job pg_cron | Schedule | Edge Function | Target date |
|---|---|---|---|
| `process-reservation-reminders` | `0 13 * * *` UTC = 10:00 BRT | [`process-reservation-reminders`](supabase/functions/process-reservation-reminders/index.ts) | hoje + 1 |
| `process-satisfaction-surveys` | `0 17 * * *` UTC = 14:00 BRT | [`process-satisfaction-surveys`](supabase/functions/process-satisfaction-surveys/index.ts) | hoje − 1 |

Cada worker itera todas as `units`. Para cada uma:
1. Lê `settings.reminder_d1_enabled` / `survey_d1_enabled` (default `true`) — pula se `false`.
2. Carrega template de `reservation_message_templates` (`customized=true` + body) ou cai no `DEFAULT_*_BODY` hardcoded em pt-BR no worker.
3. Chama RPC `get_reservations_for_reminder(amanhã, unit_id)` ou `get_reservations_for_survey(ontem, unit_id)`. As RPCs (mig 011, estendidas em 044) já filtram `status='confirmed'`, `do_not_contact=false`, idempotência via NOT EXISTS em `notifications_sent`, e survey filtra `satisfaction_rating IS NULL`.
4. Pra cada reserva elegível: renderiza template e chama `send-whatsapp` com `kind='reminder_d1'` ou `'survey_d1'` + `reservation_id`. UNIQUE `(reservation_id, kind)` em `notifications_sent` é a salvaguarda final de idempotência (race-safe).

A resposta da pesquisa (1-5) é capturada pelo intercept do [`webhook-whatsapp`](supabase/functions/webhook-whatsapp/index.ts) — grava `reservations.satisfaction_rating`/`satisfaction_at`, dispara giftback `after_rating` se houver rule, e captura comentário em texto livre na janela de 30min em `satisfaction_comment`.

**Cliente customiza o texto** em `/g/:slug/reservas/comunicacao` (hook [`useReservationTemplates`](src/hooks/useReservationTemplates.ts)). Variáveis aceitas no template:
- `reminder_d1`: `{{cliente_nome}}`, `{{horario}}`, `{{party_size}}`, `{{codigo}}`, `{{unidade_nome}}`
- `survey_d1`: `{{cliente_nome}}`, `{{codigo}}`, `{{unidade_nome}}`

Se `customized=false` (ou linha ausente em `reservation_message_templates`), worker usa o default. Mantenha o `defaultBody` em [src/hooks/useReservationTemplates.ts](src/hooks/useReservationTemplates.ts) em sincronia com `DEFAULT_*_BODY` nos workers — divergência só afeta o preview na UI (worker é a fonte autoritativa em runtime).

**RPCs auxiliares** (sobreviventes do `012_n8n_functions.sql`, `SECURITY DEFINER`, `service_role` only):

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

## Hardening de segurança multi-tenant

Auditoria aplicada em maio/2026 (migrations 023a/023b/024) fechou os vetores
de vazamento entre empresas. Pontos pra manter ao adicionar features novas:

- **Anon nunca lê tabelas de negócio direto**. Toda leitura pública passa por
  RPC `SECURITY DEFINER` parametrizada (ex.: `get_unit_public_full(slug)`,
  `get_public_business_hours(unit_id)`) que filtra por `is_public = true`
  na própria função. Adicionar policy `... TO anon` direto na tabela é
  regressão garantida — use RPC.
- **Anon insere apenas em units/orgs públicas**. As policies `anon_insert_*`
  em `customers`, `reservations`, `waitlist` têm `EXISTS (... WHERE is_public)`
  no `WITH CHECK`. Mantenha o padrão em qualquer tabela nova com escrita anon.
- **Tabelas com credenciais usam `FORCE ROW LEVEL SECURITY` sem policies**:
  `whatsapp_channels`, `ai_provider_credentials`, `processed_messages`,
  `rate_limit_events`. Nem owner do schema lê — só `service_role` via
  Edge Functions. Para a UI consumir, expor via action de Edge Function
  com whitelist de colunas seguras (modelo: `manage-channels` action `list`).
- **Edge Functions com `INTERNAL_API_KEY`** (`send-confirmation`,
  `send-whatsapp`) devem validar `unit_id` da request contra `unit_id` do
  recurso buscado — defense-in-depth se a key vazar. `_shared/whatsapp-send`
  rejeita pareamento `channel_id` ↔ `unit_id` divergente.
- **CORS em `manage-*`** usa `_shared/cors.ts` (`corsHeadersFor(req)`),
  whitelist de origin em regex (`localhost`, `*.vercel.app`,
  `reservas.moralles.com.br`). Webhooks continuam com `*` — auth por
  webhook secret resolve.
- **Storage `unit-assets`** é bucket público, mas sem policy `SELECT` em
  `storage.objects` — listing bloqueado, retrieval por URL CDN funciona.
- **Auth password protection** (HIBP / HaveIBeenPwned) ativado no painel
  Supabase em **Authentication → Sign In / Providers → Email →
  Prevent use of leaked passwords**. Min length recomendado: 8.

Pra rodar advisor de RLS contra mudanças novas:

```bash
# via MCP no Claude Code: mcp__claude_ai_Supabase__get_advisors
# ou painel: https://supabase.com/dashboard/project/<ref>/advisors
```

## Observabilidade da automação WhatsApp

Auditoria aplicada em maio/2026 (migrations 025-029) eliminou os pontos
cegos do fluxo do WhatsApp. Cada falha agora deixa rastro consultável.

- **Painel de Diagnóstico** em `/platform/automacao/<slug>` → aba "Diagnóstico"
  (Edge Function `whatsapp-health` + hook `useWhatsAppHealth`). Mostra status
  do canal, origem da chave de IA (BYOK/global/missing), stats 24h por
  outcome e últimas 50 execuções com cores. Refetch automático a cada 30s.
- **`webhook_executions`** registra TODA execução do webhook com `outcome`
  (success, agent_error, send_error, empty_response, rate_limited, duplicate,
  human_active_silent, human_active_reminded, handoff_auto_resolved,
  ai_key_unavailable, webhook_unauthorized, channel_not_found, etc).
  FORCE RLS — leitura só via Edge Function `whatsapp-health`.
- **Idempotência segura** (`processed_messages` com `started_at`/`completed_at`
  /`outcome`). Se o handler cair no meio (>90s sem completed_at),
  retransmissão do provider permite reprocessamento — não descarta como
  duplicada cega.
- **UX handoff** ([webhook-whatsapp/index.ts](supabase/functions/webhook-whatsapp/index.ts)):
  - Conversa em `human_active`/`awaiting_human` há mais de 12h sem reply
    humano → **auto-resolve** pra `ai_active`, bot manda "Voltei a te atender";
  - Durante o silêncio, cliente recebe lembrete UMA vez a cada 6h
    ("Recebi! Já avisei a equipe…") via throttle em
    `conversations.last_silenced_reply_at`. Antes a conversa ficava muda
    por dias.
- **HMAC SHA-256** valida webhooks de provider `official` (Meta Cloud API)
  com o `app_secret` do canal. Antes passava silenciosamente — security
  hole fechado. Z-API/WAHA continuam com `webhook_secret` per-channel.
- **`sendOutbound` retorna `SendResult` estruturado** (`{ ok, status, error,
  bodySnippet, missingCreds }`). Antes era boolean opaco — qualquer falha
  de envio (401/429/credenciais faltando) era invisível.
- **Outbox de confirmação** (ver seção *Outbox de notificações*) substitui
  o trigger HTTP direto por fila com retry exponencial.

**Manutenção:**

```sql
-- Inspecionar últimas falhas
select outcome, count(*), max(created_at) last_seen
from webhook_executions
where created_at > now() - interval '24 hours'
group by outcome order by count(*) desc;

-- Outbox preso em dead
select id, reservation_id, last_error, attempts, created_at
from notification_outbox
where status='dead' order by created_at desc limit 20;

-- Cleanup periódico (executar via cron mensal ou rodar manual)
select cleanup_webhook_executions();
select cleanup_processed_messages();
```

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
