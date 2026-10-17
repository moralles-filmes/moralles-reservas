# Plano — receptor de alertas operacionais WhatsApp por e-mail

- **Spec aprovada para implementação local:** [2026-10-17-whatsapp-ops-alert-email-receiver-design.md](../specs/2026-10-17-whatsapp-ops-alert-email-receiver-design.md), aceite do responsável em 2026-10-17. O aceite não cobre operações de produção nem chamadas Resend.
- **Autorização posterior de envio:** o responsável informou plano Resend Free com mais de 2.000 e-mails disponíveis e autorizou envios Resend em 2026-10-17. Nenhum envio ocorreu: destinatário seguro, migration/deploy e prova de recebimento ainda faltam; a autorização não cobre `db push`, deploy, secrets ou conexão Datafy.
- **Branch de implementação:** `codex/datafy-ops-alert-email-impl`, baseada em `origin/main` após PR #32.
- **Fluxo:** cada task de implementação tem implementer, review independente de spec e review independente de qualidade. ROOT resolve achados e confere a branch inteira. Marcar somente checks com prova em Evidências.
- **Fronteira:** nenhuma chamada real ao Resend/Datafy/Meta, `supabase db push`, secret, deploy, conexão ou corte da Ren Sushi nesta etapa. Push/CI/merge seguem a autorização anterior, somente depois dos gates; merge de código de EF não publica seu bundle.
- **Ordem de produção futura, sob autorizações novas:** migration → EF receptora e três consumidores (com URL ausente) → teste Resend autorizado → autorização distinta de alertas automáticos globais → HMAC aprovado e URL → health → pré-corte. A autorização da Fase 5 para `process-whatsapp-templates` não se transfere; esta implementação não deve alterá-lo.

## Task 1 — Migration de reserva e teto

Arquivos: `supabase/migrations/20261017190000_whatsapp_ops_email_attempts.sql`, allowlist de ACL somente se o contrato estático pedir. A CLI Supabase não estava disponível no sandbox quando o arquivo foi criado; o timestamp segue o formato do repositório e o SQL ainda não foi aplicado em produção.

- [x] Criar tabela `public.whatsapp_ops_email_attempts` com os campos imutáveis da spec, FK de unidade, `unit_id NULL` só para `synthetic_test`, constraints de tipo/contagem/idade/canal/estado, índices por janela e `FORCE RLS` sem policies. Revogar acesso amplo a tabela/sequence; conceder `SELECT`/`INSERT` e `UPDATE` **somente das colunas de estado/id remoto** ao `service_role`, sem `DELETE`. Trigger de imutabilidade também barra alteração de digest, payload, configuração e identidade após reserva. Não guardar e-mail, corpo, telefone, segredo nem URL.
- [x] Criar RPC `reserve_whatsapp_ops_email_attempt` `SECURITY INVOKER`, `search_path=''`, apenas `service_role`: validar IDs, tipo, canal pertencente à unidade, digest/HMAC/versão e relógio; lock global e por unidade/tipo em ordem fixa; limitar 1 tentativa por unidade/tipo/30 min, 1 teste/24 h e 50 tentativas globais/24 h. Mesmo digest aceito retorna replay sem INSERT, digest diverso ou tentativa incerta não libera envio; teto inclui incertas.
- [x] Criar RPC para concluir `accepted` somente após id Resend, com transição cercada pelo id da tentativa e id remoto; outro ramo marca `uncertain`/`rejected` sem apagar reserva. Revogar `EXECUTE` de `public, anon, authenticated` com assinaturas completas e conceder só a `service_role`. Resposta SQL sem dado pessoal e sem oráculo para callers públicos.
- [x] Migration idempotente na reaplicação crua; se atomicidade cruzar statements, `BEGIN`/`COMMIT` explícitos. Fazer revisão de ACL, RLS, tenant, lock/corrida e plano de rollback forward-only.

## Task 2 — Pré-voo SQL isolado

Arquivos: `supabase/tests/local-preflight/` e README, com fixture descartável na versão PostgreSQL Supabase do projeto.

