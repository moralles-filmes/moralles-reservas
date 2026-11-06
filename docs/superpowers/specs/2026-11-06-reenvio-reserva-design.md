# Reenvio de reserva devolve a existente (F-002B) + resposta sem dados do cadastro (F-004)

Aprovado pelo dono em 2026-11-05 (itens) e 2026-11-06 (regras abaixo). Origem: integration-reliability-auditor da escolha de mesa (F-002, F-004).

## F-004 — resposta pública sem dados do cadastro
`create-reservation` é anônima e o telefone não é verificado. A resposta devolve só o que o visitante digitou (nome, telefone, e-mail) mais os dados da reserva (id, código, mesa, status). Nunca o nome/e-mail do cadastro achado pelo telefone. Vale também para a reserva reaproveitada.

## F-002B — "mesmo pedido" devolve a reserva que já existe
Mesmo pedido = mesmo cliente + mesma unidade + mesma data + mesmo horário (HH:MM) + mesmo número de pessoas, reserva `pending`/`confirmed`, criada há até 15 minutos.
- Cliente: portal e WhatsApp, o `customer_id` resolvido pelo telefone. Instagram (identidade declarada), só reservas do ledger do contato.
- Mesa ou salão diferentes no reenvio não contam: devolve a existente (troca de mesa continua com a equipe).
- Número de pessoas diferente = pedido novo (fluxo normal).
- Checagem antes do INSERT e de novo depois de `seat_unavailable`/`insert_failed` (cobre a corrida com mesa escolhida, em que a própria reserva ocupa a mesa).
- Resposta: sucesso com `already_existed: true` e os dados da reserva existente. O agente recebe "a reserva já estava criada" com o código; o desfecho conta como concluído.
- Busca com service role filtra sempre `unit_id` e `customer_id`; erro de leitura não bloqueia nem inventa reserva: segue o fluxo normal (falha aberta para criar, documentada no código).

## Fora do escopo
- Dois envios simultâneos sem mesa escolhida ainda podem gerar duas reservas (decisão do dono: sem migration/trigger).
- Caução: nenhum caminho do cliente cria reserva com caução hoje. Se voltar a existir, o reaproveitamento tem de devolver o mesmo pagamento pendente e nunca criar um segundo.
- Reserva manual da equipe (`create-manual-reservation`).
