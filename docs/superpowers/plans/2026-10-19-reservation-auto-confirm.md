# Plano — confirmação automática de reservas

**Estado: publicado em 20/10; observação da primeira reserva nova pendente.** Aceite “Aprovo a spec e implementação” em 19/10 e autorização de publicação em 20/10. [Spec](../specs/2026-10-19-reservation-auto-confirm-design.md).

**Escopo desta publicação:** apenas novas reservas sem caução. Leituras de produção em Moralles Reservas em 19/10 e novamente em 20/10: 0 `hall_schedules` com cobrança ativa, 0 `special_dates` futuras com cobrança ativa e 0 reservas `pending_payment`. O responsável decidiu não ativar caução em nenhuma loja por enquanto. O estudo de Stripe/Pix foi preservado em trabalho local separado e não integra este pacote.

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

- [x] Review integrado, gates de segurança proporcionais, status/diff/staged integral/segredos, commit com caminhos explícitos, CI e `acl-estatico` verdes.
- [x] Apresentar matriz concreta de quatro EFs e efeitos para autorização própria; não há migration neste pacote.
- [x] Reconfirmar por leitura que `charge_enabled=true` continua ausente em schedules/datas futuras; responsável confirmou janela e que ninguém ativará caução durante a publicação. O check da EF e o INSERT são separados por uma pequena janela de corrida.
- [x] Com autorização específica, publicar os quatro bundles antes do frontend, merge/Vercel READY e conferir estado das EFs.
- [x] Observar uma nova reserva real sem caução entrando `confirmed/not_required` e uma única intenção de confirmação; teste com possível tarifa Meta feito somente com canal/custo/autorização vigentes.
- [x] Atualizar memória de reservas e billing com a regra sem caução e preservar o trabalho de Stripe fora do pacote.

### Evidência de produção da Task 3

- Branch `codex/reservation-auto-confirm-no-payment` no PR [#48](https://github.com/moralles-filmes/moralles-reservas/pull/48), commits `af499da` e `9047b81`. Review integrado sem P0/P1, diff staged integral e segredo revisados; Vitest focado 20/20, typecheck, lint, build e Deno check das quatro EFs exit 0. CI `acl-estatico` e Vercel preview passaram; PR sem conflitos.
- Em 20/10, o responsável autorizou nominalmente as quatro EFs, o merge/deploy Vercel e a janela, mantendo a caução desativada em todas as lojas. Alvo: Moralles Reservas `gbabxcrntkwgblgqsiit`; Ren Sushi no canal Datafy `d35128bb…`, assinatura existente R$ 49,90/mês. O deploy não fez teste pago; reservas reais ainda podem gerar tarifa normal de mensagem, cujo valor efetivo não foi comprovado.
- CLI `supabase functions deploy ... --project-ref gbabxcrntkwgblgqsiit --use-api --jobs 1` retornou exit 0 para cada função, com `--no-verify-jwt` somente nas três funções configuradas assim. Consulta posterior: `create-reservation` v44 ACTIVE/JWT false, `create-manual-reservation` v24 ACTIVE/JWT true, `update-reservation` v24 ACTIVE/JWT false, `webhook-whatsapp` v107 ACTIVE/JWT false.
- PR #48 foi mesclado em `main` no commit `50ed428e2048b5731421137f47dcfa88552244ad`. Vercel production deployment `dpl_2bEkm6vxNwkRW17JwQqRomVspV1b` ficou READY com esse SHA. Na leitura imediata havia 0 schedules com cobrança ativa, 0 datas futuras com cobrança ativa, 0 reservas `pending_payment` e 0 reservas criadas desde o merge; a observação ponta a ponta ainda estava pendente naquele momento.
- Depois, o responsável autorizou uma única reserva de teste para o contato controlado da Ren Sushi, com possível tarifa Meta no Datafy `d35128bb…`. A reserva criada às 10h57 BRT entrou `confirmed/not_required`; leitura isolada encontrou uma outbox de `confirmation` (`done`) e um único job v1 (`reconciled`, com ID de provider, sem reparo pendente). O responsável confirmou que recebeu **uma** mensagem v1. Nenhum v2 foi disparado. O teste fecha o checkbox de intenção única e entrega controlada; não prova todos os tipos de automação ou todas as lojas.

## Caução fora do escopo

Não ativar pagamento antecipado de reservas em nenhuma loja neste trabalho. Um projeto futuro para caução exigirá spec, revisão de Checkout/Pix e autorização próprios. Não há verificação pendente no Stripe para concluir esta publicação.
