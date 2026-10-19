# Review integrado — exclusividade legado → gerenciado

## Resultado e escopo

- Revisão independente de qualidade/segurança: `template_v2_integration_quality`, em 19/10/2026.
- Base: `0b3cd0125852d0b5fc6090f043500b3aaf18a4d8`; delta da branch `codex/whatsapp-template-versioned-dispatch`, incluindo arquivos novos e índice preparado pelo ROOT.
- **Qualidade/segurança estática integrada: PASS, sem P0/P1/P2 aberto.** O complemento SQL e o ajuste final de asserts anuláveis foram inspecionados. O ROOT confirmou PASS do review SPEC independente, reexecução SQL 76 com exit 0 e aceite local das Tasks 2 e 4. O restage/índice exato ainda é conferido pelo ROOT antes de commit. Produção: **NO-GO** enquanto CI, publicação/drenagem e pré-voo próprios não forem concluídos.
- Cobertura: produto SQL/EF/UI; testes, fixtures, documentos e linhas adicionadas staged; comparação dos corpos internos congelados com suas migrations de origem. Nenhuma alteração de produto, Git write, consulta de produção, browser, provider ou envio foi executada pelo revisor.
- A spec de despacho versionado v2 e seu plano estão **aprovados para implementação/testes locais**, pelo aceite explícito do responsável registrado nos documentos. Sua implementação foi adiada para depois da antiduplicidade/v1; o pacote examinado conserva o motor v1. Esse aceite não concede autorização adicional de produção.

## Artefatos e rastreabilidade

Snapshots locais finais conferidos; o ROOT confirmará a correspondência do índice depois de restage dos controles/documentos:

| Artefato | SHA-256 do arquivo observado |
| --- | --- |
| `supabase/migrations/20261019183559_whatsapp_legacy_managed_intent_fence.sql` | `DB00FFFE186DF7B547DE199BCCBCD665AF4DA804128A022E02AF5B21CD8A153F` |
| `supabase/tests/local-preflight/76-whatsapp-cutover-dedup.sql` | `236AE8A21C9FCFCB8BBDA281E82C6DC6A4900D3008A5904EFBA0566040E3D076` |
| `supabase/tests/local-preflight/76-whatsapp-cutover-concurrency.mjs` | `E0DED8321D4A2C5CEA03B9C46EB5ADF99CA43D43FDEDD45D9848D2971A343A42` |
| `docs/superpowers/2026-10-19-whatsapp-cutover-dedup-task2-sql-evidence.md` | `F2879C5A5A87833E8662BDA40358A72797D82A248302F4D67C707836E25AB6B7` |

O SQL novo declara sua transação. Cinco corpos `*_inner` foram comparados integralmente e são idênticos aos corpos anteriores: enqueue, post, finish, reconcile e issuer. O sexto, `release_whatsapp_template_channel_inner`, acrescenta somente os dois permits transacionais antes do enable. Não há rename nem transformação de corpo por regex em runtime/migration.

Evidências locais relacionadas: [Task 1](2026-10-19-whatsapp-cutover-dedup-causal-map.md), [Task 2 SQL](2026-10-19-whatsapp-cutover-dedup-task2-sql-evidence.md), [Task 3 EF](2026-10-19-whatsapp-cutover-dedup-task3-ef-evidence.md) e [Task 4 UI](2026-10-19-whatsapp-template-v1-activation-task4-ui-evidence.md). Contagens sobrepostas não são somadas.

## Skills efetivamente lidas e aplicadas

Skills de `saas-shield-br` 2.4.0 utilizadas nesta sessão: `agent-result-contract`, `tenant-model`, `migration-validator`, `rls-reviewer`, `multi-tenant-auditor`, `tenant-isolation-auditor`, `identity-access-auditor`, `secret-scan`, `secret-hunter`, `secret-scanner`, `integration-reliability-auditor` e `edge-function-guard`. Foram lidas também as referências de RLS/multi-tenant, `secret-scanner/patterns.md` e a lista canônica `hooks/scripts/secret-patterns.mjs`. Aplicação consolidada pelo próprio revisor, sem alegar um agente/ferramenta de scanner que não foi executado.

Perfil confirmado em `.claude/tenancy-profile.yml`: Vite, organização → unidade, `unit_members`, membership lookup, `platform_admins` separado, `app_private` e fronteira privilegiada em Edge Functions. Não foi presumido `company_id` ou RBAC de outro arquétipo. Regras do projeto e a spec aprovada de antiduplicidade prevalecem sobre templates genéricos das skills.

## Matriz dos gates estáticos

