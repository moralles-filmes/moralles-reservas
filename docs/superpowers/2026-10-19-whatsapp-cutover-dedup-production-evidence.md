# Ren Sushi — publicação da proteção de antiduplicidade

## Autorizações e artefato

- O responsável autorizou expressamente a única migration e as seis EFs, manteve o backup físico COMPLETED de 19/10 às 02h48 BRT/PITR desligado e confirmou janela, aviso aos operadores e acompanhamento. Aceites anteriores de merge/Vercel e operacionais v1 com acompanhamento manual permanecem; MARKETING não foi liberado.
- Produto `816def7`; main integrada sem conflito em `336b8615`; checkpoint documental `a6d3ab44093cbdd3343f244639b2765f0fffe8e8`. No HEAD final do [PR #44](https://github.com/moralles-filmes/moralles-reservas/pull/44), ACL [39307131102](https://github.com/moralles-filmes/moralles-reservas/actions/runs/39307131102) e preview Vercel SUCCESS.
- Projeto: Moralles Reservas `gbabxcrntkwgblgqsiit`. Unidade Ren Sushi `9dc55e51-99b2-4536-b596-d25b88946b44`; canal local `a368bea2-90aa-4d81-880e-6d962255c4b0`, Datafy remoto `d35128bb-8ba8-412e-b9c1-6093085cf53a`; assinatura existente R$49,90/número/mês. Consumo normal Supabase/Vercel, sem valor exato de fatura disponível. Nenhuma chamada de teste/envio ou submissão Meta foi feita por esta publicação.

## SQL e ACL efetivos

- [x] Dry-run listou somente `20261019183559_whatsapp_legacy_managed_intent_fence.sql`, sem seeds/roles. SHA-256 `DB00FFFE186DF7B547DE199BCCBCD665AF4DA804128A022E02AF5B21CD8A153F`.
- [x] `supabase db push --skip-vault --linked --project-ref gbabxcrntkwgblgqsiit --yes` aplicou somente esse arquivo, exit 0. Histórico remoto confirmou a versão.
- [x] Leitura pós-SQL: três tabelas privadas ENABLE/FORCE RLS e ACL fechada para anon/authenticated/service_role; doze helpers/inners novos sem EXECUTE desses papéis. Quatro RPCs legadas e wrappers operacionais service-only; release somente authenticated com manager interno. Review independente offline confirmou a coerência com o SQL revisado.
- [x] Dispatch global false, zero bindings habilitados e zero marcadores Ren no gate pós-SQL. Nenhum gate foi ligado para facilitar deploy.

## Seis bundles e frontend publicados

CLI com os seis nomes explícitos, `--use-api --no-verify-jwt --jobs 1`, exit 0. Todas as versões abaixo ficaram ACTIVE com `verify_jwt=false`, correspondente ao config e à autenticação interna.

| EF | Antes | Publicada |
| --- | ---: | ---: |
| `send-whatsapp` | 70 | 71 |
| `send-confirmation` | 71 | 72 |
| `send-cancellation` | 46 | 47 |
| `send-manual-message` | 50 | 51 |
| `send-scheduled-whatsapp` | 5 | 6 |
| `process-voucher-triggers` | 25 | 26 |

As seis versões têm `updated_at` 19/10 19h02m51s UTC. `process-whatsapp-templates` não foi redeployada neste pacote.

- [x] PR #44 mergeado como `21852934acccb3d4c24bc929a8fed815dd038dd1`, às 19h03m19s UTC.
- [x] Vercel `dpl_9rUgH4UeU8SAGRtUkcdmKoTFCPA3`, target production, READY, commit exato acima e alias [reservas.moralles.com.br](https://reservas.moralles.com.br). Nenhuma promoção manual adicional.
- [x] Sessão real de platform admin recuperada no Chrome; cartão v1 em Canais da Ren Sushi mostra ainda não liberado, canal `a368bea2`, geração 1/revisão 0. Não se clicou em liberar antes de resolver o gate histórico.

## Drenagem observada e limite da prova

Consulta somente de metadados em `function_logs`/`function_edge_logs`, janela **18h30m00s–19h05m18s UTC**, preservando checagem de identidades ausentes. A cobertura geral teve 674 eventos, 158 boots, 158 shutdowns e 148 respostas HTTP concluídas; zero identidade incompleta e watermark 19h05m13s, cinco segundos antes do fim. **Não houve evento de execução dos seis IDs alvo nessa janela. Os 158/158 não são execuções alvo drenadas.**

O ROOT aceita a ausência observada de execução antiga no lookback completo como evidência operacional proporcional, em conjunto com manifesto ACTIVE/versões e fila/claims vazios, e com o [teto documentado de worker de 400 segundos](https://supabase.com/docs/guides/functions/limits). Não se usou apenas tempo decorrido. O [lifecycle documentado](https://supabase.com/docs/guides/troubleshooting/edge-function-shutdown-reasons-explained) diferencia término de worker de assentamento de efeito externo. Essa observação não é prova universal contra perda de logs ou callback ausente; resultados de negócio históricos permanecem um gate separado.

## Gate de negócio antes da ativação v1

Às **19h06m50s UTC**:

- [x] Zero intents ativos, zero outbox pending/processing e zero jobs claimed/posting/uncertain da Ren; dispatch false, zero bindings habilitados e zero custo MARKETING autorizado.
- [x] Nove v1 APPROVED/usable, identidade/hash/categoria correspondentes, sync_required zero. Última leitura mostrou oldest_sync 19h00m14s; frescor precisa ser revalidado na fronteira do envio.
- [x] Detectado `whatsapp_cutover_has_active_legacy_uncertainty=true`: três pesquisas de reservas, failed com provider ID, ainda elegíveis. Adoção e flag ficaram bloqueadas naquele ponto até a reconciliação abaixo.
- [x] Cada um dos três registros tem exatamente um `webhook_executions` de `status_callback`, mesma unidade/canal, ID do provider e `failed` no **mesmo índice** de `meta.ids`/`meta.statuses`, em até dois minutos de failed_at (callbacks de 17h00m18s–26s UTC). Não foram lidos telefone, texto de conversa ou credenciais.
- [x] Proveniência conferida: webhook valida assinatura/identidade antes do callback; `webhook_executions` tem FORCE RLS e zero policies, e notifications tem somente policies SELECT. Grants de tabela isoladamente não concedem escrita sob RLS. Antes da adoção, `admitAutomationReceipts` retorna legacy e não grava esses recibos no ledger novo; isso explica a ausência sem inferir zero POST.
- [x] Reconciliação operacional limitada a esses três callbacks reais, após aceite próprio “Autorizo os 3 recibos e 3 auditorias”. SQL congelado SHA-256 `78CFE7B4EDD29F5B195BAA3C72948F9CBBD613A4E5C1C24FE05177283296EF47`, spec ROOT e qualidade independente PASS; teste local válido/recusa/rollback/repetição PASS. Uma execução em produção, sem erro; leitura de **19h23m47s UTC** confirmou três receipts failed, três auditorias, três notifications ainda failed e incerteza ativa false. Dispatch e adoção continuaram OFF nessa conferência. [Evidência específica](2026-10-19-ren-sushi-legacy-receipts-reconciliation.md).

## Liberação operacional v1

- [x] Pré-voo às **19h25m09s UTC**: canal Datafy ativo/conectado, conta/binding verificados, geração 1/revisão 0, nove v1 APPROVED/usable com identidade/hash/categoria corretos, zero sync_required, zero intents/outbox/jobs ativos e zero incerteza histórica. A sincronização observada foi 19h21m19s; prepare/confirm continuam exigindo sync de até 60 segundos e atualização pelo worker antes do POST.
- [x] Pela sessão real de platform_admin, um clique em `Liberar despacho v1` e um em `Confirmar liberação v1`. A captura DOM posterior ao clique teve timeout; não se repetiu a operação. Leitura SQL às **19h26m07s UTC** confirmou binding enabled, uma única adoção de **19h25m51.335562s UTC**, geração/revisão intactas e flag global ainda false. A UI depois mostrou “Despacho v1 liberado neste canal” e “Liberação v1 registrada”.
- [x] Flag existente `whatsapp_automation_dispatch` false→true por uma transação administrativa já autorizada. Mutex da unidade, locks SHARE de bindings/jobs e CAS exigiram somente binding Ren habilitado, uma adoção, zero jobs alheios/ativos, canal/revisão esperados, ausência de incerteza e de custo MARKETING. A atualização exigiu exatamente uma linha. Pós-leitura às **19h27m37s UTC**: flag true, um binding enabled, somente Ren, uma adoção, zero grants MARKETING.
- [ ] Primeira reserva nova do mesmo contato controlado, uma confirmação v1, aceite/entrega e ausência de duplicidade no fato: solicitado ao responsável; pendente. A liberação dos gates não é prova de entrega.
- [x] Canal e custo reanunciados antes da liberação: Ren Sushi Datafy `d35128bb…`, assinatura R$49,90/mês existente; referência Datafy UTILITY R$0,035 por mensagem entregue, tarifa efetiva da conta Meta não confirmada. Alcance amplo e acompanhamento manual já aceitos; MARKETING segue bloqueado. Não se enviou mensagem artificial pela API nem se criou reserva em nome de cliente.

**Estado: proteção publicada e despacho operacional v1 habilitado somente na Ren Sushi; confirmação controlada/entrega ainda pendentes.** O despacho v2, as duas recusas Meta e o voucher externo continuam etapas posteriores; e-mail operacional permanece adiado por orientação do responsável.

## Limpeza local pedida pelo responsável

Em 19/10 foram removidos os sete contêineres descartáveis desta tarefa: `margin-cutover-dedup-sql-pg-r1`, `margin-template-v2-sql-pg` e variantes `-r2` a `-r5`, e `margin-template-auto-sql-pg`. Antes da exclusão, todos estavam parados, `network=none` e sem mounts; `docker rm` explícito concluiu com exit 0 e a listagem posterior não os contém. Os contêineres `barbadoskids-atendiai` pertencem a outro projeto e foram preservados.

## Revisão do registro

ROOT conferiu os resultados das operações e a leitura posterior; revisão documental independente `template_v2_integration_quality` PASS após qualificar os checkpoints antigos OFF/pendentes nos planos. Nenhuma entrega v1 foi declarada por essa revisão. A captura de screenshot do cartão falhou duas vezes; o DOM visível e o SQL confirmaram a liberação, mas não há imagem salva dessa operação. Planos e memória atualizados; primeira confirmação controlada permanece pendente.
