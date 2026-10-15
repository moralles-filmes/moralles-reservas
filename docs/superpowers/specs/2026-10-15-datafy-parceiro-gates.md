# Datafy parceiro — evidências das Tasks 12–13

Data: 2026-10-15. Branch: `feat/datafy-parceiro-self-service`. Base whole-branch: `22cd5f2`; início deste bloco: `e4955cb`. Execução por subagent-driven-development, com implementador e revisão de spec/qualidade da documentação, seis gates de segurança e revisão whole-branch.

## Resultado e escopo

Task 12 aprovada: `7bf12e7` atualiza o par `CLAUDE.md`/`AGENTS.md` e cria o [runbook](../../datafy-parceiro-runbook.md); `71596fb` corrige a união de 13 Edge Functions no rollout e distingue ACL/RLS SQL local de produção/PostgREST. Revisão incremental aprovou as duas correções.

Task 13 **concluída após reavaliação de escopo em 2026-10-15, com limitação histórica MAIN109 explícita**: o pré-voo histórico 00–24, todos os scripts atuais Docker 25–60, os pré-voos Datafy 61–64, a auditoria final e o encerramento dos runtimes próprios passaram. O RED original MAIN109 não foi recuperado nem executado; a limitação afeta a reprodução histórica contra o corpo pré-fix e não constitui um gate runtime atual faltante ou falhando nesta branch, cuja implementação de acceptance está inalterada. A decisão abaixo substitui a classificação anterior de Task 13 parcial, preservada no plano. A publicação inicial foi em `3acd7f4`, PR #28 draft; `acl-estatico` do HEAD validado antes desta reavaliação `29fac37` passou em 36 s ([run 38793608064/job 116624190016](https://github.com/moralles-filmes/moralles-reservas/actions/runs/38793608064/job/116624190016)). Isto não é aprovação de merge/deploy. A Task 14 continua separada; não houve merge, novo deploy, chamada ao provider, contratação ou alteração de produção.

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

## Histórico local e publicação — resultado final dos scripts atuais

