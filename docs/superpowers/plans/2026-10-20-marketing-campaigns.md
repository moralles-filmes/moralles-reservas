# Plano — MARKETING em rascunhos e resultados

Spec aprovada: [2026-10-20-marketing-campaigns-design.md](../specs/2026-10-20-marketing-campaigns-design.md). Esta implementação não ativa disparos, submete modelos ou chama providers. O checkout de implementação parte de `origin/main` local na branch `codex/marketing-module`.

## Tarefa 1 — autoridade dos rascunhos (risco crítico)

- Migration aditiva para `marketing_campaign_drafts` e RPCs de lista, gravação CAS e arquivamento; owner edita, gerente lê, operador nega, platform admin lê. Tipos fechados, regra Giftback da própria unidade/gatilho, índices parciais separados para regra e pesquisa pós-fila nula, revisão esperada, auditoria sem PII, RLS forçada e ACL explícita.
- Não tocar produtores de Giftback/WhatsApp, flags, grants de custo ou canal. Verificar concorrência, regra removida, membership revogada, cross-unit/org e função sem `EXECUTE` público em preflight local com controles positivos.
- Gate: migration-validator, RLS/tenant, identity-access, `acl-estatico` estático.

## Tarefa 2 — resultados agregados (risco crítico)

- RPC autenticada com escopo da unidade e período BRT, agregando vouchers por regra, jobs/recibos gerenciados por finalidade e legado em série separada. Provar correlação completa de recibo, aceite reconciliado que posteriormente falha, dedupe de status, coorte de vouchers e casos sem fonte confiável. `trigger_type` mutável impede atribuição histórica a aniversário/fidelidade: exibir por regra, com grupo sem regra quando o vínculo foi apagado. Jobs/recibos e distinção do legado só são exibidos para período inteiramente dentro da retenção verificável de 90 dias; antes disso, resultado indisponível. Nenhuma linha pessoal no DTO.
- Índices apenas se plano de consulta justificar; nada de `limit(5000)` ou truncamento PostgREST. Testes SQL de >5.000 vouchers, recibo duplicado/fora de ordem, `uncertain`, legado e outra unidade. Revisão de consultas/tenant/ACL antes de fechar.

## Tarefa 3 — interface da loja (risco comum)

- Adapter `src/features/marketing/api.ts`, hooks TanStack com `unit_id` na chave e schemas de resposta; rotas/menu Gestão. “Campanhas” com três opções legíveis e formulário de rascunho; “Resultados” com fonte, período e estados carregando/erro/vazio/sem acesso.
- Não apresentar IDs técnicos, custo/ROI não apurados como zero, consentimento como liberado globalmente, nem CTA de ativação/envio. Destacar que regras Giftback já ativas seguem operando fora dos rascunhos. Testes de interação, troca de unidade, 320/360 px e ausência de chamadas de envio.

## Tarefa 4 — revisão integrada e gates (risco crítico)

- Review da spec e de qualidade por tarefa, depois diff integral. Provar que SQL/EF produtor, crons, flags, grants de custo, seleção v1/v2 e configuração Ren Sushi não mudaram; atualização de `docs/modules/marketing.md` e registro das limitações de métricas.
- Rodar `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `node scripts/check-padrao.mjs`, `node scripts/check-portabilidade.mjs`, testes SQL locais, gates de segurança e varredura de segredos. Conferir `git status`, diff e staged integral antes do commit. Sem `db push`, deploy, provider POST ou push em `main` nesta execução.

## Critério final

Branch local com mudanças revisadas e commitadas, sem gate vermelho. Merge local em `main` somente se o risco de deploy automático estiver fora do caminho; push/produção exigem autorização operacional separada. Qualquer indisponibilidade de banco de teste fica documentada com as validações alternativas realizadas, sem declarar gate não executado como PASS.
