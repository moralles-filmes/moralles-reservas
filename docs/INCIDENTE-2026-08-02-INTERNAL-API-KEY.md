# Incidente — `INTERNAL_API_KEY` em texto claro no repositório

> **Status:** `CONTIDO` — chave rotacionada, arquivo saneado, guardrail fechado.
> **Data da detecção e da contenção:** 2026-08-02
> **Severidade:** alta (chave de autenticação entre banco e Edge Functions)
> **Origem da detecção:** `GIT_HISTORY_SECRET_SCAN`, item de saída dos gates da Fase 6b

Este documento registra **tipo, local e veredito**. Ele **não contém o valor**
exposto, nem antes nem depois da rotação.

---

## 1. O que era

A `INTERNAL_API_KEY` — o segredo compartilhado que autentica as chamadas do
banco (wrappers `pg_cron` e triggers) para as Edge Functions, verificado por
[`requireInternalAuth`](../supabase/functions/_shared/security.ts).

Formato: hexadecimal de 64 caracteres. Ela é a **única** credencial que separa
um `POST` anônimo de uma execução legítima de worker: as EFs de worker rodam com
`verify_jwt=false` justamente porque o `pg_net` não carrega JWT.

## 2. Onde estava

| | |
|---|---|
| Arquivo | `supabase/migrations/022_reservation_source.sql`, renomeado depois para `20260506181440_022_reservation_source.sql` |
| Forma | header literal dentro de `create trigger ... execute function supabase_functions.http_request(...)` |
| Commit de introdução | `b5098c6` — 2026-05-06 |
| Commit da renomeação | `748f5d9` — 2026-05-17 |
| Presente em `HEAD` | sim, até o saneamento em 2026-08-02 |
| Janela de exposição | ~88 dias |
| Outras cópias no repo | nenhuma — a varredura encontrou **um** arquivo |
| Cópias em `.env` locais | nenhuma (verificado) |

O repositório é **privado**. Isso reduz a janela, não a elimina: colaborador,
integração, fork ou abertura futura expõem o histórico retroativamente, e
`push --force` não apaga o que já foi clonado ou indexado. É exatamente a
premissa registrada na seção de segurança do [CLAUDE.md](../CLAUDE.md).

## 3. Como escapou por 88 dias

Duas falhas independentes de detecção:

1. **O guardrail estático de migrations não tinha a forma.**
   [`scripts/migration-static-guard.test.ts`](../scripts/migration-static-guard.test.ts)
   cobria OpenAI (`sk-`), Anthropic (`sk-ant-`), xAI (`xai-`), Resend (`re_`),
   JWT (`eyJ`) e URL com credencial. **Nenhuma dessas formas casa com um hex de
   64 sem prefixo.** A chave passou por todas as execuções de CI como conteúdo
   inócuo.

2. **A migration é legada e allowlisted.** O arquivo já constava na
   `LEGACY_HARDCODED_URL` por embutir a URL do projeto de produção, o que
   normaliza a leitura do arquivo como "problema conhecido, frente separada".

## 4. Ampliação durante a investigação

Durante a apuração, o valor foi **exibido em texto claro na sessão de trabalho**:
o comando usado para inspecionar o trecho do commit histórico não mascarava a
saída, e a natureza real do achado (versus falso positivo) só ficou conhecida
depois de ele já ter sido impresso.

Consequência: o valor passou a existir também nos registros da sessão. Isso
**não alterou a conclusão** — a rotação já era obrigatória pelo achado no
histórico do git — mas **antecipou a urgência** e está registrado aqui por ser
parte honesta da superfície de exposição.

**Regra que fica:** inspeção de achado de secret scan usa saída mascarada. O
veredito "é real ou é falso positivo" se decide pela **forma e pelo contexto**,
não por ler o valor.

## 5. Contenção