- **00–24 PASS:** PostgreSQL 18.6 próprio em loopback 55465, sem pg_cron/pg_net; 85 invocações SQL com status nativo e contagens finais conferidas. Grupos finais: 33, 36, 48 e 20 vereditos aprovados, mais concorrência 24 com 4/4. REDs previstos e restaurações preservados; cluster encerrado. Evidência: scratch `legacy-preflight-report.md`.
- **Docker 25–60 PASS:** PostgreSQL 17.11 em runtime próprio `.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/local-runtime`, projeto exato `moralles-templates-20261003`, API loopback 55451 e DB 55452. Portabilidade revisada e commitada em `3acd7f4`, mantendo guards, quarentena e chaves locais exclusivas de ROOT. Runner concluiu as 15 etapas e registrou lista de gates diferidos vazia. Todos os scripts atuais foram executados e passaram, incluindo os SQL/JWT/concorrência pertinentes.
- **Ordem e falha inicial 27 preservadas:** a primeira execução de 27 falhou porque o overload privado de sete argumentos ainda não existia; o erro/log foi preservado, sem atribuí-lo à migration de claims nem ocultá-lo. Após bridge41 e migration/reaplicação de recursos `20261005170415`, os atuais 27–30 e 35–37 passaram antes de 41–43. A ordem correta está no README; nenhum gate foi dispensado ou predecessor fabricado.
- **Retenção 60:** RED esperado contra o predecessor antes da migration; GREEN após aplicação e reaplicação. Regressões 53 e 31 também PASS. Logs e resultados nativos foram preservados.
- **Auditoria/cleanup:** o primeiro final-audit falhou por exatamente duas linhas lifecycle `token_stored` da fixture 32: organização `32323232-0000-0000-0000-000000000011`, unidade `32323232-0000-0000-0000-000000000012`, canal `32323232-0000-0000-0000-000000000024`, coerentes com as duas chamadas store do script 32. ROOT removeu somente essas duas linhas próprias (log `owned32-cleanup`). Auditoria repetida: exit 0, baselines preservados, zero resíduos próprios de domínio/Auth/audit/private, zero cron/net e zero material Vault de transporte. A falha inicial foi preservada.
- **Encerramento:** CLI stop com o workdir próprio exato, exit 0; inventário Docker final do projeto próprio vazio. Nenhum recurso de outro projeto foi reutilizado ou removido.
- **Publicação:** [PR #28 draft](https://github.com/moralles-filmes/moralles-reservas/pull/28), publicação inicial em `3acd7f4`. [acl-estatico](https://github.com/moralles-filmes/moralles-reservas/actions/runs/38789676653/job/116610676595): PASS, 36 s.
- **Vercel:** nenhum deploy novo observado; somente o deployment antigo de `5d25c91`. O guard `git.deploymentEnabled` desabilita deploy Git apenas para esta branch. Nenhum merge/deploy foi realizado.

## Reavaliação de escopo MAIN109 — 2026-10-15

O README do pré-voo (linhas 1652–1655) realmente inclui o RED do corpo antigo entre as verificações requeridas da seção **Task9c final resource continuation (41–43)**; o procedimento controlado das linhas 1553–1566 depende do snapshot histórico revisado. Não se afirma que essa exigência nunca existiu nem que foi cumprida. O README permanece inalterado. A spec Datafy §10 e a Task 13 exigem pré-voo/regressões atuais; não transformam a reprodução de todo predecessor histórico em gate incondicional de toda feature posterior. A revisão independente `main109-reassessment-review.md` distinguiu essa obrigação histórica da cobertura atual e recomendou fechar Task 13 com a limitação registrada.

A migration `20261005145913_whatsapp_automation_acceptance_repair.sql`, o helper histórico `20260905143453_whatsapp_conversation_provider_parity.sql` e `_shared/conversation-log.ts` estão inalterados contra `main`. Os deltas dos runners setup38/39/JWT40 só ajustam descoberta Docker e caminhos de runtime/scratch, preservando as asserções; SQL38 não mudou. A implementação atual adquire o advisory lock por unidade/cliente e busca o evento estável em todas as conversas do par antes de chamar get/create e append.

Evidência executada nos logs do SDD atual `docker-preflight-logs/acceptance-2026-10-15T18-59-55.304Z-*`:

- **SQL38 (`23.log`): 48 controles e ROLLBACK.** Decoys de outra unidade/cliente não satisfazem a busca; A já contém o evento e B é uma conversa legítima mais nova. A repetição exige um único evento no par exato e snapshots completos de A/B e notificação preservados, inclusive após deferral real por conflito de notificação. Uma regressão que appendasse novamente em B violaria essas asserções; isso é análise da cobertura atual, não execução do corpo antigo.
- **39 (`28.log`): sete corridas observadas, exits nativos 0/0.** Duas repetições entre conversas observam espera real do advisory lock, antes e depois do deferral real, e preservam um único evento nas duas conversas; ambos os controles ficaram GREEN.
- **JWT40 (`33.log`): 35 controles JWT/PostgREST genuínos.** Papéis sem acesso são recusados pela RPC service-only; a repetição via service PostgREST depois de B ficar mais nova confirma cardinalidade de um evento no par exato, linhas/timestamps/notificação inalterados e flags originais preservadas.

Esses resultados comprovam as regressões atuais, mas não recuperam a procedência nem a sequência fail-before/pass-after original. A única perda é a reprodutibilidade do RED/detecção histórica contra o corpo pré-fix indisponível. Ela é não bloqueante **para esta Task 13 com acceptance inalterado**, sem dispensa geral de controles para mudanças futuras. Nenhum teste ou runtime foi reexecutado nesta reavaliação documental; o ACL do PR foi consultado somente em leitura. Os resultados acima são das execuções já registradas.

## Limitação histórica e pendências de rollout

1. **Limitação histórica não bloqueante — MAIN109:** o corpo original anterior ao fix não foi recuperado do Git local, não shallow, nem dos objetos inacessíveis examinados; a migration já nasce corrigida em seu único commit de criação, e o snapshot scratch original está indisponível. O RED histórico específico permanece **NÃO EXECUTADO**. Os atuais 38–40 passaram e comprovam seus contratos atuais; nenhum corpo antigo foi fabricado e nenhum controle mutante substitui a procedência histórica ausente. Investigação detalhada: scratch `extra-historical-controls.md`. A decisão scoped acima substitui apenas sua classificação anterior como bloqueio da Task 13.
2. **Rollout/piloto:** seguir a Task 14 e o runbook somente com autorização própria, banco antes de EFs/frontend, com pré-voos de duplicata de telefone e conflito WABA imediatamente antes do `db push`. Operações com custo/destruição exigem identificação do canal pelo nome exato. Nenhuma aprovação de merge/deploy decorre deste checkpoint.

## Decisões e limites preservados

- A redação antiga da Task 12 sobre `begin_switch` foi alinhada às Tasks 7/8: recusa outro provider e permite binding do mesmo provider. Não houve regressão do comportamento para satisfazer o resumo antigo; eventual mudança de escopo exige revisão própria.
- A entrega permanece na branch solicitada, publicada em PR draft. Merge e deploy continuam fora do escopo autorizado; o PR não equivale ao piloto da Task 14.
- Alertas sequenciais podem atrasar o fim do lote sob timeout; watermark estrito pode perder transação longa com timestamp anterior ao snapshot; HTTP e ledger podem duplicar alertas. Não há promessa de exactly-once.

Relatórios detalhados e logs nativos desta execução permanecem no scratch ignorado `.superpowers/sdd/2026-10-13-datafy-parceiro-conexao-self-service/`; este documento é o resumo versionado das evidências e pendências.
