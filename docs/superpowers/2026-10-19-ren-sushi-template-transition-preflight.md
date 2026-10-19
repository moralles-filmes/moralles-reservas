# Ren Sushi — pré-voo de transição e consulta Datafy

## Escopo autorizado

Em 19/10/2026 o responsável autorizou operar v1, implementar seleção v2 e investigar o painel Datafy. Depois do esclarecimento do alcance, confirmou mensagens operacionais v1 da Ren Sushi e acompanhamento manual enquanto alertas não configurados, mantendo MARKETING bloqueado. Informado canal Datafy remoto `d35128bb…`, local `a368bea2…`, assinatura já ativa R$49,90 por número/mês e referência UTILITY de R$0,035 por mensagem entregue no Brasil. A [documentação oficial Datafy](https://developers.datafyapi.com.br/guias/whatsapp/conceitos/cobranca) qualifica esse valor como estimativa; a tarifa efetiva da conta Meta não foi comprovada.

A captura posterior do responsável mostrou que o fluxo anterior já envia pesquisas e agradecimentos. O esclarecimento correto é: **despacho gerenciado OFF não significa que todas as automações WhatsApp estão desligadas**. Pesquisa e agradecimento após nota são intenções diferentes; contá-los juntos produziria falso positivo de duplicidade.

## Leituras sanitizadas do alvo

Alvo Moralles Reservas `gbabxcrntkwgblgqsiit`, unidade `9dc55e51-99b2-4536-b596-d25b88946b44`, binding `69247a84…`. Não foram lidos corpos de conversa, telefone, credenciais ou evidências pessoais nas consultas SQL.

- [x] Pré-voo: nove v1 APPROVED/usable, IDs presentes, hashes e categorias correspondentes, sync_required zero; conta/binding verificados, canal ativo/conectado/assinado, sem pausa/cancelamento e saúde recente; geração 1/revisão 0, sem adoção anterior.
- [x] Dispatch global/binding OFF; zero outros bindings com dispatch e zero autorizações de custo MARKETING vigentes. Nenhum grant/custo/consentimento foi criado para facilitar o teste.
- [x] Leitura de 14h25 BRT: zero jobs gerenciados Ren e zero notification_outbox pending/processing; últimos registros incluem seis pesquisas com recibo entregue (duas também lidas na consulta desde 17/10). O fluxo atual efetivamente entregou mensagens.
- [x] Desde 17/10, registros Datafy com status failed também têm ID remoto e failed_at: confirmação 1; lembrete 2; pesquisa 13; entrada na fila 1; feedback da fila 1. Esses fatos são correlação de POST/aceite com entrega falha, não prova de zero POST. Não se alterou estado nem se executou retry.
- [ ] Ausência de duplicação na transição: **não comprovada**. Zero jobs/outbox não comprova ausência de HTTP legado em andamento. Revisão independente identificou dois P1: corrida legado em POST × adoção/gerenciado e aceite com falha de projeção local; índices únicos da notificação/ledger não impedem ambos os HTTPs.

## Gate de antiduplicidade

O responsável aprovou explicitamente a [emenda de exclusividade](specs/2026-10-19-whatsapp-legacy-managed-cutover-dedup-design.md) para implementação/testes locais. O [plano](plans/2026-10-19-whatsapp-legacy-managed-cutover-dedup.md) exige ownership durável antes de HTTP, mesma chave unit/kind/recurso entre produtores e versões, preservação de aceite/incerteza e controles de concorrência reais. A autorização operacional v1 permanece, mas a ativação está NO-GO até a prova e o rollout próprios. Não houve alteração de flag/grant/adoção ou envio de teste a cliente durante este pré-voo.

## Investigação e suporte Datafy

- [x] Sessão Datafy legítima no canal correto; áreas Eventos, Disparos e Visão geral consultadas sem mudança de configuração ou submissão.
- [x] Eventos 13h48m41s/13h48m55s BRT mostram `fila_entrada_v2` e `fila_mesa_pronta_v2` REJECTED/INCORRECT_CATEGORY, categoria UTILITY. Não se deduziu categoria aprovada nem se abriu recurso.
- [x] Não há evento do voucher nem log de erro do POST exposto nessas áreas. O motivo de `provider_rejected` continua desconhecido. Não se conclui que emoji ou parágrafos causaram a falha.
- [x] Responsável autorizou expressamente uma consulta técnica ao suporte WhatsApp indicado pela Datafy, contendo somente canal prefixado, modelo, idioma, horário e pedido do código/motivo e de eventual criação remota; sem payload, token, telefone de cliente ou cartão. A consulta proíbe reenvio/edição/submissão.
- [x] Uma única consulta foi enviada pelo WhatsApp Web às **14h36 BRT** e a UI mostrou **Delivered**. As tentativas anteriores de abrir o link tiveram timeout; o estado foi reconciliado antes de escrever/enviar. Nenhuma segunda mensagem foi enviada. Screenshot da conversa apenas, sem lista de contatos: `.superpowers/sdd/2026-10-19-whatsapp-template-v2/support-datafy-voucher-query.jpg` (ignorado; não commitar).
- [ ] Resposta técnica do suporte e correção do voucher: pendentes. O responsável acompanhará o suporte e trará a resposta nesta conversa; pediu foco nas demais entregas. Não consultar nem enviar follow-up automaticamente. O chamado não autoriza rePOST, edição ou recurso. Preservar os nove v1 e os nove outcomes v2 já registrados.
