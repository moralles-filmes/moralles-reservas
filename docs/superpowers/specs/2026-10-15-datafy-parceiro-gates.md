# Datafy parceiro — evidências das Tasks 12–13

Data: 2026-10-15. Branch: `feat/datafy-parceiro-self-service`. Base whole-branch: `22cd5f2`; início deste bloco: `e4955cb`. Execução por subagent-driven-development, com implementador e revisão de spec/qualidade da documentação, seis gates de segurança e revisão whole-branch.

## Resultado e escopo

Task 12 aprovada: `7bf12e7` atualiza o par `CLAUDE.md`/`AGENTS.md` e cria o [runbook](../../datafy-parceiro-runbook.md); `71596fb` corrige a união de 13 Edge Functions no rollout e distingue ACL/RLS SQL local de produção/PostgREST. Revisão incremental aprovou as duas correções.

Task 13 permanece **parcial**: os gates executáveis disponíveis passaram, mas o pré-voo histórico completo e o Check remoto `acl-estatico` não foram comprovados. Isto não é aprovação de merge/deploy. A Task 14 continua separada; este bloco não fez push, merge em main, deploy, chamada ao provider, contratação ou alteração de produção.

## Gates executados

| Gate | Evidência |
|---|---|
| Suíte de aplicação | `npm test -- --maxWorkers=1 --minWorkers=1`: 121 arquivos, 3.291 testes, exit 0, 522,80 s. Runtime de `e4955cb`, antes da correção final do portal; documentação até `71596fb`. |
| Typecheck | `npm run typecheck` (`tsc -b --noEmit`): exit 0. |
| Lint | `npm run lint`: exit 0, zero erros e 21 warnings preexistentes. |
| Edge Functions | `npx eslint supabase/functions --max-warnings=0`: exit 0. |
| Build | `npm run build`: exit 0; avisos existentes de Browserslist e chunks maiores que 500 kB. |
| Equivalente local de ACL estático | A suíte completa executou `function-acl-allowlist`, `advisor-divergence-core` e `migration-static-guard`; o lint de EFs foi executado separadamente. Não equivale ao Check do PR. |
| Seis auditores | RLS, migrations, tenant, identidade/acesso e secrets: PASS estático; integrações: PASS_WITH_WARNINGS pelas limitações de alertas abaixo. Nenhum P0/P1 confirmado. |

Os testes de UI mantêm avisos preexistentes de future flags do React Router. Nenhum resultado local afirma homologação Datafy, Deno real, popup/signup real, entrega de alerta ou ACL de produção.

## Correção encontrada na revisão whole-branch

**WB-001/P2:** o portal substituía a saúde operacional pelo checklist histórico e continuava mostrando conexão ativada após `disconnected`/`provider_error`. O commit `0f56e6c` mantém o checklist e apresenta a saúde atual separadamente pelo hook client-safe existente, sem alterar backend ou permissões.

RED: seis testes novos falharam antes da correção. GREEN: 36/36 testes nos arquivos `Whatsapp.official.test.tsx`, `OfficialConnectionCard.test.tsx` e `useWhatsappConnection.test.ts`. Cobrem desconexão, erro, recuperação, erro de refetch com sucesso antigo em cache, ausência/carregamento e troca de unidade. Typecheck, lint dos arquivos e build passaram após a correção. A suíte ampla acima é baseline; estes são os gates finais da alteração.

Revisão incremental independente de `71596fb..0f56e6c`: **WB-001 corrigido; spec e qualidade aprovadas; nenhum novo achado**. As pendências de prontidão abaixo permanecem.

## PostgreSQL descartável

Dois clusters próprios PostgreSQL 18, somente loopback (`55463` e `55464`), sem `pg_cron`/`pg_net`, encerrados ao final. Nenhum container ou banco de outro projeto foi reutilizado.

- **61:** 31/31 após dupla reaplicação da migration inicial.
- **61b:** 3/3 controles com sessões reais, incluindo sabotagem de `FOR UPDATE` e restauração do hash original.
- **62:** 14 grupos de claim, identidade, recuperação e ACL.
- **63:** grupos de autoridade/ACL e quatro casos de recuperação avançada.
- **63b:** quatro corridas com espera de lock observada e rollback de backfill contraditório.
- **64:** replay da migration, cobertura de unidades, filtro de tenant, watermark, relógio SQL e ACL service-only.

O fingerprint C14 do 61 ficou **FALHOU** ao comparar a baseline da primeira migration com o schema intencionalmente ampliado pela migration `20261014170540`; os outros 30 controles continuaram verdes. Esse resultado foi preservado. Em prova separada, guardou-se o fingerprint antigo e estabeleceu-se baseline do schema final apenas no harness descartável: dupla reaplicação de `170540` seguida de 61 voltou a 31/31, e 62/63 passaram. Não houve alteração do teste para ocultar o resultado anterior.

## Pendências obrigatórias

1. **Pré-voo histórico completo:** os gates GoTrue/PostgREST/JWT dependem do projeto/container `moralles-templates-20261003`, do scratch histórico `2026-10-03-whatsapp-templates-programados/local-runtime` e de executáveis fixados no perfil de outra máquina. Esses pré-requisitos estão ausentes. Restaurar/provisionar um ambiente descartável equivalente e revisar a portabilidade do harness antes de executá-los; nunca apontar para um banco alheio nem remover guardas para obter verde. O conjunto 61–64 não substitui todo o histórico.
2. **`acl-estatico` no PR:** consulta somente leitura por `gh pr view feat/datafy-parceiro-self-service` confirmou ausência de PR. Publicação da branch/PR e conferência dos Checks exigem o escopo de publicação correspondente; não foram realizadas neste bloco.
3. **Rollout/piloto:** seguir a Task 14 e o runbook, banco antes de EFs/frontend, com os pré-voos de duplicata de telefone e conflito WABA imediatamente antes do `db push`. Operações com custo/destruição exigem identificação do canal pelo nome exato.

## Decisões e limites preservados

- A redação antiga da Task 12 sobre `begin_switch` foi alinhada às Tasks 7/8: recusa outro provider e permite binding do mesmo provider. Não houve regressão do comportamento para satisfazer o resumo antigo; eventual mudança de escopo exige revisão própria.
- A entrega permanece commitada na branch solicitada. Merge/push/deploy pertencem à etapa operacional separada; isso pode adiar a publicação, mas evita publicar sem seus gates.
- Alertas sequenciais podem atrasar o fim do lote sob timeout; watermark estrito pode perder transação longa com timestamp anterior ao snapshot; HTTP e ledger podem duplicar alertas. Não há promessa de exactly-once.

Relatórios detalhados e logs nativos desta execução permanecem no scratch ignorado `.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/`; este documento é o resumo versionado das evidências e pendências.
