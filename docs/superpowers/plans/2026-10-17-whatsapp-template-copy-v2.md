# Plano — textos v2 dos nove modelos oficiais

**Spec aprovada:** [textos v2](../specs/2026-10-17-whatsapp-template-copy-v2-design.md), aceite do responsável em 2026-10-17 somente para implementação local. **Estado:** planejamento; nenhum código desta versão foi implementado. A política automática v1 e o piloto Ren Sushi seguem no [plano próprio](2026-10-17-datafy-template-auto-provision-on-connect.md).

## Contratos antes das tasks

- Os nove modelos v1 já submetidos à Ren Sushi permanecem imutáveis e identificáveis por nome, versão, conteúdo e hash. V2 usa nomes técnicos `*_v2` e versão 2; nenhum `UPDATE` de conteúdo/identidade remota v1, nem retry de POST incerto.
- A revisão `INCORRECT_CATEGORY` dos dois modelos de fila v1 deve ser tratada na Meta com exemplo fictício. V2 não reclassifica `UTILITY` como `MARKETING` por tentativa. A categoria solicitada, efetiva e o custo de mensagens permanecem gates separados.
- A instalação local da v2 não ativa catálogo/despacho, não muda a versão usada pela política automática já implementada, não envia mensagem nem submete modelo. O alvo Moralles Reservas e o canal Ren Sushi só serão tocados após novo pré-voo, autorizações próprias e confirmação nominal de canal/custo.
- Para cada task de implementação: implementer → review independente de aderência à spec → review independente de qualidade → correções → aceite pelo ROOT. Depois das tasks, review integrado da branch, gates de segurança e revisão completa do staged.

## Task 1 — Catálogo v2 e provas de redação

Arquivos previstos: `_shared/whatsapp-template-catalog-core.ts`, testes de catálogo/renderização, fixtures de exemplos fictícios.

- [x] Preservar objeto, nomes, hashes e renderização v1 sem alteração. Adicionar nove definições v2 com idioma `pt_BR`, `POSITIONAL`, corpos e quebras duplas exatos da spec, no máximo um emoji por modelo e nenhum no cancelamento; manter parâmetros e exemplos na mesma ordem de cada v1.
- [x] Definir seleção explícita por versão/finalidade. A versão operacional e a versão permitida para submissão não mudam por mera presença das definições v2; o estado de catálogo/autoridade precisa selecioná-las. O snapshot atual percorre todo `TEMPLATE_CATALOG` e rotula cada item como versão 1: manter v2 fora desse objeto operacional até corrigir a projeção ou antecipar a correção e o teste nesta task. Não introduzir 18 intenções para o mesmo fato.
- [x] Testar renderização com exemplos fictícios, singular/plural, pontuação de URLs, quebras em branco, ausência de parâmetro, hash estável e controle que falha se o texto/exemplo mudar sem nova autorização.
- [x] Revisar cada cópia quanto ao fato real que a dispara: desconto já aplicado, voucher já emitido, fila registrada/mesa pronta, pesquisa após reserva e cancelamento. Corrigir promessa comercial ou variável de sentido incorreto antes da próxima task.
- [x] Implementer → review de spec → review de qualidade → correções e aceite.

**Evidência da Task 1 (implementação local, 17/10/2026):** os nove drafts v2 estão em catálogo separado, não importado por seeding/snapshot/dispatch v1. O renderer comum manteve a assinatura e comportamento v1; hashes de conteúdo e payload completo com exemplos ficaram fixados em teste. O implementer executou 160/160 testes focados, typecheck, ESLint dos arquivos tocados e `git diff --check`. Review independente de spec passou sem P0/P1/P2 e executou 14 testes v2, 133 de regressão v1 e typecheck. Review independente de qualidade passou sem P0/P1/P2, com 120/120 testes e typecheck. O `deno check` do módulo v2 passou e o grafo de imports confirmou zero Edge Functions consumidoras dele. Nenhuma migration, submissão Meta, envio ou deploy foi feito nesta task.

## Task 2 — Contrato SQL, ACL e coexistência v1/v2

