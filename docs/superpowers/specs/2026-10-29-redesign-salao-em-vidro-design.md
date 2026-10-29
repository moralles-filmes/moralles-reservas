# Redesign "Salão em vidro" e Planta do salão — design

- **Data:** 2026-10-29
- **Status:** aprovada pelo dono em 2026-10-29
- **Mockups aprovados:** canvas "Redesign Moralles Reservas" (claude.ai/artifact/8VBGDYihJB1ui8zBeJihpp), com quatro quadros: Gestão › Dashboard (escuro, alterna para claro), Operacional › Salão ao vivo (tablet), Portal público › Reservar (celular, claro) e Sistema visual.

## 1. Intenção

O dono quer trocar o visual do sistema inteiro por algo premium, no estilo Apple, futurista e com efeitos 3D, sem perder o que funciona. A direção aprovada se chama **"Salão em vidro"**: painéis de vidro fosco sobre um fundo grafite ("Noite") ou pérola ("Dia"), um único acento champanhe, que evolui o dourado atual, e 3D apenas onde a informação é espacial (ocupação por horário e planta do salão).

O redesign tem duas partes, nesta ordem:

- **Parte A — Redesign visual.** Só frontend: tokens, tipografia, componentes, cascos e telas. Não muda dado, regra nem backend.
- **Parte B — Planta do salão.** Funcionalidade nova: editor da planta na Gestão e visão ao vivo em 3D no Operacional. Mexe no banco e passa pelos gates de segurança.

A Parte B depende do sistema visual da Parte A, por isso vem depois.

## 2. Objetivos, não objetivos e antiobjetivos

**Objetivos**

- Visual novo coerente em todas as áreas: Gestão (`/g`), Operacional (`/o`), Plataforma (`/platform`), portal público (`/r`, `/w`, `/m`, `/acompanhar`, `/preferencias`) e login.
- Temas claro e escuro completos, com o mesmo nível de acabamento.
- Telas-chave redesenhadas como nos mockups: Dashboard da Gestão, Reservas do dia no Operacional, portal público com wizard de reserva e login.
- Planta do salão editável e visão ao vivo das mesas em 3D, com ações por mesa.
- Desempenho real em tablet intermediário e celular, AA de contraste, teclado e `prefers-reduced-motion`.

**Não objetivos**

- Funcionalidades que aparecem nos mockups mas não existem hoje: busca global com ⌘K, central de notificações (sino) e a métrica "conversas resolvidas sem ajuda" do agente. O redesign mostra só elementos ligados a dados e ações que já existem. Essas três ideias ficam registradas como evolução futura.
- Mudar regra de negócio, hooks de dados, Edge Functions ou automações na Parte A.
- Personalização de cores por restaurante (não existe hoje e continua fora).
- "Pessoas presentes no salão versus capacidade" na Parte A (ver §4.7). Isso só fica possível com a Parte B.
- Na planta ao vivo: trocar a mesa de uma reserva e bloquear uma mesa individual. Ficam como evolução depois da Parte B.

**Antiobjetivos (fracasso mesmo que "funcione")**

- Efeito que trava o tablet do salão no meio do serviço ou deixa a lista de reservas lenta.
- Vidro que derruba o contraste e deixa texto difícil de ler.
- Esquecer um tema: tela linda no escuro e quebrada no claro, ou o contrário.
- 3D decorativo espalhado pelo sistema. O 3D aparece só no gráfico de horário e na planta.
- Regressão funcional escondida atrás da troca visual (botão sumido, estado de erro sem tratamento, layout mobile quebrado).

## 3. O que o dono decidiu

