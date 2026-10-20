# Plano — confirmação automática de reservas

**Estado: implementação e testes locais autorizados antes do código.** Aceite “Aprovo a spec e implementação” em 19/10. [Spec](../specs/2026-10-19-reservation-auto-confirm-design.md).

**Escopo desta publicação:** apenas novas reservas sem caução. Leitura de produção em Moralles Reservas em 19/10: 0 `hall_schedules` com cobrança ativa, 0 `special_dates` futuras com cobrança ativa (inclusive valores 0/nulos), 0 reservas `pending_payment`. O responsável informou que nenhuma loja usa caução hoje. O estudo de Stripe/Pix foi preservado em trabalho local separado e não integra este pacote.

## Task 1 — backend e autoridade do status

- [x] Mapear create público, manual e agente; congelar contrato do estado retornado e compatibilidade histórica, sem tocar o pagamento existente.
- [x] Gravar `confirmed` + `not_required` no INSERT de reserva pública sem caução, antes do trigger/outbox e da resposta; validar o hall escolhido e bloquear configuração de cobrança ou erro de leitura antes do INSERT. Impedir `pending` solicitado pelo caller como aprovação manual de nova reserva comum.
- [x] Preservar outbox/ledger/intent único e nenhum POST adicional; falha de provider não altera a reserva. Erro de INSERT ou leitura de cobrança falha fechado.
- [x] Testes fechados relevantes, Deno e grafo de bundles. Implementer → spec → qualidade → correções/aceite; evidência de comandos e resultados.

## Task 2 — frontend factual

- [x] Consumir o estado real retornado e atualizar sucesso público; não prometer entrega imediata. Preservar apenas leitura compatível do `pending_payment` histórico, sem iniciar novos fluxos de cobrança.
- [x] Preservar criação manual e cancelamento conforme papéis; nenhum backfill de status ou envio histórico.
- [x] Testes focados, typecheck, lint e build proporcionais; implementer → spec → qualidade → correções/aceite.

### Evidência local das Tasks 1 e 2

Implementer concluiu o pacote na branch `codex/reservation-auto-confirm-no-payment`; review independente de spec e qualidade: **PASS** após corrigir o ramo que ainda chamava Checkout. A EF pública seleciona `id,status,payment_status` do próprio INSERT e só responde sucesso se persistiu `confirmed/not_required`; a criação manual rejeita `pending`; o agente já passava `confirmed`. O trigger de outbox conserva `UNIQUE (reservation_id, kind)`. `useCreateReserva` recusa qualquer `requires_payment=true` ou resposta ambígua antes de montar sucesso; o wizard não redireciona para Checkout. Testes focados e de marketing: 24/24 no freeze do implementer; review independente repetiu 14/14 relevantes. `npm run typecheck`, ESLint do delta, `npm run build` e `git diff --check`: exit 0. `npx --yes deno@2.1.4 check` passou nos quatro entrypoints afetados. Grafo de `_shared/availability.ts`: `create-manual-reservation`, `create-reservation`, `update-reservation`, `webhook-whatsapp`. Nenhum provider, Stripe ou banco de produção foi chamado por esses testes.

## Task 3 — integração e publicação

- [ ] Review integrado, gates de segurança proporcionais, status/diff/staged integral/segredos, commit com caminhos explícitos, CI e `acl-estatico` verdes.
- [ ] Apresentar matriz concreta de EFs e efeitos para autorização própria. Nenhum SQL de produção é presumido; se necessário, especificar migration e obter autorização antes de aplicar.
- [ ] Reconfirmar por leitura que `charge_enabled=true` continua ausente em schedules/datas futuras e que operadores não ativarão caução durante a janela: o check da EF e o INSERT são separados por uma pequena janela de corrida.
- [ ] Com autorização, publicar bundles antes do frontend, merge/Vercel READY, conferir estado e uma intenção por reserva. Teste pago somente com canal/custo/autorização vigentes.
- [ ] Atualizar evidências, checkboxes comprovados e memória; commit/merge autorizados após gates.

## Trabalho futuro fora desta publicação — caução

- [ ] Antes de qualquer rollout de caução, revisar separadamente concorrência e idempotência do Checkout, confirmação assíncrona Pix, expiração e reconciliação de pagamento tardio; aprovar spec e matriz próprias.
- [ ] Confirmar no Stripe Dashboard os eventos realmente inscritos no endpoint (`checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`) e registrar evidência sem copiar segredo.
