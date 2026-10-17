# Alertas operacionais WhatsApp por e-mail

Escopo: o receptor `whatsapp-ops-alert-email` atende **todas as unidades** do
projeto Moralles Reservas quando `WHATSAPP_OPS_ALERT_URL` está ativo. Os eventos
são `inbound_dead_letter`, `inbound_backlog_stalled` e
`datafy_subscription_failed`. O e-mail contém somente tipo, IDs técnicos,
contagem/idade quando cabíveis e horário UTC/BRT. Não contém cliente, telefone,
conversa, QR, credencial ou URL de conexão. O teste sintético é separado.

## Preparação e ativação

1. Aplicar a migration `20261017190000_whatsapp_ops_email_attempts.sql` com
   `supabase db push` **somente com autorização específica de produção**.
   Conferir `FORCE RLS`, ACL das três RPCs e a ausência de acesso por `anon` e
   `authenticated`. Nenhum SQL da migration deve ser colado no Studio.
2. Publicar o receptor e redeployar `manage-channels`,
   `process-whatsapp-channel-health` e `whatsapp-health` **somente com autorização
   específica de deploy**. Manter `WHATSAPP_OPS_ALERT_URL` ausente nesta etapa.
   Não redeployar `process-whatsapp-templates` por este fluxo.
3. Configurar `WHATSAPP_OPS_ALERT_TOKEN` aleatório de pelo menos 32 bytes,
   codificado em base64url sem padding, e `WHATSAPP_OPS_ALERT_TO` pelo canal
   seguro de Edge secrets. Reutilizar os Edge secrets existentes
   `RESEND_API_KEY`/`RESEND_FROM_EMAIL` apenas após conferir presença e
   remetente autorizado; não copiar valores para chat, repositório ou logs.
4. Autenticar `GET` do receptor: antes da aprovação de configuração, a
   readiness deve retornar 503. Rejeições de método, token e payload devem
   ocorrer sem e-mail. Obter autorização nominal do envio de teste, com unidade,
   canal, destinatário e cota/preço Resend confirmados. `POST /test` com corpo
   vazio consome no máximo **uma tentativa a cada 24 h**, incluída no teto do
   projeto; a resposta 200 com fingerprint só prova aceite do Resend e registro
   SQL. O responsável precisa confirmar o recebimento. Em timeout/503, consultar
   a tentativa e o painel Resend antes de repetir; nunca reenviar às cegas.
5. Com o fingerprint testado e autorização **separada para alertas automáticos
   globais**, configurar `WHATSAPP_OPS_ALERT_APPROVED_CONFIG_HMAC` e a URL exata
   `${SUPABASE_URL}/functions/v1/whatsapp-ops-alert-email`. Confirmar GET
   autenticado 200 `{ "ready": true }` e `ops_alert_configured=true` no health.
   A URL é global: ativá-la afeta todas as unidades, não apenas a Ren Sushi.

## Limites e monitoramento

- A reserva SQL é feita antes de qualquer POST ao Resend. O teto é **1 tentativa
  por unidade/tipo/30 min**, **1 teste sintético/24 h** e **50 tentativas em
  24 h móveis no projeto**, incluindo `reserved`/`uncertain`. O worker escolhe
  até quatro alertas por varredura de cinco minutos e alterna os candidatos;
  os demais ficam para varreduras posteriores. Uma falha não avança o ledger.
- `GET` de readiness verifica as RPCs de reserva e conclusão, ACL de escrita
  das colunas de estado e capacidade, sem e-mail.
  Health 200 não confirma leitura humana nem substitui o teste recebido.
  Readiness 503, teto cheio ou logs `unavailable` exigem inspeção manual da
  fila, dos canais e do Resend. Não interpretar silêncio de alertas como fila
  saudável.
- O produtor espera até 20 s; o receptor limita reserva/atualização SQL a 2 s
  cada e a chamada Resend a 7 s. Se a resposta for incerta, a linha permanece
  `reserved` ou `uncertain` e bloqueia novas tentativas do mesmo par sem prazo
  automático. O Resend documenta idempotência por 24 h para **mesma chave e
  mesmo corpo**; isso não é licença para retry automático após 24 h.

## Resultado incerto e reconciliação

1. Desativar `WHATSAPP_OPS_ALERT_URL` se o problema for sistêmico. Anotar id da
   tentativa e horário, sem copiar destinatário, corpo, credencial ou resposta
   bruta para o registro operacional.
2. Um operador autorizado verifica no painel Resend, pela chave de
   idempotência da tentativa, se houve aceite. Se houve, registrar o id remoto
   por procedimento administrativo auditado; se não houve, criar um registro
   externo de incidente com UUID opaco. Incerteza continua bloqueada.
3. Somente após prova de **não aceite** e autorização de nova tentativa/custo,
   um operador de banco autorizado pode chamar manualmente
   `app_private.reconcile_whatsapp_ops_email_attempt(attempt_id, evidence_id)`
   como `postgres`. A RPC não é acessível à Edge Function nem ao
   `service_role`; grava `rejected`, UUID de evidência e horário. O banco valida
   o formato do UUID, **não a existência do registro externo**: a checagem
   humana é obrigatória. Não use UUID inventado nem aplique SQL ad hoc para
   destravar a tentativa. Depois, observe a próxima janela normal e o teto.

## Mudança de configuração e retenção

- Para mudar token, remetente, destinatário ou template, desligar a URL antes,
  repetir teste recebido e obter nova autorização de ativação. Toda edição do
  renderizador exige elevar `OPS_ALERT_EMAIL_TEMPLATE_VERSION`, inclusive
  ramificações que não aparecem nos exemplos fixos do digest. O HMAC aprovado
  antigo falha fechado após a mudança de configuração/versão.
- Tentativas guardam metadados técnicos, sem corpo/e-mail. A FK da unidade usa
  `ON DELETE RESTRICT`: uma unidade com tentativa histórica **não pode ser
  excluída fisicamente** por este schema. Manter a unidade e planejar uma
  política de retenção/arquivamento com migration forward-only antes de qualquer
  exclusão. Não apagar tentativas ainda dentro das 24 h do teto nem para
  liberar custo. Nenhuma rotina de purga está incluída nesta entrega.

Fonte do contrato: [spec](superpowers/specs/2026-10-17-whatsapp-ops-alert-email-receiver-design.md)
e [plano](superpowers/plans/2026-10-17-whatsapp-ops-alert-email-receiver.md).
