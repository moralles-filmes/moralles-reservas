# Task 3 — guard EF do corte legado → gerenciado

Implementação local da [spec aprovada](specs/2026-10-19-whatsapp-legacy-managed-cutover-dedup-design.md), na branch `codex/whatsapp-template-versioned-dispatch`. Nenhum SQL, allowlist, flag, segredo, produção, envio externo, commit ou deploy foi operado por esta task. Task 2 mantém a autoridade SQL e será integrada/revisada separadamente.

## Delta de produto

- Novo `_shared/whatsapp-legacy-automation-post.ts`: DTOs fechados para claim/confirm/finish/release; razões desconhecidas, erro e shape inválido falham fechados. Não devolve erro cru do banco, intenção/fence ou credenciais ao caller HTTP. Não faz retry automático de RPC.
- `whatsapp-channel-service.ts` recebe intenção somente no selector interno `legacyAutomation`. O SELECT scoped traz a revisão junto da credencial; ambos são capturados antes da resolução de segredo. Claim ocorre após resolução/conectividade; confirm é o último `await` antes do callback síncrono já existente e do adapter. Esse ramo força `retryPolicy:'none'`; o ramo sem intenção conserva comportamento e callback existentes.
- Finish grava aceite/ID ou incerteza antes de retornar aos writers de notificação/histórico. Aceite sem ID é incerto. Erro de transporte, 5xx/429 ou recusa após posting não liberam o fence. Release usa apenas `confirmation_refused` após `allowed:false` explicitamente válido; timeout/erro/resposta inválida de confirm não liberam.
- Seleção, segredo ou conectividade scoped recusados antes do claim não criam uma notificação `failed` ambígua. Recusas e incerteza do guard também pulam projeções. Se a projeção lançar depois do aceite, o catch de `send-whatsapp` não fabrica um segundo registro `failed` sem ID.
- `send-confirmation` e `send-cancellation` constroem intenção da reserva lida, com origem estática do handler. Cancelamento conserva provider ID/rota no UPSERT de aceite.
- `send-whatsapp` verifica kind/dimensão/recurso/unidade e constrói a intenção local com origem estática. Campos de origem/fence/intent no body não concedem autoridade. As seis finalidades encaminhadas exigem recurso real; confirmação/cancelamento explicitamente declarados recebem 400 para usar a operação dedicada, sem virar envio livre.
- `process-voucher-triggers` captura o ID do INSERT vencedor e passa `voucher_id`. O encaminhador exige rule birthday/frequency da unidade. `after_rating`, ACK/feedback livre, chat, mensagem manual e billing não recebem intenção por analogia.

## Testes e limites

Os Request tests executam handlers/serviço/adapters reais por VM e transporte falso fechado. Os RPCs são **respostas fornecidas de I/O**, não uma cópia da autoridade ou dos locks SQL. O fixture T1 exige consumo das respostas de claim/confirm/finish pelos handlers reais; remover o guard deixa esses scripts sem uso e/ou falha os positivos. No misto, o resultado de enqueue que recusa a disputa é fornecido, logo **não prova** que o SQL o fará: essa prova pertence às Tasks 2 e 4.

Cobertura focada:

- Factory/DTO: oito kinds; revisão original durante rotação antes de claim e entre claim/confirm; erro/shape inválido; release somente em recusa conhecida; callback síncrono pós-posting; missing ID, falha de finish, late finish com mesmo fence, ID conflitante e dependência de segredo recuperável; ramo manual/sem intenção preservado.
- Request: seis kinds no encaminhador; confirmação e cancelamento pelas rotas dedicadas; voucher birthday/frequency conserva o ID real do INSERT; body forjado e dimensão/recurso alheio/after_rating recusados; network/503/429/missing ID fazem no máximo um POST; dependência anterior ao claim se recupera sem recibo ambíguo; projeção que lança depois do aceite não fabrica `failed` nem repete POST.
- T1: sete controles agora exercitam o guard JS com replies SQL explícitos, inclusive legado×legado, lembrete legado em voo×novo produtor após adoção causal, aceite sem notificação, `failed` com ID remoto preservado e cutoff correto da confirmação.
- Regressões existentes: 186 testes de roteamento de reserva/fila/voucher/cancelamento passaram; os novos asserts de claim/origem/ID em cancelamento e birthday/frequency passaram em três testes focados. Canal (59), janela de mensagem manual (6), harness (17), wiring multiprovider (20), paridade de conversa (13) e autorização EF (5) passaram nos gates proporcionais executados.