1. Aprovou a direção visual dos quatro quadros, incluindo o tema claro, que viu pelo botão de alternância do Dashboard.
2. Quer implementar a planta do salão (Parte B).
3. O plano usa as skills do **padrão SaaS** (`padrao-saas:mudanca`, e `padrao-saas:novo-modulo` se algo virar submódulo) e de **construção de SaaS** (`saas-builder-br:*`), sempre **em fases, um chat por fase**.
4. **Chegada e saída por botões, sem liberação automática.** A equipe toca "Chegou" e "Liberar mesa". A mesa só fica livre quando alguém libera. Passada a duração prevista, ela continua ocupada, com o aviso "passou do tempo".
5. **Ações essenciais na primeira versão da planta ao vivo.** Trocar mesa e bloquear mesa individual ficam para depois.
6. **Parte A entra em produção de uma vez.** As fases vão para uma branch de integração, o dono acompanha pelo preview da Vercel e a produção recebe o visual novo inteiro ao fim da A7.

## 4. Parte A — Redesign visual

### 4.1 Tokens de cor

Os nomes das variáveis CSS atuais continuam os mesmos (`--background`, `--card`, `--primary`, `--gold`, `--sidebar-*`, `--chart-*` etc.). Só os valores mudam. Assim os componentes shadcn e as telas que já usam tokens trocam de visual sem reescrita. Os quatro escopos atuais de [src/index.css](../../../src/index.css) continuam: `:root`, `.theme-admin`, `.dark` e `.dark .theme-admin`.

**Noite (escuro)**

| Papel | Valor |
|---|---|
| Fundo | `#0B0D11` |
| Fundo profundo (sidebar) | `#08090C` |
| Vidro (card) | branco a 4,5% sobre o fundo; versão sólida equivalente `#14161B` onde não houver desfoque |
| Vidro destacado | branco a 10% |
| Borda | branco a 8% |
| Brilho interno do topo | branco a 11% |
| Texto | `#F3F1EC` |
| Texto de apoio | `#B0ADA7` |
| Texto terciário | `#8E8B86` |
| Acento champanhe (`--gold`, `--ring`, item ativo) | `#E2C48A`, texto em champanhe `#E8CC93` |
| Botão primário | fundo `#E2C48A`, texto `#1A1408` |

**Dia (claro)**

| Papel | Valor |
|---|---|
| Fundo | `#EDEFF2` |
| Vidro (card) | branco a 68%; sólido `#FFFFFF` |
| Borda | `#101218` a 8% |
| Texto | `#111318` |
| Texto de apoio | `#4F545C` |
| Texto terciário | `#5E636B` |
| Acento champanhe | `#9A7434` para foco e preenchimento; `#7A5A20` para texto |
| Botão primário | fundo `#111318`, texto `#F6F4EF` |

**Cores de situação (novos tokens `--status-*`)**, usadas em pílulas, legendas e na planta:

| Situação | Noite | Dia (texto/borda) |
|---|---|---|
| Livre | branco a 30% | `#4F545C` |
| Reservada / Confirmada | `#E2C48A` | `#7A5A20` |
| Chegando | `#9EC1FF` | `#2F62B8` |
| Ocupada / Sentada | `#7ED8B0` | `#1F7A56` |
| Atrasada | `#FF9478` | `#B4442A` |
| Pendente | branco a 70% | `#4F545C` |

Cada situação sempre leva texto ou ícone além da cor (as cores têm luminosidade parecida). Os tokens de gráfico `--chart-*` são recalibrados para a nova paleta, mantendo os nomes.

**Na Parte A, as pílulas mostram só a situação gravada** (Pendente, Confirmada, Cancelada, Não compareceu). "Chegando", "Atrasada" e "Sentada" dependem do registro de chegada, que só nasce na Parte B. Derivar "Atrasada" só pelo relógio marcaria como atrasado quem já sentou. Os tokens das cinco cores nascem na A1; as situações derivadas entram nas listas do Operacional e do Dashboard na B4.

### 4.2 Tipografia

- **Geist** (variável, 300 a 700) substitui a Plus Jakarta Sans no `tailwind.config.ts` (`sans` e `display`) e no `index.html`.
- Escala: destaque de 38 a 58 px, seminegrito, espaçamento −4,5%; título de 18 a 30 px, seminegrito; texto de 14 a 16 px, regular, entrelinha 1,5; legenda de 12 a 13 px.
- Números sempre tabulares (`font-variant-numeric: tabular-nums`) em horários, contagens e valores.

### 4.3 Materiais e profundidade

