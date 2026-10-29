# Redesign "Salão em vidro" — Parte A (visual) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** trocar o visual de todo o frontend pelo sistema "Salão em vidro" (tokens, fonte, materiais, componentes, cascos e telas-chave) nos temas Noite e Dia, sem mudar dado, regra nem backend.

**Architecture:** os nomes das variáveis CSS atuais continuam e só os valores mudam, então shadcn e telas herdam o visual. Materiais (vidro, profundidade, movimento) viram utilitários em `src/index.css` e chaves no `tailwind.config.ts`. O tema passa a ser decidido por rota: rotas públicas forçam Dia, painéis abrem em Noite para quem nunca escolheu. A única peça 3D da Parte A é o gráfico de chegadas de hoje, em CSS 3D sobre DOM.

**Tech Stack:** Vite, React 18, TypeScript, Tailwind 3.4, shadcn/Radix, next-themes 0.3, recharts, Vitest + Testing Library (jsdom).

**Spec:** [docs/superpowers/specs/2026-10-29-redesign-salao-em-vidro-design.md](../specs/2026-10-29-redesign-salao-em-vidro-design.md). Mockups de referência em [docs/superpowers/specs/2026-10-29-redesign-salao-em-vidro/](../specs/2026-10-29-redesign-salao-em-vidro/): `Main.dc.html` (Dashboard), `Salao.dc.html` (planta, Parte B), `Portal.dc.html` (portal) e `Sistema.dc.html` (sistema visual). Onde a spec silencia, o mockup vale; onde divergem, vale a spec.

**Parte B (planta do salão)** tem plano próprio, escrito num chat dedicado depois que a Parte A estiver em produção (ver o fim deste documento).

## Global Constraints

- Parte A é só frontend: nenhuma mudança em hook de dados, query key, mutation, Edge Function, migration ou RLS. Usar um hook existente numa tela nova é permitido.
- Nunca cor fixa em componente (hex, `rgb()`, paleta crua do Tailwind como `bg-zinc-900`, `bg-white`, `text-black`). Cor só por token. Hex só existe na definição dos tokens em `src/index.css`.
- Nomes das variáveis CSS atuais mantidos. Os quatro escopos continuam (`:root`, `.theme-admin`, `.dark`, `.dark .theme-admin`).
- Nenhuma dependência nova, nem de animação, 3D ou fonte. Geist vem do Google Fonts, como a fonte atual. Adicionar pacote exige decisão do dono (padrão SaaS).
- `backdrop-filter` só em superfícies únicas (sobreposições, casco, painel principal, rodapé do wizard, login). Nunca em item repetido de lista. O teste-guarda da Task 3 faz valer.
- Movimento: entradas de 0,9 a 1,6 s com `cubic-bezier(0.16, 1, 0.3, 1)`; resposta ao toque de 200 a 350 ms, só `transform` e `opacity`; tudo sob `motion-safe:`. Com `prefers-reduced-motion: reduce`, o estado final aparece direto.
- 3D só no gráfico de chegadas de hoje (Task 10).
- APIs de `src/components/ui/*` mantidas: props e variantes existentes continuam. Adicionar variante pode; remover não.
- Regras de [.claude/rules/frontend.md](../../../.claude/rules/frontend.md): `viewport-fit=cover`; pares de input em `grid grid-cols-1 sm:grid-cols-2`; quatro estados de lista; `ReservaCard` nunca em página pública; `cn()` sempre.
- Alvo de toque mínimo de 44 px em ponteiro grosso (variante `coarse:` da Task 2).
- Pílulas de reserva mostram só a situação gravada (Pendente, Confirmada, Cancelada, Não compareceu).
- Texto em PT-BR, frases em caixa normal, sem rótulo em caixa alta.
- O preview da Vercel usa o Supabase de produção: na revisão pelo preview, só navegue; não crie, confirme nem cancele reserva real.
- Ao fim de cada fase: `npm run typecheck`, `npm run lint`, `npm run test` e `npm run build` verdes.
- Git: `git add <caminho>` explícito; nada direto em `main`; push só com autorização do dono.

## Review Focus

1. **Tema salvo e tema por rota.** Quem já escolheu tema no painel mantém a escolha. Quem nunca escolheu abre o painel no escuro. Rota pública fica sempre clara, inclusive dialog e toast, mesmo com "escuro" salvo. Teste na Task 4.
2. **Reserva fora do horário cadastrado.** Uma reserva às 23:30 numa unidade que fecha às 22h aparece no gráfico de chegadas, que estende a faixa. Hoje o `byHour` do período descarta esse caso. Teste na Task 9.
3. **Dia sem reservas ou só com canceladas.** Sem frase de pico ("Pico às 0h…" nunca aparece), gráfico substituído por estado vazio. Testes nas Tasks 9 e 11.
4. **Tablet com 40 reservas na lista.** Nenhum item repetido usa `backdrop-filter`. Teste-guarda na Task 3.
5. **Navegador sem `backdrop-filter`, com transparência reduzida ou movimento reduzido.** O vidro cai para a cor sólida e as barras aparecem já no lugar. Teste-guarda de CSS na Task 3 e teste de classe na Task 10.

---

## Como executar (um chat por fase)

As seis fases são A1 a A6. Cada uma roda num chat novo e termina com o sistema consistente.

**Abertura do chat da fase**

1. Rodar `/padrao-saas:mudanca redesign-salao-em-vidro`. A Etapa 0 lê `.tasks/redesign-salao-em-vidro/STATE.md` e confere `git status` e `git diff`.
2. `git switch feat/redesign-salao-em-vidro`, depois `git switch -c feat/redesign-a<N>-<nome>` (nome na tabela abaixo).
3. Executar as tasks da fase com `superpowers:subagent-driven-development`:
   - review por task, como exige o AGENTS §4;
   - executor de cada task escolhido por `ai-router-br:route`. Se ele não decidir: `saas-builder-br:design-ux` para tokens, componentes e a11y, `saas-builder-br:frontend-react` para telas e `saas-builder-br:qa-testes` para testes;
   - modelo `sonnet` para implementador e revisor de task; o modelo mais capaz só na revisão da branch da fase.

**Fechamento da fase**

1. Rodar `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `node scripts/check-padrao.mjs` e `node scripts/check-portabilidade.mjs`. Todos verdes.
2. Revisão visual com `npm run dev`:
   - rotas da fase em 1440×900, 1194×834 e 390×844, nos dois temas;
   - anotar no STATE o que foi visto e o que ficou pendente.
3. Revisar a branch da fase com `superpowers:requesting-code-review`.
4. Integrar: `git switch feat/redesign-salao-em-vidro`, depois `git merge --no-ff feat/redesign-a<N>-<nome>`.
5. Marcar os checkboxes da fase neste plano e fazer commit do plano na branch de integração.
6. Atualizar `.tasks/redesign-salao-em-vidro/STATE.md` e a memória do projeto (fase concluída, próximo passo).
7. Pedir autorização ao dono e rodar `git push origin feat/redesign-salao-em-vidro`. Registrar no STATE a URL do preview da Vercel.
8. Sugerir chat novo para a próxima fase.

| Fase | Branch | Tasks |
|---|---|---|
| A1 Fundação | `feat/redesign-a1-fundacao` | 1–4 |
| A2 Componentes e cascos | `feat/redesign-a2-componentes` | 5–8 |
| A3 Dashboard | `feat/redesign-a3-dashboard` | 9–11 |
| A4 Operacional | `feat/redesign-a4-operacional` | 12–13 |
| A5 Portal público e login | `feat/redesign-a5-portal` | 14–16 |
| A6 Varredura e lançamento | `feat/redesign-a6-varredura` | 17–20 |

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/index.css` | tokens dos dois temas, utilitários `surface`, `glass`, `glass-strong`, `ambient`, fallbacks |
| `tailwind.config.ts` | fonte, cores novas (`status`, `gold.ink`, `tertiary`), raios, sombras, curva, keyframes, variante `coarse` |
| `index.html` | link da Geist |
| `src/lib/theme-routes.ts` | `isLightOnlyRoute(pathname)` |
| `src/components/RouteThemeProvider.tsx` | `ThemeProvider` com `forcedTheme` por rota e padrão escuro |
| `src/lib/theme-tokens.test.ts` | coerência dos escopos, valores da spec e contraste AA |
| `src/lib/tailwind-theme.test.ts` | chaves do Tailwind e fonte |
| `src/lib/glass-usage-guard.test.ts` | onde `glass`/`backdrop-blur` podem aparecer; fallbacks de CSS |
| `src/components/ui/*` | restilização com APIs mantidas |
| `src/components/dashboard/KpiStat.tsx`, `KpiStrip.tsx` | KPI sem card e faixa de KPIs |
| `src/components/layouts/BrandMark.tsx` | orbe champanhe + nome do produto |
| `src/lib/arrivals-today.ts` | chegadas de hoje por hora, frase de pico, próximas chegadas |
| `src/components/dashboard/ArrivalsByHour3D.tsx` | barras isométricas em CSS 3D |
| `src/components/dashboard/DashboardHero.tsx`, `UpcomingArrivalsPanel.tsx`, `ConversationsWaitingPanel.tsx` | blocos novos do Dashboard |
| `src/components/reserva/wizard/summary-line.ts` | linha de resumo do rodapé do wizard |