Arquivos previstos: nova migration via `supabase migration new`, pré-voos SQL, allowlist ACL.

- [ ] Inventariar CHECKs, função de seleção, seeds, índice de nome e assinatura das RPCs que assumem nove IDs/v1; projetar expansão para 18 definições sem permitir sobrescrever registro remoto v1 ou conceder autorização v2 herdada do grant v1.
- [ ] Criar allowlist v2 versionada com nove hashes de conteúdo e JSON completo de submissão, incluindo exemplos. A função vigente `app_private.whatsapp_template_approved_catalog_digest()` retorna NULL quando a tabela inteira deixa de ter exatamente nove linhas; antes de inserir v2, isolar digest por versão/coorte, preservar o digest v1 exato para todos os callers/grants atuais e obter digest v2 separado. Testar nove linhas em cada coorte e falha fechada se uma delas estiver incompleta. Política v2 OFF por default ou revisão explicitamente não ativada; ausência de rollout v2 mantém v1 intacta.
- [ ] Cercar `prepare`/`confirm`/`check` e seleção de jobs com versão, digest, grant, geração/revisão do binding, idempotência e one-use fence. Não repetir v1 rejeitado/incerto nem enfileirar 18 POSTs por conta.
- [ ] Atualizar ACL/RLS com revogação explícita de funções novas; provar serviço mínimo, plataforma, owner/gerente/operador, outra organização/WABA, reconexão, stop e corrida de dois canais da mesma WABA.
- [ ] Aplicar/reaplicar no PostgreSQL local descartável e testar rollback lógico (política v2 OFF, registros v1 preservados). Sem `db push` de produção nesta task.
- [ ] Implementer → review de spec → review de qualidade → correções e aceite.

## Task 3 — Seleção backend, worker e interface

Arquivos previstos: serviços `_shared`, bundles consumidores pelo import graph, snapshots e cartões da loja/admin.

- [ ] Adaptar seeding/sync/provision para coexistir com v1/v2: a versão ativa é escolhida uma vez por conta/grant/política e o mesmo fato produz no máximo uma intenção. Conta compartilhada e canal legado continuam cercados pela organização/binding; stop/revoke impedem novos POSTs.
- [ ] Projeção da loja distingue v1 de v2, mostra texto com parágrafos e emoji e estado Meta por versão. `PENDING`, `REJECTED`, `UNKNOWN` e aprovação não se confundem; uma v2 aprovada não liga despacho automaticamente.
- [ ] Painel da plataforma mostra revisão/digest v2 e exige confirmação de alcance antes de habilitar futura submissão; sem backfill de Ren Sushi ou canais antigos. Nenhum botão da loja altera corpo oficial.
- [ ] Testes de API/React e import graph para todos os consumidores `_shared`; `deno check` dos entrypoints, `npm run typecheck` e regressão v1.
- [ ] Implementer → review de spec → review de qualidade → correções e aceite.

## Task 4 — Integração e preparação de rollout

- [ ] Executar pré-voo SQL isolado, testes focados e completos pertinentes, `npm run typecheck`, `npm run lint`, `npm run build`, `deno check`, ACL estático, seis gates `saas-shield-br` e review integrado da branch. Atualizar docs/runbook/memória só com evidência comprovada.
- [ ] Revisar `git status`, diff total e 100% do staged; varrer segredos e arquivos proibidos, usar apenas `git add <caminhos explícitos>`, fazer commit local. Push/PR/CI e merge conforme autorização vigente; merge em `main` dispara Vercel e exige reconfirmação de seu efeito.
- [ ] Para produção, obter autorizações separadas de `db push`, matriz exata de EF incluindo `process-whatsapp-templates`, merge/Vercel, política v2 e submissão Meta por alcance. Revalidar backup/janela, contas no alcance, canal/custo e resultado dos recursos dos dois rejeitados. SQL → ACL → EF → frontend READY → grant/política → GET de reconciliação; despacho segue OFF.
- [ ] Só declarar modelos utilizáveis quando a Meta aprovar cada nome/idioma/hash/categoria vigente; mensagens pagas e ativação por loja são um rollout distinto.