- **Receita do vidro:** fundo translúcido (4,5% no escuro, 68% no claro), borda de 1 px, brilho interno no topo, `backdrop-filter: blur(28px) saturate(150%)`, sombra longa e suave abaixo.
- **Raios por hierarquia, não um raio único:** 28 a 32 px no painel principal, 24 px em cards, 16 a 18 px em blocos internos, 12 a 14 px em itens de lista e nav, e cápsula em botões, pílulas e seletores.
- Três níveis de profundidade: fundo, painel e destaque.
- Implementação em utilitários Tailwind (ex.: `glass`, `glass-strong`, `shadow-depth-*`), nunca cor fixa em componente.
- **Fallback de desempenho:** `@supports not (backdrop-filter: ...)` e `prefers-reduced-transparency` usam a versão sólida do vidro. Em telas pequenas o desfoque é menor.

### 4.4 Movimento

- Um único momento orquestrado por tela, por exemplo as barras do gráfico subindo em sequência no Dashboard. Entradas de 0,9 a 1,6 s com curva `cubic-bezier(0.16, 1, 0.3, 1)`.
- Resposta ao toque de 200 a 350 ms, só em `transform` e `opacity`.
- Pulsos de luz apenas para estado vivo (serviço em andamento, mesa chegando ou atrasada).
- `prefers-reduced-motion: reduce` remove entradas e pulsos, e o estado final aparece direto.
- **Sem biblioteca de animação nova na Parte A** (decisão do builder, ver §8): CSS + `tailwindcss-animate`, que já estão instalados.

### 4.5 Componentes base (`src/components/ui`)

São restilizados mantendo a API atual (props e variantes), para não quebrar quem usa:

- **Button:** variante primária (champanhe no escuro, tinta no claro), vidro, fantasma e destrutiva. Altura mínima de 44 px em toque.
- **Card:** vira vidro. Inclui `KpiCard` e `ChartCard`.
- **Input, Select, Textarea e campo de busca:** cápsula translúcida, com foco em anel champanhe.
- **Tabs e seletor segmentado:** cápsula com indicador em vidro destacado.
- **Badge/pílula de situação:** usa os tokens `--status-*`.
- **Dialog, Sheet, ResponsiveDialog, Popover e DropdownMenu:** vidro destacado. O `ResponsiveDialog` mantém o bottom-sheet abaixo de 640 px e a safe-area.
- **Table, Skeleton e Toast (Sonner):** paleta nova.

### 4.6 Cascos

- `AdminShell` mantém o contrato inteiro: colapso no desktop persistido em `admin-sidebar-collapsed`, gaveta mobile com backdrop abaixo de `lg` e prop `sidebar`.
- `GestaoLayout`, `OperacionalLayout` e `PlatformLayout`: sidebar no fundo profundo, itens com estado ativo em champanhe translúcido e o mesmo agrupamento de menu de hoje.
- `SidebarUnitProfile` vira o seletor de unidade em vidro, como no mockup, e **continua mostrando a capa e o logo enviados pelo restaurante**. O orbe champanhe é a marca do produto, não substitui a identidade da unidade.
- `PageHeader` segue a nova escala tipográfica.

### 4.7 Telas com redesenho dedicado

