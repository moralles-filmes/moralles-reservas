# Salão ao vivo v2 — fila pelo salão, mover/zoom, todos os salões e tela cheia

Data: 2026-11-04 · Slug: `planta-ao-vivo-v2` · Branch: `feat/planta-ao-vivo-v2` (de `origin/main` 987b3a0)

## Pedido do dono

1. O atendente põe pessoas na fila de espera pelo Salão ao vivo, com o mesmo diálogo da tela Fila de espera. É um caminho alternativo: a entrada cai no módulo Fila de espera e segue o mesmo fluxo, como se tivesse sido feita lá.
2. Mover a tela dentro do salão, tanto no editor da planta (Gestão) quanto no painel operacional.
3. No Salão ao vivo, escolher entre ver todos os salões juntos ou um salão individual.
4. Tela cheia no Salão ao vivo, "como assistir um filme", mantendo ao lado o painel de informações: mesa, sentar passante e da fila, próximas chegadas, fila de espera e o novo "Adicionar à fila".

## Decisões do dono (2026-11-04)

- Mover a tela inclui **pan e zoom**: arrastar o fundo move; pinça, roda do mouse e botões + / − dão zoom; "Centralizar" volta ao enquadramento inicial. Vale no editor e no ao vivo.
- "Todos os salões" fica **lado a lado, automático**, com o nome do salão sobre cada planta. Sem posição salva e sem migration.
- Tela cheia é a **tela cheia real do navegador**. Onde o navegador não deixa (iPhone), a página cobre só a área do app.
- O botão "Adicionar à fila" fica no **cartão "Fila de espera"** do painel lateral.

## Fora do escopo

- Banco, RLS, RPC e Edge Function: nada muda. A fila continua gravando por `enter_waitlist`.
- Posição relativa entre salões salva no banco.
- Zoom e pan persistidos entre sessões. Só a escolha "todos / salão X" é lembrada, por unidade, no `localStorage`.
- Editor com vários salões juntos: o editor continua com um salão por vez.

## Desenho

### 1. Fila pelo Salão ao vivo

- Extrair o diálogo de [Fila.tsx](../../../src/pages/operacional/Fila.tsx) para `src/components/waitlist/WaitlistEntryDialog.tsx`, com os mesmos campos, validação (`validateBrPhone`, nome obrigatório, `PartySizeInput` até 20) e os modos adicionar e editar. A Fila passa a usar o componente sem mudar o comportamento.
- `ResumoFila` ganha a prop `onAdd`, que mostra o botão "Adicionar à fila" no cabeçalho do cartão, inclusive com a fila vazia. O Salão ao vivo abre o mesmo diálogo, no modo adicionar.
- Mesma mutation `useAddToWaitlist(unitId)`. O aviso de entrada no WhatsApp, o link de acompanhamento e as métricas seguem o caminho de hoje. Não há código novo de envio.
- A invalidação `["waitlist", unitId]` já atualiza o resumo do salão (`waitlistActive`) e a tela Fila.
- Papéis: owner, gerente e operador já podem pôr gente na fila. Nada muda.

### 2. Pan e zoom (ao vivo e editor)

- Núcleo puro `src/lib/plan-viewport-core.ts`: estado `{ zoom, x, y }`, `zoomAt(state, fator, ponto)` (mantém fixo o ponto sob o cursor ou a pinça), limites de zoom de 0,5× a 3×, `clampPan` (a planta nunca some inteira da janela) e `fit()`. Testes unitários.
- Hook `usePlanViewport` com Pointer Events no fundo:
  - um dedo ou o mouse no fundo faz pan;
  - dois dedos fazem pinça;
  - `wheel` com Ctrl/Meta (inclui a pinça do trackpad) dá zoom; `wheel` sozinho continua rolando a página, para não prender o cursor sobre a planta;
  - `touch-action`: `pan-y` com zoom ≤ 1, para o toque vertical rolar a página no tablet em retrato (painel embaixo), e `none` com zoom > 1, quando o arrasto é da planta. Mesa, alça e entrada mantêm `none`.
