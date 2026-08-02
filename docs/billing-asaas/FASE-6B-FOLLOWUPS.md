# Fase 6b — Follow-ups formais

Dois requisitos que **não** entram na 6b e **não** reabrem o lote de
estabilização. Ambos nascem de achados aceitos com justificativa na passada
final dos gates (commits `19f8e53` e `e446ba3`).

O primeiro é **bloqueante para uma ativação específica**. O segundo é melhoria
de diagnóstico sem gate associado.

---

## 1. `ADMIN_ZAPI_ALERT_TRANSACTIONAL_ENQUEUE`

> **Status:** `REQUIRED_BEFORE_DISPATCH_ON`
> **Origem:** `IR-001` (P2), passada final do `integration-reliability-auditor`
> **Bloqueia:** ligar `billing_notifications_dispatch` para os seis
> `admin_zapi_*`

### O gate, em uma frase

**`billing_notifications_dispatch` NÃO pode ser ligado para os seis eventos
`admin_zapi_*` enquanto este requisito não estiver implementado e validado.**

Eventos afetados:

| `event_type` | Origem |
|---|---|
| `admin_zapi_cycle_d7` | `CYCLE_DUE_SOON` |
| `admin_zapi_cycle_d1_action_required` | `CYCLE_DUE_TOMORROW` |
| `admin_zapi_end_confirmation_required` | `END_CONFIRMATION_REQUIRED` |
| `admin_zapi_date_review_required` | `DATE_REVIEW_REQUIRED` |
| `admin_zapi_divergence` | `DIVERGENCE` |
| `admin_zapi_economic_imbalance` | `ECONOMIC_IMBALANCE` |

Painel e ledger **podem** operar normalmente com o dispatch OFF — é o modo
previsto da fase. O que está barrado é o envio real.

### O risco residual que o gate existe para conter

A escrita do lembrete tem três tempos ([whatsapp-instance-worker-core.ts](../../supabase/functions/_shared/whatsapp-instance-worker-core.ts)):

1. **toca** o ledger sem consumir o lembrete — é **barreira de persistência**,
   não registro de envio;
2. **cria** a linha em `billing_notifications`;
3. **carimba** no ledger que o enfileiramento ocorreu e avança os campos
   semânticos (`last_reminder_at`, `occurrences`).

Isso elimina os dois defeitos anteriores: não consome o slot mensal quando nada
foi enfileirado (F-08), e não enfileira indefinidamente quando o ledger está
indisponível (IR-001).

**Resta o intervalo entre 2 e 3.** Se o passo 3 falhar depois de o passo 2 ter
concluído, o ledger não reflete o enfileiramento e a execução seguinte pode
criar uma duplicata — repetindo enquanto o ledger não registrar o enqueue
anterior.

**Por que o banco não segura:** o índice único de `billing_notifications` é
**parcial** (`where invoice_id is not null`, [migration 068](../../supabase/migrations/20260719150000_068_billing_notifications_cycle.sql)),
e **todo** aviso desta fase vai com `invoice_id` nulo. Não existe `23505`
possível para este produtor — cada `INSERT` sucede.

**Com dispatch OFF**, uma duplicata de fila é defeito de dados e telemetria.
**Com dispatch ON**, vira e-mail duplicado para o administrador. O risco é
aceito só enquanto a flag estiver desligada.

### Escopo do trabalho futuro

- RPC transacional (ou mecanismo equivalente) que crie a linha da fila e
  atualize o estado de enqueue no ledger **na mesma transação**
- Deduplicação **no banco** para alertas sem `invoice_id`
- Retry idempotente
- Tratamento explícito de conflito
- Teste de concorrência
- Compatibilidade com as linhas já existentes em `billing_notifications`

### Critério de conclusão

Duas execuções concorrentes do worker sobre o mesmo alerta vencido produzem
**exatamente uma** linha em `billing_notifications`, provado contra banco real —
não contra bancada. Enquanto `DATABASE_TRANSACTION_TESTS` estiver
`ENVIRONMENT_BLOCKED`, este requisito **não pode ser declarado concluído**.

---

## 2. `RESOLVE_PLATFORM_ADMIN_RECIPIENTS_ERROR_DISCRIMINATION`

> **Status:** `ACCEPTED_P3_WITH_FOLLOW_UP`
> **Origem:** `IAA-03`, passada final do `identity-access-auditor`
> **Bloqueia:** nada

### O defeito

[`resolvePlatformAdminRecipients`](../../supabase/functions/_shared/billing-notify.ts)
devolve `[]` tanto em **falha de leitura** quanto em **tabela vazia**. O worker
então trata "não consegui ler `platform_admins`" como "não há administrador".

### Por que foi aceito, e não corrigido na 6b

- A consequência atual é **adiar a tentativa**, não perdê-la: o núcleo preserva
  o slot mensal quando não há destinatário, e o worker é diário.
- É **barulhento**: `wa_alert_no_admin_recipient` e
  `wa_alert_reminder_no_recipient`, ambos com `needsAdminAction`.
- A 6b **ainda não foi deployada** — o defeito não está em produção.
- O helper é compartilhado por **dez consumidores** de outras fases; mudar a
  assinatura arrasta redeploy coordenado de billing inteiro.
- Expandir o escopo logo depois de uma estabilização aumenta o risco em vez de
  reduzi-lo.

### Escopo do trabalho futuro

- Retorno que **discrimine** sucesso-vazio de falha
- Erro estruturado (não `[]`, não exceção solta)
- Telemetria distinguindo os dois casos
- Análise de impacto nos consumidores existentes
- Checklist de redeploy no CLAUDE.md, atualizado no mesmo PR

**Regra que fica valendo desde já:** código novo **não** deve esconder falha
como lista vazia. Isso não autoriza reabrir a 6b para corrigir o existente.

---

## O que estes follow-ups NÃO são

Nenhum dos dois é pendência de rollout da 6b. O rollout está barrado por outros
motivos — ambiente incapaz de validar banco, migrations não aplicadas, EFs não
deployadas. Ver [FASE-6B-GATES-SEGURANCA.md](FASE-6B-GATES-SEGURANCA.md).
(`GIT_HISTORY_SECRET_SCAN` deixou de ser pendência em 2026-08-02: executada, um
incidente encontrado e **contido**.)

O primeiro follow-up entra no GO/NO-GO **de uma decisão futura e específica**:
ligar o envio de e-mail dos alertas administrativos.