1. **Gestão › Dashboard** ([src/pages/gestao/Dashboard.tsx](../../../src/pages/gestao/Dashboard.tsx)):
   - O bloco "hoje" vira o painel principal, com data, uma frase-resumo (ex.: "Pico às 20h, com 14 reservas") e ações "Abrir operacional" e "Nova reserva".
   - **As barras 3D do painel principal mostram as chegadas de hoje por horário**, calculadas no frontend a partir das reservas de hoje que a tela já carrega (`useReservasHoje`), com as mesmas situações que a lista "Reservas de hoje" exibe. A frase-resumo sai da mesma conta, então barras e frase nunca discordam. A conta fica numa função pura testada. As horas de pico ficam acesas em champanhe.
   - Os gráficos do período ("Ocupação por horário", que usa `byHour` de [useDashboardMetrics.ts](../../../src/hooks/useDashboardMetrics.ts) e conta reservas por hora de chegada no período, e "Reservas por dia") continuam na área de análise, abaixo do seletor de período, restilizados em 2D.
   - **Nenhum bloco atual some.** Os KPIs (incluindo Cancelamento, Tamanho médio do grupo e Avaliação média) passam para uma faixa de vidro com divisórias, quebrando em duas linhas se preciso. "Avaliações no período", "Últimas avaliações", os cards de Fila e Walk-ins e a lista "Reservas de hoje" com ações (`ReservaCard showActions`) continuam, restilizados. A ordem dos blocos segue o mockup; o que o mockup não mostra entra abaixo.
   - "Próximas chegadas" usa as reservas de hoje.
   - **O painel de conversas mostra nome, situação e há quanto tempo a conversa espera** (`last_message_at`). Prévia do texto da mensagem fica fora: o texto vive em `messages` (jsonb) e carregá-lo exigiria backend novo.
   - As regras de métricas de [frontend.md](../../../.claude/rules/frontend.md) (taxas, "—" para nulo, datas locais) não mudam.
2. **Operacional › Reservas do dia, Fila, Walk-ins, Calendário, Giftback, Entregas e Conversas:** casco e componentes novos. Reservas do dia ganha o layout de lista com horário grande e pílula de situação. A visão 3D do salão é da Parte B.
3. **Portal público** (`/`, `/r/:slug`, `/w/:slug`, `?mode=embed`, `/m/:slug`, `/acompanhar/:token`, `/preferencias/...`): sempre no tema **Dia**, independentemente do tema escolhido no painel. O embed continua sem casco.
   - **O wizard mantém os três passos e o `ResponsiveDialog` de hoje** (`useReservaWizard`, `partitionHalls` e o schema não mudam). O mockup mostrou tudo numa tela só; o que se aproveita dele é o visual de cada peça:
     - Passo 1: seletor de pessoas, dia em fichas e horário em grade. O seletor de pessoas respeita o teto do schema (50), com campo para digitar acima de 12.
     - Passo 2: ambiente em seletor segmentado.
     - Passo 3, resumo e sucesso: mesmos campos de hoje, no mesmo vidro e tipografia.
     - Barra fixa no rodapé do dialog com o resumo da escolha e o botão de avançar.
   - Mantém os inputs `h-12` no mobile, a cópia de bloqueio/fechamento e o e-mail obrigatório.
4. **Login e redefinição de senha:** tema Dia, painel de vidro centralizado.
5. **`PaymentRequired` e `/platform`** seguem o tema do painel (escuro por padrão), porque quem os vê é usuário do painel.

Todas as outras telas (Gestão, Plataforma e configurações) herdam o visual pelos tokens e componentes. Uma fase de varredura corrige cores fixas, contrastes e quebras em cada tema.

### 4.8 Tema

- O `next-themes` continua como está (`attribute="class"`, sistema desligado).
- **Padrão novo:** os painéis abrem no **escuro** para quem nunca escolheu tema. Quem já escolheu mantém a escolha salva.
- O portal público e o login forçam o tema claro sem alterar a escolha salva do painel. **Técnica:** o `forcedTheme` do `next-themes`, calculado pela rota. Um wrapper de escopo não serviria: Dialog, Popover e Sonner renderizam no `body`, fora dele, e o `ResponsiveDialog` do wizard ficaria escuro. Isso pode exigir pôr o `ThemeProvider` dentro do roteador.
- O botão de tema dos painéis continua no casco.

### 4.9 Restrições da Parte A

- Nenhuma mudança em hook de dados, query key, mutation, Edge Function, migration ou RLS.
- Valem todas as regras de [.claude/rules/frontend.md](../../../.claude/rules/frontend.md): tokens sempre (nunca cor fixa), `viewport-fit=cover`, pares de input `grid-cols-1 sm:grid-cols-2`, quatro estados de lista (carregando, erro, vazio, lista), `ReservaCard` fora de página pública e `cn()`.
- A seção "Tema visual" de `frontend.md` está desatualizada (descreve laranja+bege e navy; o CSS atual é preto, branco e dourado). Ela é reescrita para o novo sistema na primeira fase.
- Baseline: `npm run typecheck`, `npm run lint`, `npm run test` e `npm run build` verdes ao fim de cada fase.

