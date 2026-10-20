# Plano — aba administrativa de modelos e envios

Spec: [2026-10-20-whatsapp-admin-models-tab-design.md](../specs/2026-10-20-whatsapp-admin-models-tab-design.md). Aprovada pelo responsável em 20/10/2026; review de spec independente PASS antes do código.

## Task 1 — composição e cópia da página

- [x] Confirmar o inventário da aba `channels`, localização dos três cartões e convenções de Tabs em `Automacao.tsx`.
- [x] Criar a aba “Modelos e envios”, mover os cartões sem editar seus contratos e incluir orientação curta de ordem/gates.
- [x] Verificar a unidade atual, a aba de canais sem os cartões e a nova aba em desktop/mobile (320/360 px, rolagem e teclado); testes focados, `npm run typecheck`, lint do delta, build e `git diff --check`.
- [x] Implementer → review da spec → review de qualidade → correções/aceite por task. Registrar evidências e arquivos exatos.

## Task 2 — revisão integrada e publicação

- [x] Rever o diff inteiro contra `origin/main`: apenas UI/docs, sem alteração de autoridade SQL/EF ou envio pago; verificar `git status`, `git diff`, staged completo e varredura de segredos. Usar `git add` de caminhos explícitos e commit local.
- [x] Push/CI e PR dentro da autorização vigente; não fazer merge com check vermelho ou conflito. Confirmar autorização do efeito Vercel de `main` se ainda não coberta, fazer merge e verificar deployment READY no SHA exato.
- [x] Conferir a aba em produção sem acionar mutações; registrar evidências. A seleção v2 da Ren Sushi continua pendente da aprovação Meta e de autorização operacional própria.

## Evidência local de 20/10

- Implementer trabalhou no worktree `whatsapp-versioned-dispatch-final`: `Automacao.tsx` moveu os mesmos três cartões para a segunda aba, sem alterar hooks/RPCs, e passou `unitId` atual; `Tabs key={unitId}` reinicia a seleção ao trocar unidade. O novo `Automacao.models-tab.test.tsx` verifica composição, ausência na aba de canais, unidade, teclado e reset. `npx vitest run src/pages/gestao/Automacao.models-tab.test.tsx src/pages/gestao/Automacao.datafy.test.tsx --reporter=dot` passou 8/8; `npm run typecheck`, `npx eslint` nos dois arquivos, `npm run build` e `git diff --check` terminaram exit 0. As dependências vieram do `node_modules` ancestral, mas cwd e fontes transformadas eram deste worktree.
- Reviews independentes de spec e qualidade: **PASS do código e da autoridade**. A rota continua sob `PlatformGuard`, os componentes preservam seus gates e a abertura da aba não adiciona mutation. Ambos apontaram lacuna P2 de evidência visual em 320/360 px: os testes comprovavam classe de rolagem `overflow-x-auto` e teclado, mas não mediam layout real. Os checkboxes de validação/review integral ficaram abertos até a conferência em navegador registrada abaixo. O teste usa mocks dos cartões; a ausência de nova chamada de escrita foi verificada estaticamente, não por teste de integração real.

## Publicação e conferência de 20/10

- Staged integral de seis caminhos revisado; `git diff --cached --check` passou. Scanner das 137 linhas adicionadas encontrou zero padrões de prefixo de token, credencial atribuída, URL com credencial, segredo em webhook e header hexadecimal. `git add` nomeou cada caminho; commit local inicial `595d6ad`, rebase sem conflito sobre a `main` que recebeu apenas documentação de agentes, commit final `35ec847` e push da branch. Nenhum SQL/EF/provider foi alterado neste PR.
- [PR #52](https://github.com/moralles-filmes/moralles-reservas/pull/52): `acl-estatico` PASS, Vercel preview PASS, sem conflitos (`MERGEABLE`), integrado em `main` no SHA `3d59e9365c54e550ca2b898c0a0f2bcc659ad6d9`. Vercel produção `dpl_6dFPJcYMvAByKzsZAnP6e7ZPTXCT` ficou `READY` para **esse mesmo SHA**, com alias `reservas.moralles.com.br`. O aceite prévio de push/merge e do efeito Vercel cobriu esta publicação da interface solicitada.
- No Chrome autenticado, após recarregar `/platform/unidades/ren-sushi`, “Canais WhatsApp” não continha mais os três cartões; a aba irmã “Modelos e envios” mostrou orientação e os cartões na ordem catálogo → despacho v1 → versão. A leitura dos controles mostrou despacho v1 ainda liberado e preferência v1 na Ren Sushi; v2 seguia seis `PENDING`, dois `IN_APPEAL`, um `UNKNOWN`, com seleção v2 indisponível. Nenhum botão de mutação foi acionado. Em viewport 320 px, `documentWidth=320`, `tablist.clientWidth=257`, `scrollWidth=938`; clicar na segunda aba a trouxe integralmente para a área visível (`left≈117`, `right≈281`, `scrollLeft=78`). Em 360 px, `documentWidth=360`, `clientWidth=297`, a segunda aba continuou visível com `left≈117`, `right≈281`. Capturas visuais de 320/360 confirmaram texto e primeiro cartão sem corte horizontal da página; a viewport foi restaurada para 1920 px. Assim, a lacuna P2 de evidência mobile dos reviews foi fechada.