- [x] Provar reservas simultâneas para mesmo par e pares diferentes sem ultrapassar o teto global; provar janela de 30 min, 24 h do teste e 50/24 h, incluindo `reserved`/`uncertain`.
- [x] Provar replay aceito sem novo INSERT, digest diverso recusado, id de canal de outra unidade recusado, unidade inexistente recusada, `anon`/`authenticated` sem `EXECUTE` nem tabela e `service_role` com ACL mínima.
- [x] Provar transições `reserved→accepted`, falha de persistência simulada, retry incerto sem novo e-mail, recusa de `UPDATE` dos campos imutáveis via `service_role` e reaplicação da migration duas vezes. Controle positivo que remove temporariamente o lock/teto deve falhar, depois restaurar SQL original.
- [x] Registrar comandos, resultados e limites do ambiente local. Nenhuma execução no banco de produção.

## Task 3 — Núcleo puro do contrato e do e-mail

Arquivos previstos: `supabase/functions/_shared/ops-alert-email-core.ts`, testes Vitest em `src/lib/`.

- [x] Validar forma fechada dos três eventos, tipos/UUID/timestamp/campos extras e tamanho ≤2 KiB; teste sintético é rota separada com payload fixo. Canonizar bytes para digest e renderização determinística de assunto/texto/HTML a partir dos campos persistidos, com escaping e horário UTC/BRT; sem dados de cliente.
- [x] Implementar validação de token em tempo constante e HMAC-SHA256 da configuração `from/to/digest do template` com o token, incluindo versão do template. Readiness e **produção** recusam secret ausente, HMAC não aprovado ou mudança isolada de remetente, destinatário ou template; o teste sintético autenticado funciona **antes** do HMAC aprovado e devolve fingerprint opaco somente após aceite.
- [x] Cobrir 401/400/413/415, valores malformados e fronteiras; provar que campos livres, credenciais, telefone e payload bruto não entram em e-mail, erro ou log. Testes sem secrets reais.

## Task 4 — Receptor Edge e adaptador Resend

Arquivos previstos: `supabase/functions/whatsapp-ops-alert-email/index.ts`, adaptador local da função e `supabase/config.toml`. Não tocar `_shared/email.ts`.

- [x] `verify_jwt=false` explícito com `x-ops-alert-key` autenticado antes de JSON. `GET` de readiness é somente leitura; `POST /test` usa evento fixo e cota própria e só bypassa o gate do **HMAC aprovado**, mantendo auth/secret/teto, para permitir a prova antes da aprovação; `POST` produtivo valida recurso/tenant antes de reservar. Sem CORS público ou redirecionamento de provider.
- [x] Adaptador local usa Resend `POST /emails`, `Idempotency-Key` da reserva e corpo imutável; timeout 7 s, resposta 200 só após id remoto **e** confirmação SQL. Logs sanitizados; 409/idempotency mismatch, resposta sem id, timeout ou persistência incerta falham fechado sem retry automático.
- [x] Testes com DB/Resend falsos: auth, readiness sem custo, concorrência, aceite seguido de falha SQL, aceite lento/timeout, config alterada, replay aceito, 429/teto. `deno check` do bundle, sem rede real.

## Task 5 — Transporte operacional isolado e health

Arquivos previstos: novo `_shared/secure-ops-alert-sender.ts`, `_shared/ops-alert-runtime.ts`, `whatsapp-health/index.ts` e testes. Preservar `_shared/ops-alert-sender.ts`/`createTemplateAlertSender` e `WHATSAPP_TEMPLATE_ALERT_URL`.

- [x] Sender transmite token somente para URL **exata** `${SUPABASE_URL}/functions/v1/whatsapp-ops-alert-email`, sem query/fragment/credenciais/redirect, com timeout 20 s; configuração ausente/divergente fecha sem fetch. Testar host parecido, subpath, query e redirecionamento.
- [x] Ligar o novo sender apenas aos alertas operacionais de `manage-channels` e `process-whatsapp-channel-health`. `whatsapp-health` consulta readiness autenticada e distingue sender configurado de receptor pronto; `ops_alert_configured` só é true após HMAC aprovado, SQL disponível e cota livre. Falha de leitura fecha.
- [x] Testar caminho lento de ponta a ponta (reserva 2 s + Resend 7 s + update 2 s com margem de 9 s), ledger somente após HTTP 200 JSON `{accepted:true}`, timeout antes de ledger e conservação do transporte de templates. Recalcular grafo de imports; matriz esperada: nova EF + `manage-channels`, `process-whatsapp-channel-health`, `whatsapp-health`.