Comandos executados:

```text
npx vitest run src/lib/whatsapp-legacy-automation-post.test.ts src/lib/whatsapp-legacy-automation-request.test.ts src/lib/whatsapp-cutover-dedup.test.ts --reporter=dot
npx vitest run src/lib/whatsapp-reservation-automation-routing.test.ts src/lib/whatsapp-waitlist-voucher-routing.test.ts src/lib/whatsapp-cancellation-routing.test.ts src/lib/whatsapp-waitlist-ready-routing.test.ts --reporter=dot
npx vitest run src/lib/whatsapp-template-channel-routing.test.ts src/lib/whatsapp-reservation-automation-routing.test.ts src/lib/whatsapp-waitlist-voucher-routing.test.ts src/lib/whatsapp-cancellation-routing.test.ts src/lib/whatsapp-waitlist-ready-routing.test.ts src/lib/whatsapp-manual-service-window-request.test.ts --reporter=dot
npx vitest run src/lib/edge-request-harness.test.ts src/lib/whatsapp-multiprovider-wiring-guard.test.ts src/lib/whatsapp-conversation-parity-guard.test.ts src/lib/authz-ef-guard.test.ts src/lib/whatsapp-legacy-automation-post.test.ts src/lib/whatsapp-legacy-automation-request.test.ts src/lib/whatsapp-cutover-dedup.test.ts --reporter=dot
npm run typecheck
npx eslint <13 caminhos TS explícitos desta task>
deno check --cached-only --no-lock <seis entrypoints abaixo>
git diff --check
node scripts/ef-import-graph.mjs supabase/functions/_shared/whatsapp-channel-service.ts
node scripts/ef-import-graph.mjs supabase/functions/_shared/whatsapp-legacy-automation-post.ts
```

O comando de canal/manual foi executado como parte de um gate inicial de seis arquivos; esses dois arquivos passaram (65 testes). As 19 falhas iniciais nos quatro arquivos restantes eram fixtures sem o novo RPC ou sem retorno do INSERT; foram corrigidas no I/O de teste sem relaxar assertions de produto, e os quatro arquivos passaram na rodada de 186 testes. Deno inicialmente encontrou oito TS2339 no SELECT condicional do SDK; a consulta foi separada por dimensão e o gate real voltou a passar.

Rodada final: **55 controles novos/T1 PASS**, `npm run typecheck` exit 0, ESLint dos 13 caminhos explícitos exit 0, Deno dos seis entrypoints exit 0 e diff/whitespace sem problemas. Sem suíte completa; reviews independentes de spec/qualidade e a integração SQL permanecem gates do ROOT.

## Grafo de bundles e publicação futura

Ambos os grafos compartilhados retornam exatamente cinco consumidoras: `send-cancellation`, `send-confirmation`, `send-manual-message`, `send-scheduled-whatsapp`, `send-whatsapp`. O produtor `process-voucher-triggers` também foi alterado diretamente. Deno foi executado nesses **seis** entrypoints, com cache local existente; nenhum pacote foi instalado.

Isso é inventário local, não autorização nem prova de publicação. A migration precisa preceder os bundles; dispatch permanece OFF durante a transição. SQL e bundles novos não eliminam invocação antiga já em voo. A ativação continua dependente de revisão SQL, CI/gates, drenagem comprovada, reconciliação de histórico/uncertain e autorizações de produção do responsável. Nenhum status deste documento comprova exclusividade no banco ou no provider real.
