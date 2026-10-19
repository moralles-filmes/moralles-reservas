# Task 2 — fence SQL legado → gerenciado (evidência local)

Escopo: `20261019183559_whatsapp_legacy_managed_intent_fence.sql`, sem operação de produção, provider, canal ou deploy. O arquivo foi gerado pela CLI depois da migration `20261019180000_settings_write_role_guard.sql` já presente em `main`. Após a troca de timestamp, dois achados da revisão preliminar foram corrigidos: autorização antes da descoberta do canal no wrapper e permit de adoção vinculado à identidade da operação e ao `now()` do trigger existente. O arquivo final foi reaplicado e retestado.

## Ambiente

- PostgreSQL 17.11.0.004 em container descartável `margin-cutover-dedup-sql-pg-r1`, `--network none`, sem portas publicadas.
- Bootstrap local `73-template-auto-bootstrap.ps1`, seguido das migrations já existentes `20261017130000`, `20261017140000` e `20261017150000`. O bootstrap compacto omite `waitlist.notified_at`; o harness 76 a cria só dentro de transação com `ROLLBACK`, como o harness 67b.
- Migration Task 2 aplicada e reaplicada com `psql -v ON_ERROR_STOP=1`: ambas passaram. A reaplicação não criou grants ou objetos duplicados.

## Gates executados

| Gate | Prova | Resultado |
|---|---|---|
| Contrato, ACL e bypass | `76-whatsapp-cutover-dedup.sql` com `ROLLBACK` | PASS: RPC service-only, tabelas/inners privados, não administrador recebe 42501 antes da descoberta tanto de canal conhecido quanto desconhecido; canal de outra unidade, recurso inexistente e voucher `after_rating` recusados; claims válidos e repetidos de `waitlist_entered` e voucher `birthday` passam/recusam respectivamente; INSERT direto em adoption e re-enable direto de binding negados com 42501; claim/revisão/lease one-use; release pré-POST com novo fence; posting/uncertain sem replay; aceite tardio com mesmo fence; ID divergente recusado. |
| Histórico e adoção | Mesmo harness | PASS: `notifications_sent.sent_at` default em `failed` não conta como aceite; falha sem ID e `failed` com ID mais receipt de tupla errada mantêm claim/adoção bloqueados; receipt `failed` de tupla completa transforma o fato em aceite terminal sem permitir novo POST, e permite adoção de fatos novos; legado tardio após adoção é negado. |
| Núcleo gerenciado final | Mesmo harness | PASS: enqueue idempotente; marcador legado sintético bloqueia prepare e confirm finais; marcador gerenciado válido permite ambos; finish aceito deixa job e marcador em `accepted` na mesma transação. |
| Sessões PostgreSQL concorrentes | `76-whatsapp-cutover-concurrency.mjs` | PASS: `pg_stat_activity` mostrou `Lock:advisory` no backend B antes do commit A nos dois interleavings da mesma unidade; a linha rotulada da RPC B retornou JSON `allowed=false, reason=intent_owned` para claim concorrente e `ADOPTION_RESULT=false` para adoção com claim ativa. Duas sessões liberaram simultaneamente dois bindings de unidades diferentes na mesma conta WABA da organização: ambas retornaram true, ficaram duas adoções por unidade e uma conta compartilhada, sem deadlock. |
| ACL estático | `npx vitest run scripts/function-acl-allowlist.test.ts` | PASS: 79 testes, inclusive novas funções privadas sem EXECUTE público. |

Limite: o harness SQL exercita confirmação, entrada na fila e voucher programado como amostras dos oito tipos; a cobertura causal das rotas EF e dos demais tipos pertence às Tasks 1 e 3. Os interleavings comprovam a ordem de bloqueio testada e a ausência de deadlock na liberação concorrente de duas unidades com a mesma WABA, sem provar ausência de todo deadlock possível ou entrega exatamente uma vez pelo provider. O backfill de jobs gerenciados existentes não chama provider; a tabela de marker não tem FK para job e preserva a chave privada após sua purga.

Antes de qualquer rollout: reviews independentes de spec/qualidade, CI e gate de produção da spec. Não houve `db push` nem chamada de produção nesta Task.
