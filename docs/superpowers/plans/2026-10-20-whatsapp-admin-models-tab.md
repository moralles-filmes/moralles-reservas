# Plano — aba administrativa de modelos e envios

Spec: [2026-10-20-whatsapp-admin-models-tab-design.md](../specs/2026-10-20-whatsapp-admin-models-tab-design.md). Aprovada pelo responsável em 20/10/2026; review de spec independente PASS antes do código.

## Task 1 — composição e cópia da página

- [x] Confirmar o inventário da aba `channels`, localização dos três cartões e convenções de Tabs em `Automacao.tsx`.
- [x] Criar a aba “Modelos e envios”, mover os cartões sem editar seus contratos e incluir orientação curta de ordem/gates.
- [ ] Verificar a unidade atual, a aba de canais sem os cartões e a nova aba em desktop/mobile (320/360 px, rolagem e teclado); testes focados, `npm run typecheck`, lint do delta, build e `git diff --check`.
- [ ] Implementer → review da spec → review de qualidade → correções/aceite por task. Registrar evidências e arquivos exatos.

## Task 2 — revisão integrada e publicação

- [ ] Rever o diff inteiro contra `origin/main`: apenas UI/docs, sem alteração de autoridade SQL/EF ou envio pago; verificar `git status`, `git diff`, staged completo e varredura de segredos. Usar `git add` de caminhos explícitos e commit local.
- [ ] Push/CI e PR dentro da autorização vigente; não fazer merge com check vermelho ou conflito. Confirmar autorização do efeito Vercel de `main` se ainda não coberta, fazer merge e verificar deployment READY no SHA exato.
- [ ] Conferir a aba em produção sem acionar mutações; registrar evidências. A seleção v2 da Ren Sushi continua pendente da aprovação Meta e de autorização operacional própria.

## Evidência local de 20/10

- Implementer trabalhou no worktree `whatsapp-versioned-dispatch-final`: `Automacao.tsx` moveu os mesmos três cartões para a segunda aba, sem alterar hooks/RPCs, e passou `unitId` atual; `Tabs key={unitId}` reinicia a seleção ao trocar unidade. O novo `Automacao.models-tab.test.tsx` verifica composição, ausência na aba de canais, unidade, teclado e reset. `npx vitest run src/pages/gestao/Automacao.models-tab.test.tsx src/pages/gestao/Automacao.datafy.test.tsx --reporter=dot` passou 8/8; `npm run typecheck`, `npx eslint` nos dois arquivos, `npm run build` e `git diff --check` terminaram exit 0. As dependências vieram do `node_modules` ancestral, mas cwd e fontes transformadas eram deste worktree.
- Reviews independentes de spec e qualidade: **PASS do código e da autoridade**. A rota continua sob `PlatformGuard`, os componentes preservam seus gates e a abertura da aba não adiciona mutation. Ambos apontaram lacuna P2 de evidência visual em 320/360 px: os testes comprovam classe de rolagem `overflow-x-auto` e teclado, e `TabsTrigger` não encolhe, mas não medem layout real. Por isso os checkboxes de validação/review integral permanecem abertos até a conferência em navegador. O teste usa mocks dos cartões; a ausência de nova chamada de escrita foi verificada estaticamente, não por teste de integração real.
