# Módulo: datafy-whatsapp

Branch `feat/datafy-whatsapp-oficial`, worktree `.claude/worktrees/datafy-oficial`, commits `e493a89..83eaa0c`.
Modo: `--fix` (padrão), mas correção passa pela mesma disciplina de fix round + re-review do SDD — auditoria
não edita por fora do loop, porque o código acabou de passar por review de segurança dedicada.

Gatilho: `audit_required=true` do ai-router-br nas Tasks 2, 3 e 5. Ruling da Task 2 adiou para depois da
Task 5, quando o caminho de auth estivesse ligado — condição satisfeita em 83eaa0c.

## Fase 1 — baseline: FEITA
Árvore limpa, 8 commits na branch, sem estado de auditoria anterior neste repo (primeira).

## Fase 2 — mapa do módulo: FEITA sem dispatch do mapper
Ruling: o mapa já existe verificado em dois documentos desta mesma sessão — a auditoria FASE 0 em
`docs/superpowers/specs/2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md` e a review de segurança
da Task 5, que rastreou o fluxo linha a linha. Despachar `audit-architecture-mapper` para redescobrir o
mesmo mapa gastaria um contexto inteiro para produzir o que já está escrito e conferido. O mapa foi passado
inline a cada auditor.
Custo se errado: um auditor recebe mapa incompleto e perde um caminho. Mitigado porque os três receberam o
mesmo mapa e têm liberdade de ler o repo inteiro.

## Fase 3 — auditors: FEITA
Selecionados por risco, não mecanicamente:
- `integration-reliability-auditor` — webhook + API externa + idempotência. O ângulo MENOS coberto pela
  review de segurança: dedupe sob o nome certo de provider, correlação de recibo com id ausente, retry de
  erro de credencial, timeout, outros caminhos que devolvam 5xx onde 200 seria correto.
- `tenant-isolation-auditor` — multi-tenant com RLS FORCE sem policies, ou seja, a separação depende
  inteiramente do código da EF. Pergunta central: como o canal é RESOLVIDO antes da guarda de identidade?
  Guarda que compara o payload contra um canal que o próprio remetente escolheu não prova nada.
- `secret-hunter` — a branch tocou `.ai-router/`, `CLAUDE.md` e `AGENTS.md`, os três lugares onde a regra
  do projeto proíbe secret; e vai para `main`, que dispara deploy.
NÃO selecionados, com motivo:
- `rls-auditor` — nenhuma migration nesta branch ainda (é a Task 4). Roda depois dela.
- `identity-access-auditor` — o diff não toca membership, papel nem convite; o webhook não tem auth de
  usuário (é HMAC). O gate de papel de `manage-channels` é Task 6.
- `ai-automation-auditor` — o diff não toca o caminho do agente nem tools.
- `data-resilience-auditor` — sem upload, exclusão, retenção ou migration no diff.
- `functional-auditor` — o elo "capability declarada vs implementada" já é gateado por
  `whatsapp-capability-guard.test.ts` com controle positivo, verificado na review da Task 1.

## Fases 4-7: FEITAS

Veredito **PASS, zero P0/P1**. Quatro findings, nenhum bloqueante: um rejeitado com evidência contrária,
um corrigido na spec, dois abertos como P3 para o review whole-branch. Relatório completo em
`REPORT.md`, consolidado em `../../FINDINGS.md`.

**Fase 5 (correção):** a única correção foi documental — subseção nova na spec ampliando a pendência da
Fase F. Nenhuma mudança de código foi proposta ou feita; corrigir o comportamento do lote alcançaria o
provider `official` junto e violaria a Global Constraint das Fases A–D.

**Fase 6 (regressão):** não havia mudança de código a regredir. A suíte (1527 testes) e o typecheck já
estavam verdes em `83eaa0c`, confirmados de forma independente pela re-review da fix round.

**Fase 7 (CLAUDE.md/AGENTS.md):** nada a acrescentar. A auditoria não produziu invariante novo — ela
confirmou controles que já existem, e a única informação duradoura que gerou (a superfície larga do 500
no lote) é pendência de fase futura, cujo lugar é a spec, não o arquivo de invariantes.

## Next

Reauditar quando existirem: a migration da Task 4 (`rls-auditor`) e o caminho de provisionamento de canal
da Task 6 (isolamento + identidade). Decidir MOD-003 antes de migrar qualquer unidade existente para
Datafy.
