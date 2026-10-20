# Reservas confirmadas sem aprovação manual da loja

**Estado: APROVADA para implementação e testes locais.** Em 19/10 o responsável respondeu “Aprovo a spec e implementação”, antes do código, conforme AGENTS.md §4. Requisito: reservas devem entrar confirmadas em todas as lojas; se a loja não conseguir atender, cancela a reserva. Publicação de novos bundles depende da autorização do pacote concreto.

## Regra de negócio

1. Toda nova reserva comum aceita pelas validações atuais de disponibilidade termina a criação com `status=confirmed`, para qualquer unidade. Não espera WhatsApp, e-mail, cron ou aprovação da loja. Falha de notificação não desfaz a reserva.
2. No fluxo público sem caução, o estado `confirmed` e `payment_status=not_required` são gravados no **INSERT único** da reserva, antes de o trigger de outbox observá-la e antes da resposta de sucesso. O hall usado para conferir cobrança é o escolhido pela disponibilidade, não uma pista não validada do navegador. Falha da leitura de cobrança impede o INSERT; falha do INSERT não pode ser apresentada como reserva confirmada.
3. Esta publicação não habilita caução em nenhuma loja. Se houver configuração ativa de cobrança para a data/hall selecionados, inclusive valor zero ou inválido, o fluxo público recusa antes do INSERT e orienta falar com o restaurante. O backend Stripe e os registros históricos ficam inalterados; o formulário público não inicia Checkout. Não há novas EFs de pagamento, alterações de webhook ou testes de cobrança neste pacote. Um rollout de caução exige spec, revisão e publicação próprias.
   A leitura da configuração e o INSERT não estão na mesma transação; durante esta publicação os operadores devem manter a cobrança desativada. Uma ativação concorrente de caução exigiria um guard transacional próprio no futuro.
4. Reserva manual do painel e reserva criada pelo agente sem caução também terminam confirmadas. O caller não pode solicitar aprovação manual com `status=pending` para uma nova reserva comum. A ação de criar reserva manual continua existindo; o que se elimina é a necessidade de aprová-la depois.
5. Disponibilidade, mesas, overbooking autorizado, bloqueios, antecedência, rate limit, consentimento e permissões de cancelamento continuam válidos. A loja cancela pelo fluxo existente; operador não ganha permissão de cancelamento. Não criar reservas indisponíveis automaticamente.

## Notificações e telas

- A outbox e o ledger de confirmação preservam a intenção única por reserva. Confirmar o estado no create não dispara uma segunda confirmação nem reenvia fatos aceitos. O envio continua sujeito a gates, canal, versão, consentimento, tarifa e guard de antiduplicidade existentes.
- Mensagem de sucesso e cartão da reserva usam o estado real. Reserva confirmada não promete entrega imediata de WhatsApp/e-mail; o envio ocorre em segundo plano. A UI conserva compatibilidade de leitura para reservas antigas `pending_payment`, sem ativar novas cobranças.
- Nenhuma promoção de status de nova reserva depende de sucesso do Resend ou da Datafy. Eventual compatibilidade com reservas pendentes históricas deve ser explícita e não pode confirmar caução não paga.
- Não fazer backfill em massa de reservas existentes, novos envios pagos ou alterações de cobrança nesta task. O teste v1 existente da Ren Sushi permanece registrado separadamente.

## Execução e prova

Implementer → review independente de spec → qualidade por task; review integrado e gates proporcionais antes de commit/push/merge. Testes fechados: criação sem caução confirmada no INSERT antes da resposta mesmo com providers indisponíveis; configuração ativa de cobrança ou erro de leitura falha fechado sem INSERT; erro de INSERT não devolve sucesso falso; nova reserva manual não pede aceite; UI reflete status real; uma intenção/outbox por reserva e nenhum POST extra. Typecheck, lint do delta, Deno e grafo exato dos bundles afetados. Sem provider real nos testes locais.

Produção: autorização própria da matriz final de EFs, CI verde, sequência segura EF antes de frontend, verificação por leitura e eventual único teste controlado com canal/custo/autorização definidos. A aprovação da regra não concede chamada paga, SQL em produção ou reenvio.