| Gate | Resultado | Controles vistos no produto |
| --- | --- | --- |
| Migration / compatibilidade | PASS estático | `BEGIN/COMMIT`; objetos privados e revogações explícitas; wrappers estáveis antes das ordens anteriores; backfill somente de jobs existentes, sem HTTP/cron/ativação; chave preservada após purga do job. Apply/reapply são evidência do implementer, não execução deste revisor. |
| RLS / ACL | PASS estático | Três tabelas privadas com ENABLE+FORCE RLS e sem grants para PUBLIC/anon/authenticated/service_role; sequência revogada; helpers/inners sem EXECUTE inclusive para service_role; quatro RPCs legadas e wrappers operacionais service-only; release exige administrador autenticado. |
| Isolamento de tenant | PASS estático | Unidade/organização derivadas do recurso e relidas após mutex; dimensão por kind validada; canal precisa pertencer à unidade e ser o selecionado; voucher comprova regra birthday/frequency. Ausência, recurso falso e drift falham fechados. |
| Identidade / acesso | PASS estático | Manager/admin antes de discovery, locks e early return de release; permit privado consumido uma vez por ator/transação/binding/estado/geração/revisão/timestamp; nenhum GUC concede permit. EF preserva JWT real na gestão; UI não transforma pseudo-owner em administrador. |
| Confiabilidade / exclusividade | PASS estático | Mesma chave por unidade/kind/recurso, independente de canal/versão; mutex unidade antes do fato; POST cercado one-use; posting/uncertain não liberados por timeout; finish accepted e marcador na mesma transação; projeção não é autoridade de novo envio. Histórico failed+ID só é terminal com correlação de recibo pela tupla completa. |
| Edge Functions | PASS estático | Intenção construída no servidor; revisão junto da credencial; confirm como último await antes do adapter; retry none somente para oito automações; recusa/incerteza não fabrica notificação failed; voucher propaga ID do INSERT vencedor. Manual/IA/ACK/after_rating não recebem guard por analogia de kind. |
| Frontend | PASS de qualidade | Confirmação consumida antes de await, lock síncrono, assertions atuais e uma tentativa; resultado ambíguo cercado no QueryClient até leitura posterior comprovar o estado; stop sticky separado; v2 não bloqueia CTA v1; custos/alcance informados. A cerca UI não substitui autoridade durável SQL. |
| Segredos | PASS estático | Scan dos 30 arquivos iniciais do delta e 157 arquivos do build já presente, com 12 padrões canônicos e 21 adicionais: nenhum segredo real; dois matches genéricos são literais sintéticos do fixture. Sem paths proibidos no delta. Não foram lidos valores de `.env` nem varrido histórico Git. O build não mudou após esse scan. |

Referências centrais: migration §§1–341, 1008–1020 e 1130–1399; `_shared/whatsapp-legacy-automation-post.ts`; `whatsapp-channel-service.ts:343`; `send-whatsapp/index.ts:240`; `useWhatsappTemplates.ts:118`; `TemplateDispatchAdminCard.tsx`.

## Achados encerrados

**P2 — falso positivo no resultado de adoção do harness de concorrência.** O antigo `observed.includes('f')` podia casar o UUID emitido por `set_config`, mesmo se a RPC retornasse true. Corrigido inicialmente no artefato `47DB6D…433DF3` e preservado no final `E0DED8…343A42`: uma única linha rotulada, JSON/booleano exato e observação do backend B em `pg_stat_activity` com `Lock:advisory` antes do commit A. O ROOT informou reexecução PASS dos dois interleavings; o revisor confirmou o código corrigido sem repetir a execução.

O P2 causal da Task 1 também permanece encerrado: o controle misto usa reminder real com POST às 15:00:00, adoção às 15:00:01 e novo produtor às 15:00:02; o positivo de confirmação conserva `producer_before_adoption`. O revisor reproduziu na Task 1 três positivos e quatro REDs exclusivamente de contagem antes do guard. Na Task 3 os controles passaram a testar wiring com replies SQL explícitos, conforme documentado.

O ROOT também identificou comparações JSON com `<>` que poderiam produzir NULL no harness SQL. O controle final usa `IS DISTINCT FROM` nos qualificadores e exige fence novo não nulo; o delta foi lido e o ROOT/implementer confirmaram reexecução apenas do SQL 76, exit 0. Nenhum corpo de produto mudou nesse ajuste.

## Provas e limites de cobertura

- Evidências de implementers/ROOT: 55 controles novos/T1, 186 de roteamento e 65 de canal/manual; 47 testes de UI; typecheck/lint/build e Deno dos seis entrypoints. O revisor não repetiu essas suítes nesta revisão integrada.
- Os testes de Request executam JS real, mas fornecem respostas SQL. Não comprovam locks, autorização SQL ou RLS de Supabase por si.
- O complemento final do harness SQL foi lido: confirmação, `waitlist_entered` e voucher birthday; canal de outro tenant, recurso falso e after_rating recusados; receipt de tupla errada conserva incerteza, enquanto receipt completo classifica aceite terminal sem repost. São amostras das três dimensões de recurso, não execução SQL integral dos oito kinds.
- A concorrência adicional libera dois bindings de unidades distintas na mesma WABA: sessões preparadas antes das duas chamadas, resultados rotulados true/true e assert posterior de duas adoções, dois bindings habilitados e uma conta. Isso prova o interleaving enable/enable testado; não é prepare/prepare nem prova ausência de todo deadlock possível. O ROOT/implementer registraram PASS; o revisor inspecionou controles/evidência, sem reexecutá-los.
- O PostgreSQL descartável não equivale ao gateway PostgREST/JWT de produção. A análise estática verifica ACL/RLS/guards; não houve validação remota por este revisor.
- O staged inicial e seus documentos foram lidos; `git diff --cached --check` passou após correção de EOF. Hash/índice finais ainda precisam ser reconciliados depois do último harness e dos ajustes documentais do ROOT.
- Review SPEC independente final de Task 2: PASS confirmado pelo ROOT após os complementos; Tasks 2 e 4 aceitas localmente. CI `acl-estatico`, drenagem de invocações antigas sem guard, reconciliação de histórico/incerteza e pré-voo operacional continuam gates externos a este veredito. Não foi demonstrado exactly-once distribuído ou entrega real. A autorização operacional já concedida é preservada; este review não a amplia.

## Próxima ação

Confirmar hashes/restage exatos e registrar o fechamento antes do commit. Depois o ROOT aplica os gates de CI/publicação autorizados: uma migration, seis EFs e frontend. **Este documento não libera produção nem substitui a prova de drenagem/corte.**