---

## Fase A1 — Fundação

### Task 1: Tokens "Salão em vidro"

**Files:**
- Modify: `src/index.css:7-281` (os dois blocos `@layer base` de tokens)
- Test: `src/lib/theme-tokens.test.ts`

**Interfaces:**
- Produces: as variáveis abaixo nos dois grupos de seletores. Tokens novos: `--tertiary-foreground`, `--gold-ink`, `--status-free|reserved|arriving|seated|late|pending`, `--glass-tint`, `--glass-alpha`, `--glass-strong-alpha`, `--glass-edge`, `--glass-edge-alpha`, `--glass-highlight`, `--glass-highlight-alpha`, `--glass-blur`, `--shadow-color`.

Estrutura: os quatro escopos viram dois grupos de seletores com o mesmo conteúdo por tema, `:root, .theme-admin { … }` e `.dark, .dark .theme-admin { … }`. Assim os escopos continuam existindo e não divergem mais. A especificidade 0,2,0 do `.dark .theme-admin` segue vencendo o `.theme-admin`. Cores ficam em triplete HSL (`H S% L%`, uma casa decimal permitida), porque os componentes usam `hsl(var(--x) / alfa)`.

Valores (hex a converter). Os marcados com † vêm da spec; os demais são decisão deste plano e podem ser ajustados se o teste de contraste reprovar.

| Token | Noite (`.dark`) | Dia (`:root`) |
|---|---|---|
| `--background` | †`#0B0D11` | †`#EDEFF2` |
| `--foreground`, `--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground` | †`#F3F1EC` | †`#111318` |
| `--card` | †`#14161B` | †`#FFFFFF` |
| `--popover` | `#232529` (branco 10%) | `#FFFFFF` |
| `--primary` / `--primary-foreground` | †`#E2C48A` / †`#1A1408` | †`#111318` / †`#F6F4EF` |
| `--secondary` | `#1A1C1F` | `#E3E5E9` |
| `--muted` | `#17191D` | `#E6E8EB` |
| `--muted-foreground` | †`#B0ADA7` | †`#4F545C` |
| `--tertiary-foreground` | †`#8E8B86` | †`#5E636B` |
| `--accent` | `#1C1E22` | `#E1E3E7` |
| `--destructive` / `-foreground` | `#FF6B6B` / `#1A0808` | `#C7372F` / `#FFFFFF` |
| `--border` | `#1F2024` (branco 8%) | `#DBDDE1` (`#101218` a 8%) |
| `--input` | `#232529` | `#D3D6DB` |
| `--ring`, `--gold`, `--sidebar-primary`, `--sidebar-ring` | †`#E2C48A` | †`#9A7434` |
| `--gold-foreground`, `--sidebar-primary-foreground` | `#1A1408` | `#FFFFFF` |
| `--gold-ink` (texto em champanhe) | †`#E8CC93` | †`#7A5A20` |
| `--info` / `-foreground` | `#9EC1FF` / `#0B0D11` | `#2F62B8` / `#FFFFFF` |
| `--success` / `-foreground` | `#7ED8B0` / `#0B0D11` | `#1F7A56` / `#FFFFFF` |
| `--warning` / `-foreground` | manter os atuais do `.dark` | manter os atuais do `:root` |
| `--surface-elevated` | `#1A1C1F` | `#FFFFFF` |
| `--sidebar-background` | †`#08090C` | `#E6E8EC` |
| `--sidebar-foreground` | †`#B0ADA7` | †`#4F545C` |
| `--sidebar-accent` / `-foreground` | `#221F1B` / †`#E8CC93` | `#DEDCD9` / †`#7A5A20` |
| `--sidebar-border` | `#17181B` | `#D5D8DD` |
| `--status-free` | `#6A6C70` (ver nota) | †`#4F545C` |
| `--status-reserved` | †`#E2C48A` | †`#7A5A20` |
| `--status-arriving` | †`#9EC1FF` | †`#2F62B8` |
| `--status-seated` | †`#7ED8B0` | †`#1F7A56` |
| `--status-late` | †`#FF9478` | †`#B4442A` |
| `--status-pending` | `#B6B6B8` (branco 70%) | †`#4F545C` |
| `--glass-tint` | `0 0% 100%` | `0 0% 100%` |
| `--glass-alpha` / `--glass-strong-alpha` | †`0.045` / †`0.10` | †`0.68` / `0.82` |
| `--glass-edge` / `--glass-edge-alpha` | `0 0% 100%` / †`0.08` | `#101218` / †`0.08` |
| `--glass-highlight` / `--glass-highlight-alpha` | `0 0% 100%` / †`0.11` | `0 0% 100%` / `0.9` |
| `--glass-blur` | †`28px` | †`28px` |
| `--shadow-color` | `0 0% 0%` | `225 20% 8%` |

Gráficos: os mesmos nomes de hoje (`--chart-*`), com estes valores.

| Token | Noite | Dia |
|---|---|---|
| `--chart-reserva`, `--chart-whatsapp`, `--chart-trigger-rating` | `#7ED8B0` | `#1F7A56` |
| `--chart-fila`, `--chart-used`, `--chart-trigger-frequency` | `#E2C48A` | `#9A7434` |
| `--chart-passante`, `--chart-trigger-manual`, `--chart-trigger-other` | `#8E8B86` | `#5E636B` |
| `--chart-geral`, `--chart-email` | `#9EC1FF` | `#2F62B8` |
| `--chart-issued` | `#F08FA8` | `#C2416B` |
| `--chart-trigger-birthday` | `#C4A8FF` | `#7B52C9` |

Nota sobre `--status-free` no escuro: a spec diz "branco a 30%", mas isso dá 2,4:1 contra o card, abaixo do mínimo de 3:1 para indicador que não é texto. O plano sobe para cerca de 38% (`#6A6C70`).

`--radius` continua `0.75rem`. Abaixo de 640 px, `--glass-blur: 16px` (spec §4.3), dentro de `@media (max-width: 639px)` nos dois grupos.