## Task 6 — Integração, segurança e entrega local

- [x] Rodar testes focados, pré-voo SQL, `npm run typecheck`, `npm run lint`, `npm run build`, `deno check` das EFs afetadas, `node scripts/ef-import-graph.mjs` e guardas ACL/migration. Ampliar testes apenas para risco concreto. Deno passou antes do último ajuste puro de fronteira de ano; tentativa de repetição neste shell não encontrou o executável, registrada abaixo.
- [x] Gates `saas-shield-br` proporcionais: RLS, isolamento de tenant, identidade/acesso, migration/ACL, secrets e confiabilidade de integração; revisar branch inteira e corrigir P0/P1/P2.
- [ ] Conferir check `acl-estatico` no PR após push autorizado.
- [x] Atualizar runbook e plano da Fase 6 com ordem de deploy, gates e limites; não marcar readiness nem Task 6.1/6.3 pelo teste local. Registrar evidências sem segredos/PII.
- [ ] Antes do commit: `git status`, `git diff`, `git diff --cached` integral, `git diff --cached --check`, varredura de toda linha staged, `git add` de caminhos explícitos e commit local. Push/merge somente após gates verdes; produção ainda NO-GO.

## Evidências

**Tasks 1–5, implementação local (2026-10-17):** cada task passou por implementer, review independente de spec e review independente de qualidade; os achados de readiness/ACL e ACK do sender foram corrigidos e revistos. Review integrado da branch: PASS, sem P0–P2. Nenhum bundle, migration ou secret deste plano foi publicado.

- **Task 1:** migration com `FORCE RLS`, ACL mínima, locks globais e por par, reserva e conclusão imutáveis. Reaplicação crua três vezes em PostgreSQL Supabase 17 descartável passou. Reviews de spec/qualidade: PASS; revisão incremental de migration/RLS/identidade/tenant: PASS ou PASS_WITH_WARNINGS sem achado bloqueante. Limites: UUID de evidência e FK `RESTRICT` exigem retenção/reconciliação operacionais.
- **Task 2:** `71-whatsapp-ops-email.sql` passou OPS1–OPS23; `71b-whatsapp-ops-email-concurrency.mjs` passou a corrida do mesmo par, teto global, controle positivo da 51ª reserva e restauração da função. O container local foi criado sem rede e sem portas; não houve acesso ao banco de produção. README registra cobertura e comandos.
- **Task 3:** 43/43 testes focados dos cinco arquivos passaram para contrato fechado, token/HMAC, digest/render e limites de segurança; revisão de spec/qualidade: PASS. Alteração futura do texto do e-mail exige nova versão de template e novo HMAC aprovado.
- **Task 4:** receptor autentica antes de parsear, separa readiness/teste sintético, reserva antes de Resend e só aceita resposta com id remoto e confirmação SQL. Adaptador falso cobre timeout/incerteza/replay/teto; review de spec/qualidade: PASS. Cold start e entrega real ainda não foram provados em ambiente hospedado.
- **Task 5:** sender usa endpoint exato, sem redirects, e exige HTTP 200 com `{accepted:true}`; consumidores e health usam o transporte próprio. Reviews de spec/qualidade: PASS. `node scripts/ef-import-graph.mjs` aponta receptor + três consumidores. Primeiro alerta de falha de assinatura pode alongar o fluxo por até 20 s; observar após publicação.

**Gates locais:** `npm run typecheck`, `npm run lint` (zero erros, 18 warnings anteriores), `npm run build`, 85/85 verificações estáticas/ACL e 43/43 testes focados passaram após o último ajuste de código; o grafo retornou exatamente quatro EFs. `deno check` dos quatro entrypoints passou antes do último ajuste de fronteira de ano no núcleo puro; a tentativa de repetir neste shell falhou por ausência do executável, e `npx deno` sem rede ficou sem resposta e foi interrompido. Os testes Vitest importaram e executaram o núcleo ajustado, mas não substituem o Deno remoto; CI/deploy devem repetir esse gate. `git diff --check` passou antes da última edição de evidência e será repetido no staged. Faltam revisão integral do staged, commit e CI `acl-estatico` para fechar a Task 6. Produção segue NO-GO para o receptor: migration, deploy, secrets, HMAC e teste real ainda carecem das respectivas autorizações/gates.