### 4.10 Pronto quando (Parte A)

- Todas as rotas listadas em §2 revisadas nos dois temas, em desktop (1440), tablet (1194×834) e celular (390).
- Revisão com a skill `web-design-guidelines` sem pendência de acessibilidade.
- Dashboard e Reservas do dia sem queda perceptível de desempenho no tablet (perfil com CPU 4× mais lenta). Sem queda de LCP no portal público.
- Testes existentes verdes. Teste novo onde houver lógica nova (ex.: a frase-resumo do Dashboard e o cálculo das horas de pico).

## 5. Parte B — Planta do salão

### 5.1 O que é

- **Editor da planta** em Gestão › Reservas › Salões › [salão]: arrastar mesas sobre uma grade, definir forma (redonda, quadrada, retangular), tamanho e rotação, e marcar a entrada e as paredes com janela. Quem edita: owner e gerente.
- **Salão ao vivo** no Operacional, em rota nova (proposta `/o/:unitSlug/salao`, com item de menu): planta em 3D com cada mesa acesa pela situação. Ao tocar numa mesa, um painel lateral mostra a reserva ou walk-in e as ações. Quem vê: todos os papéis da unidade e o `platform_admin`.
- Seletor de ambiente (um salão por vez), legenda com contagens, lista de próximas chegadas e resumo da fila, como no mockup.
- **Ações por mesa (primeira versão):**
  - ver a reserva ou o walk-in;
  - marcar chegada;
  - liberar mesa;
  - sentar um walk-in ou um cliente da fila numa mesa livre;
  - chamar da fila, com o aviso de mesa pronta que já existe;
  - abrir a conversa do cliente em Conversas.
- As ações do mockup "Trocar mesa", "Bloquear mesa" e "Avisar no WhatsApp" (mensagem avulsa) não entram.
- Notas do cliente no painel lateral (visitas, saldo de giftback) aparecem só se vierem de dados que já existem; senão são omitidas.

### 5.2 Dados que já existem

- `tables` (`id`, `unit_id`, `hall_id`, `number`, `capacity`, `min_capacity`, `max_capacity`, `location`, `active`).
- `reservations.table_id`, atribuído automaticamente pelo `create-reservation`.
- `walk_ins.table_id` com `status` (`waiting`, `seated`, `left`, `no_show`), `arrived_at` e `seated_at`. Não existe `finished_at`: o fim do atendimento de um walk-in é a mudança para `left`.
- `waitlist` com `seated_at`.
- `table_blocks` (bloqueios por mesa ou macro).

### 5.3 O que falta

- **Posição das mesas:** colunas novas de layout em `tables` (ex.: posição x/y, largura/altura, rotação e forma), anuláveis. Mesa sem posição aparece numa grade automática até ser posicionada.
- **Dimensões da planta por salão** em `halls` (largura/profundidade) e marcadores simples de entrada e janelas.
- **Chegada e saída da reserva:** hoje a reserva só tem `pending`, `confirmed`, `cancelled` e `no_show`, e nada registra que o cliente sentou ou liberou a mesa.
  - **Decisão do dono:** dois registros de horário na reserva (chegada e liberação), gravados pelos botões "Chegou" e "Liberar mesa" na planta ao vivo e em Reservas do dia.
  - Não existe liberação automática.
  - A situação gravada (`status`) não muda. Chegada e liberação são fatos à parte, então automações, métricas e a regra "operador não cancela" continuam iguais.
  - A escrita passa por função com guard de unidade e é permitida a todos os papéis.

### 5.4 Situação de cada mesa (derivada, nunca gravada)

Calculada no horário local (BRT) a partir de reservas do dia, walk-ins sentados e bloqueios:

| Situação | Regra |
|---|---|
| Bloqueada | há `table_blocks` vigente para a mesa ou o salão |
| Ocupada | walk-in com `status = 'seated'`, ou reserva com chegada registrada e sem liberação. Passada a duração da reserva (`settings.reservation_duration_minutes`), continua Ocupada com o aviso "passou do tempo" |
| Atrasada | reserva `confirmed`/`pending` cujo horário passou, sem chegada registrada, mostrando há quantos minutos |
| Chegando | reserva `confirmed` com horário nos próximos 15 minutos |
| Reservada | reserva `confirmed`/`pending` mais tarde hoje |
| Livre | nenhuma das anteriores |

- A ordem da tabela é a prioridade: a primeira regra que casa vence.
- Mesa com várias reservas no dia mostra a que está em curso (ocupada ou atrasada) ou, se nenhuma estiver, a próxima.
- A regra fica numa função pura testada (como `date-range-draft-core.ts`), não espalhada em componentes.

### 5.5 Técnica de renderização (decisão do builder, ver §8)

- **CSS 3D com elementos DOM reais** (`perspective`, `transform-style: preserve-3d`), como no mockup, e **não WebGL/Three.js**. Assim cada mesa é um `<button>` acessível por teclado e leitor de tela, nenhuma biblioteca pesada entra no bundle e o tablet roda bem.
- Fallback para planta 2D vista de cima com `prefers-reduced-motion`, em telas abaixo de 640 px ou se o 3D falhar.
- Atualização com `refetchInterval` ciente da visibilidade da aba (padrão do painel operacional) e invalidação após cada ação.

### 5.6 Segurança e tenancy

- A mesa já tem `unit_id`. Toda escrita de layout valida a mesa contra a unidade pela sessão e pela membership, com o paralelo `app_private.is_platform_admin`, recusa `42501` e sem oráculo de existência.
- Editar layout: owner e gerente. Marcar chegada ou liberar mesa: todos os papéis, incluindo operador; isso não é cancelamento, então a regra "operador não cancela" continua intacta.
- **Como a restrição de papel vale no banco:** hoje `tables` e `halls` têm a política `unit_member_all_*` (`for all`, qualquer membro). A Parte B não aperta essa política, para não quebrar fluxos atuais. As colunas novas de layout ganham um trigger que recusa a mudança (`42501`) quando quem grava não é owner nem gerente da unidade, com o paralelo `is_platform_admin`, no mesmo molde do trigger que impede o operador de cancelar.
- **Achado fora do escopo, a reportar:** pela mesma política, um operador já consegue alterar hoje, direto pela API, capacidade e outros dados de mesas e salões, o que o AGENTS §7 reserva a gerente. A Parte B não corrige isso; fica como item separado.
- Função nova revoga `EXECUTE` de `public, anon, authenticated`. Escrita com predicado de tenant confere linhas afetadas. Colunas novas nascem invisíveis para anon.
- Gates antes de merge: `saas-shield-br:migration-validator`, `rls-auditor`, `tenant-isolation-auditor` e `identity-access-auditor`, mais o check `acl-estatico`.

### 5.7 Pronto quando (Parte B)

- Owner ou gerente posiciona as mesas de um salão e a planta aparece igual no Operacional.
- Operador vê a situação de cada mesa coerente com reservas, walk-ins e bloqueios, e executa as ações sem erro.
- Testes de banco de isolamento entre unidades e por papel, e teste unitário da função de situação.
- Desempenho fluido no tablet com 40 mesas.

## 6. Como construir (para o plano)

- **Fluxo do AGENTS §4:** esta spec aprovada → plano em `docs/superpowers/plans/` → execução com review por tarefa e review da branch.
- **Branches e entrada em produção (decisão do dono):**
  - A Parte A vive numa branch de integração criada a partir de `main`. Cada fase trabalha numa branch própria e, aprovada a revisão, entra na de integração. O dono acompanha pelo preview da Vercel.
  - O merge da integração em `main`, que publica o visual novo, acontece só ao fim da A7, com autorização explícita do dono.
  - A Parte B começa depois, a partir de `main` já com a Parte A. Segue o mesmo modelo e só faz merge após os gates de §5.6.