- [x] **Step 1: Escrever o teste que falha** em `src/lib/theme-tokens.test.ts`.
  - O teste lê `src/index.css` com `fs.readFileSync`, extrai os blocos `:root, .theme-admin` e `.dark, .dark .theme-admin` e converte HSL em RGB. Os helpers de parse, conversão HSL→RGB e luminância relativa (WCAG 2.x) ficam dentro do próprio arquivo de teste.
  - Testes:
    - `"os dois grupos de escopo existem e definem os mesmos tokens"`: o conjunto de nomes `--*` dos dois grupos é igual e contém todos os tokens da tabela.
    - `"valores da spec batem"`: para cada valor † da tabela, `hexOf(token)` difere em no máximo 2 por canal.
    - `"contraste AA de texto"`, ≥ 4,5 nos dois temas:
      - `foreground` sobre `background`, `card` e `popover`;
      - `muted-foreground` sobre `background`, `card` e `muted`;
      - `tertiary-foreground` sobre `background` e `card`;
      - `gold-ink` sobre `background` e `card`;
      - cada `X-foreground` sobre seu `X` (primary, destructive, success, info, warning);
      - `sidebar-foreground` sobre `sidebar-background`;
      - `sidebar-accent-foreground` sobre `sidebar-accent`;
      - `status-reserved|arriving|seated|late|pending` sobre `card`.
    - `"contraste de indicador"`, ≥ 3: `status-free` sobre `card`, e `gold-foreground` sobre `gold`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/theme-tokens.test.ts`. Esperado: FAIL, porque os grupos `:root, .theme-admin` ainda não existem.
- [x] **Step 3: Reescrever os blocos de tokens em `src/index.css`** com os dois grupos e os valores da tabela. Os blocos `* { @apply border-border }` e `body {…}` continuam. Os comentários de cabeçalho dizem "Salão em vidro: Noite e Dia".
- [x] **Step 4: Rodar e ver passar.** Mesmo comando. Esperado: PASS. Se um par derivado reprovar, ajustar só o valor derivado (nunca um †) e registrar no commit.
- [x] **Step 5: Commit.** `git add src/index.css src/lib/theme-tokens.test.ts` e depois `git commit -m "feat(tema): tokens Salão em vidro nos temas Noite e Dia"`.

### Task 2: Tailwind e fonte Geist

**Files:**
- Modify: `tailwind.config.ts`, `index.html:19-21`, `src/index.css:1` (remove o `@import` da Plus Jakarta)
- Test: `src/lib/tailwind-theme.test.ts`

**Interfaces:**
- Consumes: tokens da Task 1.
- Produces, como classes que as tasks seguintes usam:
  - `font-sans` e `font-display` (Geist);
  - cores `text-tertiary`, `text-gold-ink` e `{bg,text,border}-status-{free,reserved,arriving,seated,late,pending}`;
  - raios `rounded-panel` (30 px), `rounded-card` (24 px), `rounded-block` (16 px) e `rounded-item` (12 px);
  - sombras `shadow-depth-1`, `shadow-depth-2` e `shadow-depth-3`;
  - curva `ease-out-expo`;
  - animação `animate-rise`;
  - variante `coarse:`.

Valores:
- `fontFamily.sans` e `display` passam a `["Geist", "system-ui", "sans-serif"]`.
- `colors` ganha:
  - `tertiary: "hsl(var(--tertiary-foreground))"`;
  - `gold.ink: "hsl(var(--gold-ink))"`;
  - `status: { free, reserved, arriving, seated, late, pending }`, cada uma `hsl(var(--status-…))`.
- `borderRadius`: `panel: "30px"`, `card: "24px"`, `block: "16px"`, `item: "12px"`.
- `boxShadow`:
  - `depth-1: "0 1px 2px hsl(var(--shadow-color) / 0.10), 0 8px 24px -12px hsl(var(--shadow-color) / 0.25)"`;
  - `depth-2: "0 2px 6px hsl(var(--shadow-color) / 0.12), 0 24px 48px -24px hsl(var(--shadow-color) / 0.40)"`;
  - `depth-3: "0 4px 12px hsl(var(--shadow-color) / 0.14), 0 40px 80px -32px hsl(var(--shadow-color) / 0.55)"`.
  - As sombras atuais (`soft`, `premium`, `gold-glow`) continuam.
- `transitionTimingFunction`: `"out-expo": "cubic-bezier(0.16, 1, 0.3, 1)"`.
- `keyframes.rise`: de `{ transform: "scaleY(0)" }` para `{ transform: "scaleY(1)" }`.
- `animation.rise`: `"rise 1.2s cubic-bezier(0.16, 1, 0.3, 1) both"`. O pulso de estado vivo (mesa chegando ou atrasada) só tem uso na Parte B e nasce lá.
- `screens.coarse: { raw: "(pointer: coarse)" }`.
- `index.html`: o link da fonte vira `https://fonts.googleapis.com/css2?family=Geist:wght@300..700&display=swap`. Os `preconnect` continuam.

