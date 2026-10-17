# Emenda ao gate de proveniência do IP da fila pública

- **Status:** critério alternativo aprovado expressamente pelo responsável em 2026-10-16, somente para o gate de IP da Fase 5. O rollout geral continua NO-GO.
- **Escopo:** somente a prova hospedada de `CF-Connecting-IP` da Task 5.5. Não autoriza `db push`, deploy da matriz, merge, operação do Ren Sushi ou chamada a provider.
- **Referências:** spec de migração §8, plano da migração Task 5.4/5.5, runbook Datafy §“Prova do cabeçalho de IP” e procedimento da sonda temporária.

## Critério original e resultado observado

Antes desta emenda, o procedimento exigia HTTP 200 e `{present:true, valid:true, equalsForgedMarker:false}` em ambos os GETs. Na sonda autenticada do projeto `Moralles Reservas` (`gbabxcrntkwgblgqsiit`), o responsável observou:

| Pedido | HTTP | `present` | `valid` | `equalsForgedMarker` |
|---|---:|---|---|---|
| Normal | 200 | true | true | false |
| Mesmo cliente, `CF-Connecting-IP` e `X-Forwarded-For` com marcador RFC 5737 | 403 | sem resposta da sonda | sem resposta da sonda | sem resposta da sonda |

O 403 trouxe `Server: cloudflare` e `CF-Ray` presente, o que comprova passagem pela Cloudflare, mas não identifica qual componente do ingresso gerou a resposta. A sonda só podia responder 200, 401 ou 405. Em consulta **agregada**, sem IP, chave ou conteúdo de headers, aos `function_edge_logs` do projeto entre 20:45 e 21:10 UTC em 2026-10-16, o pathname exato da sonda teve um 200, um 401 e zero 403. O 401 é compatível com a tentativa inicial com chave vazia; as duas tentativas forjadas receberam 403 no cliente. Assim, a evidência sustenta rejeição no ingresso hospedado antes da lógica da função, na rota testada. A sonda foi excluída e sua ausência foi confirmada na lista de Edge Functions.

## Critério alternativo aprovado

Aceitar, **para este gate**, a rejeição no ingresso hospedado antes da função como alternativa ao overwrite/remoção observado pela função, somente quando todos os pontos abaixo forem comprovados no mesmo alvo e janela:

1. GET normal autenticado devolve 200 e os três booleanos `true`, `true`, `false`.
2. GET da mesma origem com `CF-Connecting-IP` e `X-Forwarded-For` definidos pelo cliente devolve 403, com metadados de passagem pela Cloudflare.
3. O handler da sonda não produz 403, e os logs agregados da função mostram o GET normal, sem resposta 403 da função no período.
4. A função real da fila usa somente `CF-Connecting-IP` validado, sem fallback para `X-Forwarded-For`; a sonda e a fila compartilham o ingresso hospedado de Edge Functions no projeto.
5. A sonda temporária é removida do projeto e da branch; os demais gates e autorizações da Fase 5 continuam independentes.

Este critério demonstra que **o marcador forjado não alcançou o handler da sonda na rota e origem testadas**. Estender a observação à fila é inferência pelo ingresso compartilhado, não medição direta da função `public-waitlist`, ainda não implantada. O teste não demonstra overwrite/remoção em pedidos aceitos nem cobre todas as origens, variantes de header ou mudanças futuras no gateway. Nova prova ou ampliação do escopo deve ter plano, revisão e autorização próprios.

## Decisão e limite de autorização

Reviews independentes de spec e qualidade consideraram a rejeição anterior à função uma alternativa tecnicamente defensável para o caso observado, com as limitações acima. O responsável aceitou explicitamente este critério em 2026-10-16. Procedimento, runbook e plano foram atualizados; a prova de proveniência do IP só pode ser marcada como concluída após commit da retirada da sonda da branch, conforme condição 5. A janela operacional, auditoria ACL, autorizações de escrita/deploy, aprovação própria de `process-whatsapp-templates` e os demais gates da Fase 5 não foram concedidos por esse aceite.