- **Mockups no repositório:** o código-fonte dos quatro quadros fica em [2026-10-29-redesign-salao-em-vidro/](2026-10-29-redesign-salao-em-vidro/), para que cada chat de fase o leia sem depender do canvas privado. Onde a spec silencia (colunas, espaçamentos, ordem de elementos), o mockup é a referência. Onde os dois divergem, vale a spec.
- **Fases curtas pelo `padrao-saas:mudanca`:** cada fase com objetivo, arquivos, verificação e critério de saída. O estado de execução fica em `.tasks/<slug>/STATE.md`, atualizado ao fim de cada fase. **Um chat por fase**, retomando pelo estado em disco.
- **Especialistas `saas-builder-br`:** `design-ux` para tokens, componentes e acessibilidade; `frontend-react` para telas e rotas; `db-schema-designer` para as migrations da Parte B; `qa-testes` para os testes. Gates do `saas-shield-br` onde §5.6 pede.
- **Esboço de fases** (o plano detalha e pode reordenar):
  - A1 Fundação: tokens, fonte, utilitários de vidro/profundidade/movimento, padrão de tema e reescrita da seção "Tema visual" de `frontend.md`.
  - A2 Componentes base.
  - A3 Cascos e navegação.
  - A4 Dashboard da Gestão.
  - A5 Operacional.
  - A6 Portal público, wizard, widget/embed, acompanhar e login.
  - A7 Varredura das demais telas nos dois temas, revisão de acessibilidade e de desempenho.
  - B1 Banco: colunas de layout, chegada/saída, RLS, grants e testes.
  - B2 Editor da planta.
  - B3 Salão ao vivo em 3D com ações.
  - B4 Integração: botões "Chegou" e "Liberar mesa" em Reservas do dia, situações derivadas ("Chegando", "Atrasada", "Sentada") nas listas do Operacional e do Dashboard, QA e liberação.

## 7. Perguntas abertas para o dono

Nenhuma. As três que existiam foram respondidas e estão em §3, itens 4 a 6.

## 8. Decisões do builder (registradas para revisão)

- Manter os nomes das variáveis CSS e trocar só os valores (§4.1).
- Geist como única família tipográfica (§4.2).
- Nenhuma biblioteca de animação ou 3D nova; CSS 3D na planta e no gráfico (§4.4, §5.5).
- Funcionalidades novas vistas no mockup (busca ⌘K, notificações, métrica do agente) ficam fora (§2).
- Painéis no escuro por padrão para quem nunca escolheu; portal e login sempre claros (§4.8).
- O gráfico por horário continua contando reservas por hora de chegada (§4.7).
- Rota nova `/o/:unitSlug/salao` para o Salão ao vivo (§5.1).
- Situação da mesa derivada por função pura, nunca gravada (§5.4).
- Na Parte A, pílulas só com a situação gravada; "Chegando" e "Atrasada" entram na B4 (§4.1).
- Barras 3D e frase-resumo do Dashboard calculadas sobre as reservas de hoje; os gráficos do período continuam em 2D na área de análise (§4.7).
- Nenhum bloco atual do Dashboard sai; o painel de conversas fica sem prévia de texto (§4.7).
- Wizard público mantém três passos e dialog, só com o visual novo; teto de 50 pessoas (§4.7).
- Tema claro forçado por `forcedTheme` na rota; `/` é portal (claro), `PaymentRequired` e `/platform` seguem o painel (§4.7, §4.8).
- Seletor de unidade mantém capa e logo do restaurante (§4.6).
- Restrição de layout a owner/gerente por trigger nas colunas novas, sem mexer na política atual (§5.6).
- Mockups copiados para o repositório como referência (§6).

## 9. Deixado para quem executa

- Nomes exatos de utilitários Tailwind, colunas e funções.
- Distribuição de arquivos por fase dentro do esboço de §6.
- Hospedagem da fonte: Google Fonts, como hoje, ou auto-hospedada via pacote npm. Preferir auto-hospedagem se não houver impedimento de CSP ou build.
- Detalhes do editor de planta (grade de encaixe, atalhos), desde que funcione por toque e mouse.