Executada pelo responsável do projeto, na ordem abaixo. A ordem importa porque
`requireInternalAuth` compara com **uma única** variável de ambiente — não há
suporte a chave antiga e nova simultâneas, então alguma janela de `401` é
inevitável.

| # | Passo | Resultado |
|---|---|---|
| 1 | Geração de chave nova (`gen_random_bytes(32)`) | — |
| 2 | Segredo das Edge Functions atualizado no dashboard | propagação lenta, por isso vem primeiro |
| 3 | `vault.update_secret` sobre `internal_api_key` | `updated_at = 2026-08-02 16:03:19 UTC` |
| 4 | Verificação por `net._http_response` | `401` às 16:02 e 16:03; `200` de 16:04 em diante |

**Janela de `401`: ~2 minutos.** Sem perda de trabalho:

- o `401` acontece **antes** de qualquer processamento — nenhum worker consumiu
  tentativa, marcou linha ou incrementou `attempts`;
- os corpos das respostas `200` seguintes mostram `{"processed":0}` e
  `{"expired_count":0}` — não havia nada na fila no intervalo;
- **nenhum cron diário** cai às 16:0x UTC (os diários são 03, 06, 07, 08, 10,
  11, 12, 12:10, 13 e 17), então nenhuma execução diária foi afetada.

## 6. Saneamento do código

**A migration 022 teve o bloco `create trigger` removido**, e não apenas o valor
substituído por um placeholder. O bloco inteiro era código morto: a migration
seguinte ([028](../supabase/migrations/20260507153453_028_notification_outbox.sql))
dropa esse mesmo trigger e substitui a chamada direta pelo padrão outbox
(`enqueue_confirmation_notification` + `notification_outbox`). O trigger só
existia entre 022 e 028 — **a remoção é equivalente em replay**, e elimina de uma
vez o segredo e a URL de produção.

O `drop trigger if exists` foi mantido: ele é idempotente e continua correto em
banco que já tenha o objeto.

**O guardrail foi estendido** com a forma que faltava — header de autenticação
com valor **literal**. A regra distingue o padrão errado do certo: o correto
monta o header por concatenação a partir do Vault (`'...' || v_key || '...'`), e
a classe negada do regex faz a concatenação não casar. Foram verificadas as 15
migrations que mencionam `x-internal-key`: **todas** leem do Vault, nenhuma
reprova. Há controle positivo **e negativo** no teste — sem o negativo, apertar
o regex quebraria os wrappers de `pg_cron`.

## 7. Risco residual, aceito e explícito

**O valor antigo permanece no histórico do git e é irrecuperável de lá.** Não
houve reescrita de histórico. Justificativa:

- a rotação torna o valor **inerte** — é exatamente por isso que rotacionar vem
  antes de remover, e não depois;
- reescrever 376 commits numa branch com trabalho aberto tem risco operacional
  maior que o benefício de apagar um valor já morto;
- `push --force` não apaga clones nem índices já feitos, então a reescrita
  entregaria menos garantia do que aparenta.

Se o repositório for tornado público algum dia, esta decisão deve ser
**reavaliada antes** — não porque o valor volte a valer, mas porque expõe a
forma e o local de uso da credencial.

## 8. O que este incidente não tocou

- Nenhuma migration foi aplicada, nenhuma Edge Function foi deployada.
- A Fase 6b segue `NO-GO` para rollout, pelos motivos já registrados em
  [FASE-6B-GATES-SEGURANCA.md](billing-asaas/FASE-6B-GATES-SEGURANCA.md) —
  este incidente não é um deles, e sua contenção não altera aquele veredito.
- Nenhuma flag foi ligada. O Asaas segue em sandbox.

## 9. Procedimento de rotação

O passo a passo operacional (os dois lugares, a ordem, a janela segura em
relação aos crons) vive em
[RUNBOOK-ROTACAO-CREDENCIAIS.md](RUNBOOK-ROTACAO-CREDENCIAIS.md) §4. Este
documento registra o incidente; o runbook registra o procedimento.