- [x] **Step 1: Escrever o teste que falha** em `src/lib/tailwind-theme.test.ts`. Ele importa `tailwind.config` e lê `index.html` e `src/index.css`.
  - `"fonte é Geist"`: `theme.extend.fontFamily.sans[0] === "Geist"` e `display[0] === "Geist"`.
  - `"index.html carrega Geist e não carrega Plus Jakarta"`: contém `family=Geist:wght@300..700` e não contém `Plus+Jakarta`.
  - `"index.css não importa fonte"`: não contém `@import url(`.
  - `"cores e raios novos existem"`: as chaves de `status`, `gold.ink`, `tertiary`, `panel/card/block/item` e `screens.coarse.raw === "(pointer: coarse)"`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/tailwind-theme.test.ts`. Esperado: FAIL.
- [x] **Step 3: Aplicar as mudanças** em `tailwind.config.ts`, `index.html` e `src/index.css`.
- [x] **Step 4: Rodar e ver passar.** O mesmo teste e depois `npm run build`. Esperado: PASS e build verde.
- [x] **Step 5: Commit.** `git add tailwind.config.ts index.html src/index.css src/lib/tailwind-theme.test.ts` e depois `git commit -m "feat(tema): Geist e chaves de material no Tailwind"`.

### Task 3: Utilitários de material e teste-guarda

**Files:**
- Modify: `src/index.css` (`@layer utilities`)
- Test: `src/lib/glass-usage-guard.test.ts`

**Interfaces:**
- Produces: as classes `surface`, `glass`, `glass-strong`, `ambient` e `tabular`.

Definições:
- `surface`: o vidro sem desfoque, para cards e itens repetidos.
  - `background-color: hsl(var(--glass-tint) / var(--glass-alpha))`;
  - `border: 1px solid hsl(var(--glass-edge) / var(--glass-edge-alpha))`;
  - `box-shadow: inset 0 1px 0 hsl(var(--glass-highlight) / var(--glass-highlight-alpha))` mais a sombra de `depth-1`;
  - nenhum `backdrop-filter`.
- `glass`: `surface` mais `backdrop-filter: blur(var(--glass-blur)) saturate(150%)` e o prefixo `-webkit-`, com a sombra `depth-2`.
- `glass-strong`: igual a `glass`, com alfa `--glass-strong-alpha` e sombra `depth-3`.
- Fallback de suporte: `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` faz `.glass` usar `hsl(var(--card))` e `.glass-strong` usar `hsl(var(--popover))`.
- Fallback de transparência: `@media (prefers-reduced-transparency: reduce)` faz o mesmo para `.surface`, `.glass` e `.glass-strong`, além de `backdrop-filter: none`.
- `ambient`: fundo estático do casco, com `background-image` de dois `radial-gradient`:
  - champanhe `hsl(var(--gold) / 0.10)` no topo à esquerda;
  - `hsl(var(--info) / 0.06)` à direita;
  - sem animação e sem `background-attachment: fixed`.
- `tabular`: `font-variant-numeric: tabular-nums`.

- [x] **Step 1: Escrever o teste que falha** em `src/lib/glass-usage-guard.test.ts`:
  - `"surface nunca desfoca"`: o bloco `.surface { … }` do `src/index.css` não contém `backdrop-filter`.
  - `"fallbacks existem"`: o CSS contém `@supports not ((backdrop-filter` e `prefers-reduced-transparency: reduce`.
  - `"vidro com desfoque só em superfícies únicas"`:
    - varre `src/**/*.tsx` (fora de testes) atrás da regex `/\bglass(-strong)?\b|backdrop-blur/` e falha para qualquer arquivo fora de `ALLOWED_BLUR_FILES`;
    - lista inicial: `src/components/layouts/AdminShell.tsx`, `src/components/ui/{dialog,alert-dialog,responsive-dialog,popover,dropdown-menu,tooltip,select,sonner}.tsx`, `src/pages/Index.tsx` e `src/pages/gestao/Conta.tsx`;
    - comentário no topo: incluir um arquivo exige que a superfície seja única na tela, nunca item de lista.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/glass-usage-guard.test.ts`. Esperado: FAIL, porque `.surface` e os fallbacks ainda não existem.
- [x] **Step 3: Adicionar os utilitários** em `src/index.css`.
- [x] **Step 4: Rodar e ver passar.** Esperado: PASS.
- [x] **Step 5: Commit.** `git add src/index.css src/lib/glass-usage-guard.test.ts` e depois `git commit -m "feat(tema): utilitários de vidro e guarda de desfoque"`.

### Task 4: Tema por rota, padrão escuro e regra de tema

**Files:**
- Create: `src/lib/theme-routes.ts`, `src/lib/theme-routes.test.ts`, `src/components/RouteThemeProvider.tsx` e `src/components/RouteThemeProvider.test.tsx`
- Modify:
  - `src/App.tsx:204-321` (o `ThemeProvider` sai de fora do `BrowserRouter` e entra como `RouteThemeProvider` dentro dele, envolvendo `PreferenceAuthBoundary` e o `Toaster`);
  - `src/components/ui/sonner.tsx`;
  - `src/components/ThemeToggle.tsx` (só o comentário);
  - `.claude/rules/frontend.md` (seção "Tema visual").

**Interfaces:**
- Produces:
  - `isLightOnlyRoute(pathname: string): boolean`;
  - `RouteThemeProvider({ children }: { children: React.ReactNode })`.

`isLightOnlyRoute` retorna `true` para:
- `/` exato;
- prefixos com fronteira de segmento: `/r/`, `/w/`, `/m/`, `/acompanhar/`, `/preferencias/`;
- `/admin/login` e `/reset-password` exatos.

Retorna `false` para o resto. `RouteThemeProvider` lê `useLocation().pathname` e renderiza `ThemeProvider` com:
- `attribute="class"`;
- `defaultTheme="dark"`;
- `enableSystem={false}`;
- `storageKey="moralles-theme"` (a chave atual, que preserva quem já escolheu);
- `disableTransitionOnChange`;
- `forcedTheme={isLightOnlyRoute(pathname) ? "light" : undefined}`.

No `sonner.tsx`, o tema vem de `const { forcedTheme, resolvedTheme } = useTheme()`, e o valor passado ao Sonner é `forcedTheme ?? resolvedTheme ?? "light"`.

- [x] **Step 1: Escrever os testes que falham.**
  - `theme-routes.test.ts`:
    - `true` para `/`, `/r/casa`, `/r/casa?mode=embed`, `/w/casa`, `/m/casa`, `/acompanhar/abc`, `/preferencias/mensagens/tok`, `/admin/login` e `/reset-password`;
    - `false` para `/g/casa`, `/o/casa`, `/platform/empresas`, `/admin`, `/rx`, `/report` e `/g/casa/reservas`.
    - Para o caso com query, passar só o pathname `/r/casa`.
  - `RouteThemeProvider.test.tsx`, com `MemoryRouter` e `localStorage` limpo a cada teste:
    - `"rota pública fica clara mesmo com escuro salvo"`: com `moralles-theme=dark` e rota `/r/casa`, após render `document.documentElement.classList.contains("dark") === false`.
    - `"painel sem escolha abre escuro"`: rota `/g/casa` sem chave, `contains("dark") === true`.
    - `"painel mantém claro escolhido"`: `moralles-theme=light`, rota `/g/casa`, `contains("dark") === false`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/theme-routes.test.ts src/components/RouteThemeProvider.test.tsx`. Esperado: FAIL (módulos inexistentes).
- [x] **Step 3: Implementar** `theme-routes.ts`, `RouteThemeProvider.tsx`, a troca no `App.tsx` e o ajuste no `sonner.tsx`.
- [x] **Step 4: Rodar e ver passar.** Os testes acima e depois `npm run test`. Esperado: PASS.
- [x] **Step 5: Reescrever a seção "Tema visual" de `.claude/rules/frontend.md`.** Os dois bullets atuais (`viewport-fit=cover` e `grid-cols-1 sm:grid-cols-2`) continuam. O parágrafo de abertura é substituído por regras no formato do AGENTS §3:
  - temas Noite e Dia definidos em dois grupos de seletores (`:root, .theme-admin` e `.dark, .dark .theme-admin`), com o teste `theme-tokens.test.ts` como guarda;
  - rota pública e login forçam Dia via `forcedTheme` do `RouteThemeProvider`, e painel sem escolha abre em Noite. Um wrapper de escopo não alcança Dialog e Sonner, que renderizam no `body`;
  - `backdrop-filter` só em superfície única, com `surface` para itens repetidos, guardado por `glass-usage-guard.test.ts`;
  - nunca cor fixa; situação de reserva com texto além da cor.
- [x] **Step 6: Commit.**
  - `git add src/lib/theme-routes.ts src/lib/theme-routes.test.ts src/components/RouteThemeProvider.tsx src/components/RouteThemeProvider.test.tsx src/App.tsx src/components/ui/sonner.tsx src/components/ThemeToggle.tsx .claude/rules/frontend.md`;
  - `git commit -m "feat(tema): tema por rota, painel escuro por padrão e regra atualizada"`.

**Fechamento da fase A1.** Protocolo de fechamento. Revisão visual: `/g/:slug` nos dois temas e `/r/:slug` com escuro salvo, que deve ficar claro. Nesta fase os componentes ainda têm a forma antiga; só cores e fonte mudam.

---

## Fase A2 — Componentes base e cascos

### Task 5: Botões, campos, seletores e pílulas

**Files:**
- Modify:
  - `src/components/ui/{button,input,textarea,select,tabs,switch,checkbox,calendar,badge}.tsx`;
  - `src/types/reserva.ts:590-595` (`STATUS_COLORS`).
- Test: `src/components/ui/button.test.ts`

**Interfaces:**
- Consumes: as classes da Task 2 e da Task 3.
- Produces: `buttonVariants` com as variantes atuais mais `glass`.

Alvos visuais (mockup `Sistema.dc.html`, seção de componentes):
- **Button:**
  - forma `rounded-full`; altura `h-10 coarse:h-11`, com `sm` em `h-9 coarse:h-11` e `lg` em `h-12`;
  - `default` = `bg-primary text-primary-foreground` (champanhe no escuro, tinta no claro);
  - `glass` = `surface text-foreground hover:bg-accent`; `outline` passa a usar `surface`;
  - transição `transition-[transform,opacity,background-color] duration-200 ease-out-expo` com `active:scale-[0.98]`.
- **Input, SelectTrigger:** `rounded-full`, `bg-secondary/70`, `border-input`, foco `ring-2 ring-ring/50`. **Textarea:** `rounded-block`. A altura atual e o `h-12` usado pelo wizard continuam respeitados (o `className` de quem chama vence via `cn`).
- **TabsList** em cápsula `rounded-full bg-secondary p-1`; **TabsTrigger** ativo `bg-card shadow-depth-1 rounded-full`.
- **Badge:** `rounded-full`, com padding `px-2.5 py-0.5`.
- **`STATUS_COLORS`:**
  - `pending` = `bg-status-pending/15 text-status-pending border-status-pending/25`;
  - `confirmed` = `bg-status-reserved/15 text-status-reserved border-status-reserved/25`;
  - `cancelled` = `bg-destructive/15 text-destructive border-destructive/25`;
  - `no_show` = `bg-muted text-muted-foreground border-border`.
- **Switch, Checkbox e Calendar:** marcados em `bg-primary`, raios na hierarquia nova, dia selecionado em cápsula.

- [x] **Step 1: Escrever o teste que falha** em `src/components/ui/button.test.ts`:
  - `"variantes antigas continuam"`: para `default`, `destructive`, `outline`, `secondary`, `ghost` e `link`, `buttonVariants({ variant })` é string não vazia;
  - `"variante glass existe e usa surface"`: o retorno contém `surface`;
  - `"botão é cápsula com alvo de toque"`: `buttonVariants({})` contém `rounded-full` e `coarse:h-11`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/ui/button.test.ts`. Esperado: FAIL.
- [x] **Step 3: Restilizar os nove componentes e `STATUS_COLORS`.**
- [x] **Step 4: Rodar e ver passar.** O teste e depois `npm run test`, porque testes de wizard e WhatsApp checam classes. Esperado: PASS. Se um teste existente reprovar por classe, ajustar o componente, não o teste, a menos que o teste cheque cor antiga; nesse caso, atualizar a asserção e citar no commit.
- [x] **Step 5: Commit** dos arquivos listados: `git commit -m "feat(ui): botões, campos e pílulas no Salão em vidro"`.

### Task 6: Superfícies e sobreposições

**Files:**
- Modify: `src/components/ui/{card,dialog,alert-dialog,responsive-dialog,popover,dropdown-menu,tooltip,select,table,skeleton,scroll-area,sonner,toast}.tsx`
- Test: `src/components/ui/card.test.tsx`

**Interfaces:**
- Produces: `Card` com `surface rounded-card`, sem desfoque.

Alvos:
- **Card:** `surface rounded-card text-card-foreground`. Sai `bg-card shadow-soft border`, porque o `surface` já traz borda e sombra.
- **DialogContent, AlertDialogContent, ResponsiveDialog (as duas formas), PopoverContent, DropdownMenuContent, SelectContent, TooltipContent e o toast do Sonner** usam `glass-strong`:
  - dialogs em `rounded-panel`, menus em `rounded-block`;
  - a sobreposição escura passa a `bg-background/60` com `backdrop-blur-sm`;
  - o `ResponsiveDialog` mantém o bottom-sheet abaixo de 640 px e o `env(safe-area-inset-bottom)` no rodapé.
- **Table:** cabeçalho em `text-tertiary`, hover de linha `bg-accent/60`.
- **Skeleton:** `bg-muted`.
- **ScrollArea:** thumb `bg-border`.

- [x] **Step 1: Escrever o teste que falha** em `src/components/ui/card.test.tsx`:
  - `"card é vidro sem desfoque"`: renderiza `<Card data-testid="c" />`; o `className` contém `surface` e `rounded-card` e não contém `glass` nem `backdrop`;
  - `"className do chamador continua valendo"`: `<Card className="p-0" />` contém `p-0`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/ui/card.test.tsx`. Esperado: FAIL.
- [x] **Step 3: Restilizar os componentes.**
- [x] **Step 4: Rodar e ver passar.** O teste, `npx vitest run src/lib/glass-usage-guard.test.ts` e `npm run test`. Esperado: PASS.
- [x] **Step 5: Commit:** `git commit -m "feat(ui): superfícies de vidro e sobreposições"`.

### Task 7: KPI e cartões de gráfico

**Files:**
- Create: `src/components/dashboard/KpiStat.tsx`, `src/components/dashboard/KpiStrip.tsx`
- Modify: `src/components/dashboard/{KpiCard,ChartCard,OccupancyByHourChart,ReservationsByDayChart}.tsx`
- Test: `src/components/dashboard/KpiCard.test.tsx`

**Interfaces:**
- Produces:
  - `KpiStat(props: KpiCardProps)`: o conteúdo atual do `KpiCard`, sem o `Card` em volta.
  - `KpiCard(props: KpiCardProps)`: API inalterada, renderiza `<Card><KpiStat/></Card>`.
  - `KpiStrip({ children, className }: { children: React.ReactNode; className?: string })`: painel `surface rounded-card` com grid `grid-cols-2 lg:grid-cols-4` (o `className` pode trocar o número de colunas) e divisórias `divide-border` entre itens.
  - `KpiCardProps` passa a ser exportado de `KpiStat.tsx`. `KpiCard.tsx` importa de lá e reexporta, para quem já importa de `KpiCard` não quebrar.

O valor usa `tabular` e `text-3xl font-semibold tracking-tight`, e o `formatValue` não muda. Nos gráficos recharts, a barra passa a `hsl(var(--chart-reserva))`, a grade a `hsl(var(--border))`, o tooltip a `hsl(var(--popover))` com `borderRadius: 16`, e a área do "Reservas por dia" ganha gradiente de `--chart-reserva` a transparente.

- [x] **Step 1: Escrever o teste que falha** em `KpiCard.test.tsx`:
  - `"null, NaN e Infinity viram —"`: `KpiStat` com `value={null}`, `NaN` e `Infinity` mostra `—` e nenhum sufixo;
  - `"sufixo só com número finito"`: `value={12.34} suffix="%"` mostra `12.3` e `%`;
  - `"KpiStrip agrupa itens"`: três `KpiStat` dentro de `KpiStrip` renderizam três títulos.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/dashboard/KpiCard.test.tsx`. Esperado: FAIL (`KpiStat` inexistente).
- [x] **Step 3: Implementar** `KpiStat`, `KpiStrip`, o `KpiCard` como composição e os gráficos.
- [x] **Step 4: Rodar e ver passar.** Esperado: PASS.
- [x] **Step 5: Commit:** `git commit -m "feat(dashboard): KpiStat, KpiStrip e gráficos com tokens novos"`.

### Task 8: Cascos e navegação

**Files:**
- Create: `src/components/layouts/BrandMark.tsx`
- Modify:
  - `src/components/layouts/{AdminShell,GestaoLayout,OperacionalLayout,PlatformLayout,SidebarNav,SidebarUnitProfile}.tsx`;
  - `src/components/PageHeader.tsx`, `src/components/ThemeToggle.tsx`.
- Test: `src/components/layouts/AdminShell.test.tsx`

**Interfaces:**
- Produces: `BrandMark({ collapsed }: { collapsed?: boolean })`, com o orbe champanhe (`radial-gradient` de `--gold-ink` para `--gold`) e o nome do produto que o casco mostra hoje. Quando `collapsed`, mostra só o orbe.

Alvos (mockup `Main.dc.html`, sidebar e topo):
- **AdminShell:**
  - área principal com `ambient`;
  - barra do topo em `glass` (já está na lista de desfoque);
  - sidebar em `bg-sidebar` (fundo profundo);
  - contrato inteiro mantido: `admin-sidebar-collapsed`, gaveta abaixo de `lg` com backdrop e prop `sidebar`.
- **SidebarNav:** item `rounded-item`; ativo `bg-sidebar-accent text-sidebar-accent-foreground` com um traço champanhe de 2 px à esquerda; mesmo agrupamento de menu.
- **SidebarUnitProfile:** seletor em `surface rounded-block` que **continua mostrando a capa e o logo da unidade**.
- **PageHeader:** título `text-[28px] sm:text-[30px] font-semibold tracking-[-0.02em]`, descrição em `text-muted-foreground`.
- **ThemeToggle:** botão em cápsula `coarse:h-11 coarse:w-11`.

- [x] **Step 1: Escrever o teste que falha** em `AdminShell.test.tsx`:
  - `"recolher a sidebar persiste em admin-sidebar-collapsed"`: renderiza `AdminShell` com `sidebar={<nav>menu</nav>}` dentro de `MemoryRouter` e do `RouteThemeProvider`; clica no botão de recolher (pelo `aria-label` atual) e confere `localStorage.getItem("admin-sidebar-collapsed") === "true"`;
  - `"área principal tem fundo ambiente"`: o contêiner do conteúdo tem a classe `ambient`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/layouts/AdminShell.test.tsx`. Esperado: o primeiro teste PASS (o contrato já existe) e o segundo FAIL.
- [x] **Step 3: Implementar** `BrandMark` e restilizar os cascos.
- [x] **Step 4: Rodar e ver passar.** O teste, `src/components/layouts/platform-nav.test.ts` e `npm run test`. Esperado: PASS.
- [x] **Step 5: Commit:** `git commit -m "feat(cascos): sidebar, topo e seletor de unidade em vidro"`.

**Fechamento da fase A2.** Revisão visual nos dois temas:
- `/g/:slug/clientes` (tabela);
- `/g/:slug/configuracoes` (formulários e abas);
- `/o/:slug` (lista);
- um Dialog e um ResponsiveDialog em 390 px;
- a gaveta mobile do casco.

---

## Fase A3 — Dashboard da Gestão

### Task 9: Núcleo das chegadas de hoje

**Files:**
- Create: `src/lib/arrivals-today.ts`
- Test: `src/lib/arrivals-today.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ArrivalInput { id: string; time: string | null; status: ReservaStatus; party_size: number }
export interface ArrivalHour { hour: number; label: string; reservations: number; guests: number; isPeak: boolean }
export function buildArrivalsByHour(reservas: ArrivalInput[], range: { min: number; max: number }): ArrivalHour[]
export function arrivalsSentence(hours: ArrivalHour[]): string | null
export function upcomingArrivals<T extends ArrivalInput>(reservas: T[], nowHHMM: string, limit?: number): T[]
```

Regras:
- **Quem conta:** só `pending` e `confirmed`, a mesma regra de "Pessoas esperadas hoje" do `frontend.md`.
- **Faixa:** de `range.min` a `range.max`, estendida para cobrir a hora de qualquer reserva contada fora dela.
- **Rótulo:** `${hour}h`, sem zero à esquerda.
- **Pico:** `isPeak` quando `reservations === max` e `max > 0`.
- **Frase:**
  - `null` se `max === 0`;
  - um pico: `Pico às 20h, com 14 reservas` (`1 reserva` no singular);
  - dois picos: `Pico às 19h e 20h, com 6 reservas cada`;
  - três ou mais: `Pico às 18h, 19h e 20h, com 6 reservas cada`.
- **Próximas chegadas** (`upcomingArrivals`): só `pending` e `confirmed` com `time.slice(0, 5) >= nowHHMM`, ordenadas por horário crescente, limite padrão 5.

- [x] **Step 1: Escrever os testes que falham** em `arrivals-today.test.ts`:
  - `"conta só pendente e confirmada"`: 20:00 confirmed (4 pessoas), 20:15 pending (2), 20:30 cancelled (6) e 20:45 no_show (3), faixa 18–22. A hora 20 tem `reservations: 2, guests: 6`.
  - `"estende a faixa para reserva fora do horário"`: uma confirmed às `23:30:00` com faixa 18–22. Existe item `hour: 23, label: "23h", reservations: 1`, e o resultado vai de 18 a 23 sem buracos.
  - `"dia vazio não tem pico nem frase"`: lista vazia ou só canceladas. Todo `isPeak === false` e `arrivalsSentence` devolve `null`.
  - `"frase com um pico"`: 14 reservas às 20h e menos nas outras horas, frase `"Pico às 20h, com 14 reservas"`. Com 1 reserva no pico: `"Pico às 20h, com 1 reserva"`.
  - `"frase com empate"`: 6 às 19h e 6 às 20h dão `"Pico às 19h e 20h, com 6 reservas cada"`. Com 18, 19 e 20h empatadas: `"Pico às 18h, 19h e 20h, com 6 reservas cada"`.
  - `"próximas chegadas"`: com `nowHHMM = "19:40"`, 19:30 confirmed fica fora, 19:45 pending entra, 20:00 cancelled fica fora; a ordem é crescente e o limite de 5 é respeitado.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/lib/arrivals-today.test.ts`. Esperado: FAIL.
- [x] **Step 3: Implementar** `arrivals-today.ts`.
- [x] **Step 4: Rodar e ver passar.** Esperado: PASS.
- [x] **Step 5: Commit:** `git add src/lib/arrivals-today.ts src/lib/arrivals-today.test.ts` e depois `git commit -m "feat(dashboard): núcleo das chegadas de hoje"`.

### Task 10: Gráfico 3D de chegadas

**Files:**
- Create: `src/components/dashboard/ArrivalsByHour3D.tsx`
- Test: `src/components/dashboard/ArrivalsByHour3D.test.tsx`

**Interfaces:**
- Consumes: `ArrivalHour` da Task 9.
- Produces: `ArrivalsByHour3D({ hours, className }: { hours: ArrivalHour[]; className?: string })`.

Técnica (copiar a geometria de `Main.dc.html`, bloco das barras):
- cada barra tem três faces em `div`:
  - frente;
  - lateral com `skewY(-45deg)` e `transform-origin: 0 0`;
  - topo com `skewX(-45deg)` e `transform-origin: 0 100%`;
- altura proporcional a `reservations / max`, com mínimo visual de 4 px quando `reservations > 0`;
- barra de pico em `bg-gold` (faces em `gold`, `gold/70` e `gold-ink`); as demais em `foreground` a 10%, 7% e 14%;
- entrada `motion-safe:animate-rise` com `origin-bottom` e `animationDelay` de `index * 60ms`, sem animação fora de `motion-safe`;
- rótulos de hora abaixo, em `text-tertiary tabular`;
- o número de reservas aparece acima das barras de pico.

Acessibilidade:
- o contêiner tem `role="img"` e `aria-label={arrivalsSentence(hours) ?? "Sem chegadas hoje"}`;
- uma `<ul className="sr-only">` traz um `<li>` por hora no formato `20h: 14 reservas, 38 pessoas` (`1 reserva`, `1 pessoa` no singular).

- [x] **Step 1: Escrever o teste que falha:**
  - `"lista acessível por hora"`: com horas 19h (2 reservas, 5 pessoas) e 20h (1 reserva, 1 pessoa), existem os itens `"19h: 2 reservas, 5 pessoas"` e `"20h: 1 reserva, 1 pessoa"`;
  - `"pico marcado"`: a barra de 19h tem `data-peak="true"` e a de 20h, `"false"`;
  - `"animação só com movimento permitido"`: as barras têm a classe `motion-safe:animate-rise` e nenhuma classe `animate-` fora do prefixo `motion-safe:`;
  - `"rótulo do gráfico"`: `getByRole("img")` tem `aria-label` `"Pico às 19h, com 2 reservas"`.
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/dashboard/ArrivalsByHour3D.test.tsx`. Esperado: FAIL.
- [x] **Step 3: Implementar o componente.**
- [x] **Step 4: Rodar e ver passar.** Esperado: PASS.
- [x] **Step 5: Commit:** `git commit -m "feat(dashboard): barras 3D de chegadas por horário"`.

### Task 11: Novo Dashboard

**Files:**
- Create: `src/components/dashboard/DashboardHero.tsx`, `UpcomingArrivalsPanel.tsx`, `ConversationsWaitingPanel.tsx`
- Modify: `src/pages/gestao/Dashboard.tsx`, e `src/lib/glass-usage-guard.test.ts` (inclui `DashboardHero.tsx` na lista)
- Test: `src/components/dashboard/DashboardHero.test.tsx`, `ConversationsWaitingPanel.test.tsx`

**Interfaces:**
- Consumes:
  - Tasks 7, 9 e 10;
  - os hooks atuais `useReservasHoje`, `useReservaStats`, `useUnitHourRange`, `useDashboardMetrics`, `useWalkInStatsToday`, `useWaitlist` e `useConversations(unitId, "awaiting_human")`;
  - `ManualReservaDialog({ open, onOpenChange, unitId, organizationId })`.
- Produces:
  - `DashboardHero({ dateLabel, hours, todayStats, unitSlug, onNewReservation, aside })`:
    - `hours: ArrivalHour[]`;
    - `todayStats?: { total_hoje; confirmadas_hoje; pendentes_hoje; pessoas_hoje }`;
    - `aside: React.ReactNode`, a coluna de próximas chegadas.
  - `UpcomingArrivalsPanel({ reservas, isLoading })`.
  - `ConversationsWaitingPanel({ unitId, unitSlug })`.

**Ordem da página** (mockup `Main.dc.html`):

1. **`DashboardHero`** em `glass rounded-panel`:
   - data por extenso;
   - frase de `arrivalsSentence` como título de destaque (`text-[38px] sm:text-[48px] lg:text-[58px] font-semibold tracking-[-0.045em] leading-[1.02]`, escala de destaque da spec §4.2), ou "Nenhuma reserva para hoje", que também substitui o gráfico quando `max === 0`;
   - ações "Abrir operacional" (link `/o/:unitSlug`) e "Nova reserva" (abre o `ManualReservaDialog`);
   - `ArrivalsByHour3D` com rótulo "Chegadas por horário";
   - `KpiStrip` com os quatro KPIs de hoje;
   - à direita, `UpcomingArrivalsPanel`.
2. **Linha de três painéis:** `ConversationsWaitingPanel`, o card de fila e o card de walk-ins (conteúdo de hoje).
3. **"Reservas de hoje"**, a mesma lista com `ReservaCard showActions` e os mesmos quatro estados.
4. **"Análise do período":**
   - `PeriodFilter`;
   - `KpiStrip` com os seis KPIs do período (`className` com `lg:grid-cols-3`);
   - "Reservas por dia" e "Ocupação por horário" em 2D;
   - "Avaliações no período" e "Últimas avaliações".

**Painéis:**
- **`UpcomingArrivalsPanel`:** `upcomingArrivals(reservas, horaLocalAgora)`. Cada item mostra horário grande `tabular`, nome do cliente, pessoas e pílula `STATUS_COLORS`. Vazio: "Nenhuma chegada prevista daqui para frente".
- **`ConversationsWaitingPanel`:**
  - mostra o número de conversas aguardando resposta e até quatro itens, cada um com nome (`contact_name` ou `customer.name`), "Aguardando atendente" e "há X", via `formatDistanceToNowStrict(new Date(last_message_at), { locale: ptBR })` do `date-fns`, que já está instalado;
  - tem os quatro estados, com erro e "Tentar de novo" (`refetch`);
  - link "Abrir conversas" para `/g/:unitSlug/conversas`.

`horaLocalAgora` é calculada no componente com `new Date()` local, formato `HH:MM`.

- [x] **Step 1: Escrever os testes que falham.**
  - `DashboardHero.test.tsx`:
    - `"mostra frase e ações"`: com horas que dão pico às 20h, aparecem `"Pico às 20h, com 3 reservas"`, um link "Abrir operacional" com `href` `/o/casa` e um botão "Nova reserva" que chama `onNewReservation`;
    - `"dia vazio mostra estado vazio sem gráfico"`: com horas todas zeradas, aparece "Nenhuma reserva para hoje" e não existe `role="img"`.
  - `ConversationsWaitingPanel.test.tsx`, com `vi.mock("@/hooks/useConversations")`:
    - `"carregando"` mostra skeleton;
    - `"erro"` mostra mensagem e "Tentar de novo", que chama `refetch`;
    - `"vazio"` mostra "Nenhuma conversa aguardando resposta";
    - `"lista"` mostra nome e "Aguardando atendente".
- [x] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/dashboard/DashboardHero.test.tsx src/components/dashboard/ConversationsWaitingPanel.test.tsx`. Esperado: FAIL.
- [x] **Step 3: Implementar os três componentes** e reorganizar `Dashboard.tsx` na ordem acima. Nenhum bloco atual sai.
- [x] **Step 4: Rodar e ver passar.** Os testes, o guarda de desfoque e `npm run test`. Esperado: PASS.
- [x] **Step 5: Commit:** `git commit -m "feat(dashboard): painel principal, próximas chegadas e conversas aguardando"`.

**Fechamento da fase A3.** Revisão visual de `/g/:slug` nos dois temas e nos três tamanhos, com e sem reservas no dia. Perfil de desempenho no tablet (DevTools, CPU 4× mais lenta): a entrada das barras sem queda de quadro visível. Registrar no STATE.

---

## Fase A4 — Operacional

### Task 12: Reservas do dia e cartão de reserva

**Files:**
- Modify: `src/components/reserva/ReservaCard.tsx`, `src/pages/operacional/ReservasDia.tsx`
- Test: os testes atuais (`ReservationAutoConfirmActions.test.tsx` e todo `npm run test`)

**Interfaces:**
- Consumes: `STATUS_COLORS` e `surface` (Tasks 5 e 3).

Alvos (mockup `Main.dc.html`, lista "Próximas chegadas", estendido para a lista completa):
- **`ReservaCard`:**
  - em `surface rounded-block`, sem desfoque, porque é item repetido;
  - horário grande à esquerda (`text-2xl font-semibold tabular`), nome, pessoas, salão e observações como hoje, e a pílula de situação;
  - ações com os mesmos botões, as mesmas regras de papel e o mesmo `mutation.variables`;
  - todas as informações atuais continuam.
- **`ReservasDia`:** mesmas listas derivadas e a mesma checagem de vazio pelas listas derivadas; cabeçalho com `PageHeader` novo e botão de nova reserva.

- [ ] **Step 1: Rodar a linha de base.** `npm run test`. Esperado: PASS, para comparar depois.
- [ ] **Step 2: Restilizar** `ReservaCard` e `ReservasDia`.
- [ ] **Step 3: Rodar os testes.** `npm run test`. Esperado: PASS sem alterar asserções de comportamento.
- [ ] **Step 4: Revisão visual** de `/o/:slug` em 1194×834 nos dois temas, com pelo menos 20 reservas. Perfil com CPU 4× ao rolar a lista: sem travamento visível. Registrar no STATE.
- [ ] **Step 5: Commit:** `git commit -m "feat(operacional): reservas do dia com horário grande e pílulas"`.

### Task 13: Demais telas do Operacional

**Files:**
- Modify:
  - `src/pages/operacional/{Fila,Passantes,Agenda,Giftback,Entregas,Conversas}.tsx`;
  - os componentes de `src/components/{giftback,notifications,whatsapp}/` usados por essas telas, só a parte visual.
- Test: os testes atuais

**Interfaces:**
- Consumes: Tasks 3, 5, 6 e 7.

Alvos:
- itens de fila e de walk-in em `surface rounded-block`, com o horário de chegada em `tabular` e a situação em pílula com texto;
- cabeçalhos com `PageHeader`;
- botões de ação em cápsula, com `coarse:h-11`;
- os padrões do `frontend.md` continuam: botão desabilitado por `mutation.variables`, `refetchInterval` ciente da visibilidade e mutation com `{ externalOk, dbOk }`.

- [ ] **Step 1: Restilizar as seis telas.**
- [ ] **Step 2: Rodar os testes.** `npm run test` e `npx vitest run src/lib/glass-usage-guard.test.ts`. Esperado: PASS.
- [ ] **Step 3: Revisão visual** das seis rotas em 1194×834 e 390×844 nos dois temas.
- [ ] **Step 4: Commit:** `git commit -m "feat(operacional): fila, passantes, agenda, giftback, entregas e conversas"`.

**Fechamento da fase A4.** Protocolo padrão.

---

## Fase A5 — Portal público e login

### Task 14: Wizard de reserva

**Files:**
- Create: `src/components/reserva/wizard/summary-line.ts`, `summary-line.test.ts`
- Modify:
  - `src/components/reserva/wizard/{StepDateTimeParty,StepHall,StepGuestInfo,WizardSummary,WizardFooter,WizardSuccess,PartySizeInput}.tsx`;
  - `src/components/reserva/ReservaWizard.tsx`;
  - `src/lib/glass-usage-guard.test.ts` (inclui `WizardFooter.tsx`).
- Test: `summary-line.test.ts`, mais `ReservaWizard.marketing.test.tsx` e `WizardSuccess.auto-confirm.test.tsx` verdes

**Interfaces:**
- Consumes: `useReservaWizardContext()`, sem mudanças.
- Produces: `wizardSummaryLine(input: { party_size?: number | null; date?: string | null; time?: string | null }): string`.

`wizardSummaryLine`:
- partes separadas por ` · `;
- pessoas em `"1 pessoa"` ou `"4 pessoas"`;
- data `YYYY-MM-DD` como `sex, 30/10`, com `format(parseISO(date), "EEE, dd/MM", { locale: ptBR })`;
- horário `HH:MM` (corta segundos);
- partes ausentes são omitidas e entrada vazia devolve `""`.

Alvos (mockup `Portal.dc.html`):
- **Passo 1:** `PartySizeInput` em cápsula, com os botões − e + e o campo de digitar, que já existe e respeita o teto de 50; dias em fichas roláveis na horizontal; horários em grade de 3 a 4 colunas, com horário indisponível riscado e `aria-disabled`.
- **Passo 2:** salões em seletor segmentado.
- **Passo 3, resumo e sucesso:** mesmos campos, `h-12` no mobile, pares em `grid-cols-1 sm:grid-cols-2`, e-mail obrigatório e cópia de bloqueio e fechamento como hoje.
- **`WizardFooter`:** `glass` fixo no rodapé do dialog com `wizardSummaryLine(state)` acima dos botões atuais; respeita `env(safe-area-inset-bottom)`.
- Nada muda em `useReservaWizard.ts` nem em `availability-helpers.ts`.

- [ ] **Step 1: Escrever o teste que falha** em `summary-line.test.ts`:
  - `{ party_size: 4, date: "2026-10-30", time: "20:00:00" }` vira `"4 pessoas · sex, 30/10 · 20:00"` (30/10/2026 é sexta; `EEE` do `ptBR` abrevia sem ponto);
  - `{ party_size: 1 }` vira `"1 pessoa"`;
  - `{}` vira `""`.
- [ ] **Step 2: Rodar e ver falhar.** `npx vitest run src/components/reserva/wizard/summary-line.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar** `summary-line.ts` e restilizar os passos e o rodapé.
- [ ] **Step 4: Rodar e ver passar.** Os testes do wizard, o guarda e `npm run test`. Esperado: PASS.
- [ ] **Step 5: Commit:** `git commit -m "feat(portal): wizard de reserva no visual novo"`.

### Task 15: Páginas públicas

**Files:**
- Modify: `src/pages/{PublicPortal,Index,WidgetPortal,MenuPortal,AcompanharReserva}.tsx`, `src/pages/public/PreferenciasMensagens.tsx` e os componentes de `src/components/{menus,widgets,share,waitlist}/` que essas páginas usam
- Test: os testes atuais (`PreferenciasMensagens.test.tsx`, `WaitlistFormPublic.marketing.test.tsx` e os demais)

Alvos:
- tema Dia, forçado pela Task 4;
- capa do restaurante continua como imagem HTML no topo, sem desfoque, porque é o LCP;
- identidade (logo, nome, cozinha, endereço) num `surface rounded-card` sobreposto à capa;
- CTA "Reservar mesa" em cápsula primária;
- `?mode=embed` continua sem casco;
- `ReservaCard` não entra em página pública;
- o selo do card de unidade em `src/pages/Index.tsx` (hoje com `backdrop-blur`, perto da linha 597) é item repetido: trocar o desfoque por fundo `surface`. Os outros dois desfoques do `Index.tsx`, no topo e na capa, são únicos e ficam.

- [ ] **Step 1: Restilizar as páginas.**
- [ ] **Step 2: Rodar os testes.** `npm run test`. Esperado: PASS.
- [ ] **Step 3: Revisão visual** em 390×844 e 1440×900: `/`, `/r/:slug`, `/r/:slug?mode=embed`, `/r/:slug?action=reservar`, `/w/:slug`, `/m/:slug`, `/acompanhar/:token` e `/preferencias/mensagens/:token`. Fazer isso com o painel em escuro salvo no mesmo navegador: tudo claro.
- [ ] **Step 4: Comparar LCP.** Lighthouse mobile em `/r/:slug` no preview da integração contra produção, com a mesma unidade. Registrar os dois valores no STATE. Se o LCP subir mais de 10%, investigar antes de fechar.
- [ ] **Step 5: Commit:** `git commit -m "feat(portal): páginas públicas no tema Dia"`.

### Task 16: Login e redefinição de senha

**Files:**
- Modify: `src/pages/Auth.tsx`, `src/pages/ResetPassword.tsx` e `src/lib/glass-usage-guard.test.ts` (inclui os dois)
- Test: os testes atuais

Alvos:
- fundo `ambient`;
- painel `glass rounded-panel` centralizado, com largura máxima de 400 px;
- `BrandMark` acima do formulário;
- campos `h-12` no mobile;
- botão primário em cápsula;
- mensagens de erro como hoje.

- [ ] **Step 1: Restilizar as duas páginas.**
- [ ] **Step 2: Rodar os testes.** `npm run test`. Esperado: PASS.
- [ ] **Step 3: Revisão visual** de `/admin/login` e `/reset-password` em 390×844 e 1440×900.
- [ ] **Step 4: Commit:** `git commit -m "feat(auth): login e redefinição em painel de vidro"`.

**Fechamento da fase A5.** Protocolo padrão.

---

## Fase A6 — Varredura, acessibilidade, desempenho e lançamento

### Task 17: Varredura das demais telas

**Files:**
- Modify: telas de `src/pages/gestao/**`, `src/pages/platform/**`, `src/pages/PaymentRequired.tsx` e componentes de `src/components/{gestao,giftback,menus,whatsapp,billing,conta,relatorios,halls,notifications,admin,platform,ai}/**` onde a busca abaixo ou a revisão visual acusar problema.
- Telas que chegaram da `main` depois do plano (merge 4882166) e entram nesta varredura: `/g/:slug/atendimento-ia` (`src/pages/gestao/AtendimentoIa.tsx`), `/platform/agente-ia` (`src/pages/platform/AgenteIa.tsx`), `/o/:slug/whatsapp` (reusa `src/pages/gestao/Whatsapp.tsx`, revisar no casco do Operacional) e `ServiceNoticePreferencesCard`. Antes desta task, mergear a `main` de novo e incluir toda rota nova de `src/App.tsx` (ex.: Instagram em `/platform/integracoes`, se já estiver na `main`).

Busca de cor fixa:

```bash
grep -rnE "#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(bg|text|border|from|to|via)-(white|black|red|green|blue|yellow|amber|orange|emerald|gray|slate|zinc|neutral|stone|rose|purple|sky|indigo)(-[0-9]{2,3})?\b" src --include=*.tsx | grep -v "\.test\."
```

Esperado ao fim: só ocorrências justificadas em comentário (por exemplo, cor de marca de terceiro como o verde do WhatsApp).

- [ ] **Step 1: Rodar a busca** e corrigir cada ocorrência para token.
- [ ] **Step 2: Revisão visual**, nos dois temas e em 1440×900, 1194×834 e 390×844 (critério de pronto da spec §4.10), de cada rota `/g/*` e `/platform/*` listada em `src/App.tsx` e de `PaymentRequired`. Corrigir contraste, quebra e vidro onde faltar. Para não ficar no braço, usar a extensão do Chrome para navegar e fotografar em lote, e anotar no STATE as rotas aprovadas.
- [ ] **Step 3: Rodar os testes.** `npm run test`, `npm run typecheck` e `npm run lint`. Esperado: PASS.
- [ ] **Step 4: Commit** por grupo de telas: `git commit -m "fix(visual): varredura de <grupo> nos dois temas"`.

### Task 18: Acessibilidade

- [ ] **Step 1: Rodar a skill `web-design-guidelines`** sobre `src/components/ui`, `src/components/layouts`, `src/components/dashboard`, `src/components/reserva/wizard`, `src/pages/operacional` e `src/pages/PublicPortal.tsx`.
- [ ] **Step 2: Corrigir cada pendência.** Isso inclui:
  - foco visível em todo elemento interativo;
  - ordem de tabulação na sidebar e no wizard;
  - `aria-label` em botões só de ícone;
  - contraste (`theme-tokens.test.ts` verde).
- [ ] **Step 3: Teste de teclado manual:** login → Dashboard → abrir operacional → abrir uma reserva → fechar dialog, sem mouse, nos dois temas.
- [ ] **Step 4: Commit:** `git commit -m "fix(a11y): pendências da revisão de acessibilidade"`.

### Task 19: Desempenho

- [ ] **Step 1: Medir no tablet**, com DevTools, CPU 4× mais lenta e viewport 1194×834, `/g/:slug` e `/o/:slug` com pelo menos 20 reservas no dia. Sem tarefa longa acima de 200 ms causada por estilo e rolagem fluida. Registrar no STATE.
- [ ] **Step 2: Comparar o LCP mobile de `/r/:slug`** com o valor de produção registrado na Task 15. Sem regressão acima de 10%.
- [ ] **Step 3: Corrigir o que reprovar.** O primeiro corte é reduzir o desfoque ou trocar `glass` por `surface`. Commit `fix(perf): …` se houver mudança.

### Task 20: Lançamento da Parte A

- [ ] **Step 1: Rodar as verificações completas** na branch de integração: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `node scripts/check-padrao.mjs` e `node scripts/check-portabilidade.mjs`.
- [ ] **Step 2: Revisar a branch inteira** (`feat/redesign-salao-em-vidro` contra `main`) com `superpowers:requesting-code-review` no modelo mais capaz. Corrigir os bloqueantes.
- [ ] **Step 3: Checar segredos no diff contra `main`:** `git diff main...feat/redesign-salao-em-vidro | grep -nE "sk-|sk-ant-|xai-|AIza|eyJ|Bearer |service_role|whsec_"` sem resultado. Também `git diff --stat main...feat/redesign-salao-em-vidro -- supabase/` vazio, que prova que a Parte A não tocou backend.
- [ ] **Step 4: Pedir ao dono a revisão final** no preview da Vercel e a autorização para publicar.
- [ ] **Step 5: Publicar com autorização:**
  - `gh pr create --base main --head feat/redesign-salao-em-vidro`, com o resumo das seis fases e o rodapé de atribuição;
  - merge após os checks verdes;
  - conferir o deploy de produção da Vercel em READY.
- [ ] **Step 6: Fechar a mudança:**
  - STATE em "concluído";
  - memória do projeto atualizada (Parte A em produção, próximo passo: plano da Parte B);
  - checkboxes deste plano marcados.

---

## Parte B — próxima etapa

Depois que a Parte A estiver em produção, abrir um chat novo para escrever o plano da Parte B com `superpowers:writing-plans`:
- arquivo `docs/superpowers/plans/<data>-planta-do-salao.md`, slug `planta-do-salao`;
- base: a spec §5 e as decisões 4 e 5 da §3.

Ele fica para depois por dois motivos:
- usa os componentes e nomes que a Parte A deixar em produção;
- precisa do estado do banco no momento: outras frentes, como Instagram e WhatsApp, estão criando migrations em paralelo.

Esboço de fases já aprovado na spec:
- **B1 Banco:** layout das mesas, dimensões do salão, chegada e liberação da reserva, trigger de papel, RLS, grants e pgTAP.
- **B2 Editor da planta.**
- **B3 Salão ao vivo em 3D com as ações essenciais.**
- **B4 Integração:** botões e situações derivadas nas listas, QA e liberação.

Gates do `saas-shield-br` antes de qualquer merge da Parte B: `migration-validator`, `rls-auditor`, `tenant-isolation-auditor` e `identity-access-auditor`, mais o check `acl-estatico`.
