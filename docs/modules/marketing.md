# Módulo: Marketing

**Contrato aprovado para implementação local na [spec](../superpowers/specs/2026-10-20-marketing-campaigns-design.md).**

- Chave: `marketing`
- Estado inicial: área de rascunhos e resultados, sem ativação/envio; publicar apenas após aplicar e validar as migrations, RPCs, ACL e gates.
- Entitlement: reutiliza a autoridade atual da organização para sistema/WhatsApp; não cria catálogo de módulos.

## Responsabilidade

Oferecer escolhas legíveis de programas de aniversário, fidelidade por visitas e pesquisa após fila, e mostrar resultados comprováveis da unidade. Giftback continua dono das regras/vouchers; WhatsApp continua dono de templates, consentimento, canal, despacho e recibos; plataforma continua dona de grants de custo.

## Ações e papéis

| Área | Owner | Gerente | Operador | Platform admin |
|---|---|---|---|---|
| Campanhas em rascunho | Criar/editar/arquivar/ler | Ler | Sem acesso | Ler |
| Resultados agregados | Ler | Ler | Sem acesso | Ler |
| Ativar, enviar, autorizar custo, submeter modelo | Fora do módulo | Fora do módulo | Fora do módulo | Fora desta entrega |

Não há chaves `<módulo>.<ação>` neste projeto: o acesso usa `unit_members.role` e `platform_admins`, com guarda no servidor.

## Dados e contratos

| Tabela/fonte | Escopo | Contrato |
|---|---|---|
| `marketing_campaign_drafts` (proposta) | Unidade | Rascunho/arquivo; FK para regra Giftback da mesma unidade quando aplicável; nenhuma relação de autorização com despacho. |
| `voucher_rules`, `vouchers` | Unidade | Leitura de regra e agregação; MARKETING não escreve. |
| `whatsapp_automation_jobs`, `whatsapp_automation_receipt_events`, `notifications_sent` | Unidade | Leitura agregada com correlação comprovada; legado identificado à parte. |
| `whatsapp_template_accounts` | Organização | Conta compartilhada observada apenas via binding validado da unidade; não recebe `unit_id` artificial. |

Invariantes: escolha de rascunho não ativa fluxo; consentimento e custo não são inferidos da escolha; erro de gate não vira pronto; mesma intenção não ganha nova versão/POST; Ren Sushi v1 permanece intacta; v2 requer reconciliação antes de qualquer ativação. A prontidão mostrada nos cartões lê o estado persistido do aviso oficial existente via ação interna `dispatch_status` e não libera o rascunho. Não há request ao provider. Métricas sem fonte confiável ficam indisponíveis.

Resultados Giftback são agregados por regra ou no grupo sem regra: `trigger_type` pode mudar e não há snapshot na emissão, então o histórico não é classificado retroativamente como aniversário/fidelidade. Jobs oficiais, de texto e sem canal definido aparecem em séries separadas. Jobs, recibos e a separação gerenciado/legado só são verificáveis para intervalos inteiros dentro dos 90 dias de retenção. A série gerenciada usa a data do fato; a legada usa a data do registro de envio, sem comparação diária direta. Custo Meta e retorno não são apurados.