- Controles `PlanViewportControls` (+, −, Centralizar), com `aria-label` e alvo de pelo menos 44 px em toque. Teclado: `+`, `-` e `0` com o foco na planta.
- O gesto começa no **fundo**. Toque em mesa continua sendo seleção (ao vivo) ou arrasto e redimensionamento (editor). No editor, o arrasto da mesa divide o deslocamento em px pela escala efetiva (escala base × zoom), para a mesa seguir o dedo em qualquer zoom.
- Clique no fundo sem mover (abaixo de 5 px, o mesmo limiar do arrasto) continua desmarcando a mesa no editor.
- Cena 3D: o pan e o zoom transformam o invólucro externo (`translate` + `scale`). A rotação e a animação de entrada ficam onde estão.
- `prefers-reduced-motion`: sem transição animada no "Centralizar".

### 3. Todos os salões / salão individual

- O seletor "Ambiente" ganha a opção **"Todos"** antes dos salões. A preferência vai para a mesma chave `salao-ao-vivo:hall:<unit>`, com o valor `"all"`. Com um salão só, o seletor continua escondido.
- Núcleo puro `arrangeHalls(plans, maxRowWidthCm)` em `src/lib/hall-arrange-core.ts`. Ele põe os salões em linhas, na ordem do cadastro, com um vão fixo entre eles, e devolve o deslocamento em cm de cada um e o tamanho total. Testes unitários.
- No modo Todos, as cenas 2D e 3D recebem vários salões, cada um com etiqueta de nome. O pan e o zoom tornam isso navegável. Ao entrar no modo, o enquadramento mostra tudo.
- Os contadores da legenda e o selo "N mesas" somam todos os salões ativos no modo Todos.
- "Próximas chegadas", ao escolher mesa, troca para o salão dela no modo individual. No modo Todos, fica em Todos e centraliza a mesa.
- O aviso "Planta ainda não desenhada" aparece por salão (na etiqueta), não em bloco único.

### 4. Tela cheia

- Botão "Tela cheia" / "Sair da tela cheia" no cabeçalho da seção.
- Com ela ligada, a página renderiza o próprio conteúdo em camada `fixed inset-0 z-40 bg-background`, sobre o casco do `AdminShell`, e chama `document.documentElement.requestFullscreen()`. A tela cheia pega o **documento inteiro**: Dialog, Select e Sonner abrem no `body` e precisam continuar visíveis.
- Sem a API, ou com recusa (iPhone): fica só a camada fixa e a tela continua utilizável.
- Sair: o botão, `Esc` ou o `fullscreenchange` vindo do navegador desligam a camada. Ao sair da rota, desliga e chama `exitFullscreen` se ainda estiver ativa.
- Layout em tela cheia: a planta ocupa a altura toda (`h-dvh`), com painel lateral de 372 px e rolagem própria. Abaixo de `lg`, o painel vai para baixo, como hoje. Respeita `env(safe-area-inset-*)`.
- Continua com uma única superfície `glass` (regra do frontend.md).

## Riscos e invariantes

- Sem mudança de banco ou servidor: risco **comum** em todas as fases.
- A situação das mesas continua saindo só de `table-situation-core.ts`.
- `glass-usage-guard.test.ts`: nenhuma superfície `glass` nova em item repetido.
- Desempenho no tablet: o pan e o zoom atualizam o `transform` por `requestAnimationFrame`, sem rerender das mesas a cada movimento do ponteiro (estado do viewport em ref + estilo aplicado; o React só sincroniza no fim do gesto ou no zoom pelos botões).
- Tema: cor só por token.

## Verificação

- Vitest: núcleos (viewport, arranjo), `WaitlistEntryDialog` (adicionar e validação), `ResumoFila` com `onAdd`, `SalaoAoVivo` (modo Todos, tela cheia com a API simulada e sem ela), a `Fila` intacta (testes atuais), o editor (arrasto com zoom ≠ 1).
- `npm run typecheck`, `lint`, `test`, `build`, `check-padrao`, `check-portabilidade`.
- Manual pelo dono em `npm run dev` na unidade MORALLES (salão "Área teste" com 40 mesas): pan e pinça no tablet, Todos × individual, tela cheia com o diálogo da fila aberto.
