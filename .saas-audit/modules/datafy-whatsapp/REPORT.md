# Auditoria de módulo — datafy-whatsapp

**Escopo:** integração Datafy no provider de WhatsApp. Branch `feat/datafy-whatsapp-oficial`, worktree `.claude/worktrees/datafy-oficial`, commits `e493a89..83eaa0c`.
**Gatilho:** `audit_required=true` do ai-router-br nas Tasks 2, 3 e 5, adiada por ruling até o caminho de auth estar ligado.
**Modo:** `--fix`, com correção passando pela disciplina de fix round + re-review do SDD.

**Veredito: PASS. Zero P0, zero P1.**

---

## Mapa do módulo

```
Meta/Datafy (tráfego NÃO confiável, sem auth de usuário)
  → POST webhook-whatsapp?channel=<uuid>   (público, verify_jwt=false)
  → req.text()                              [corpo cru, único no arquivo]
  → resolve canal: searchParams "channel" → SELECT em whatsapp_channels   ← NÃO vem do corpo
  → WEBHOOK_SIGNATURE_SCHEME[provider] escolhe o verificador:
       meta_app_secret → validateMetaSignature(x-hub-signature-256, app_secret, corpo)
       datafy_whsec    → verifyDatafySignature(x-datafy-signature-256 + x-datafy-timestamp,
                                               whsec_ do canal, "{ts}.{corpo}")
       channel_secret  → validateChannelSecret(webhook_secret por canal)   [zapi/waha/uazapi]
  → 401 se falhar
  → metaPayloadMatchesChannel(payload, credentials.phone_number_id)   [guarda cross-tenant]
  → JSON.parse                              [único, DEPOIS do 401]
  → splitMetaWebhookPayload → filho com trustedMetaPayload=true, dois headers de assinatura apagados
  → isMetaShapedProvider(provider) escolhe o parser
  → parseOfficialInbound                    [datafy reusa por IDENTIDADE de referência]
  → processed_messages (provider, message_id), claim cercado por UUID, takeover 90s
  → conversations → debounce 6s → lock ai_lock_until 90s → runAgentLoop → sendOutbound
```

Outbound: `sendDatafy` → `buildDatafyRequest` (token em header) → `fetchProviderWithTimeout(url, init, 3)` → `classifyDatafyStatus` → `pickDatafyMessageId` → correlação de recibo por `(unit_id, whatsapp_provider, whatsapp_channel_id, provider_message_id)`.

**Dependências tocadas fora do módulo:** nenhuma. A mudança é aditiva; os quatro providers existentes são byte-a-byte idênticos nos ramos alterados.

---

## Auditores selecionados, e os que não foram

Selecionados por risco, não mecanicamente:

| Auditor | Por quê | Veredito |
|---|---|---|
| `integration-reliability-auditor` | webhook + API externa + idempotência — o ângulo menos coberto pela review de segurança | PASS_WITH_WARNINGS |
| `tenant-isolation-auditor` | RLS é `FORCE` sem policies neste caminho, então a separação depende inteiramente do código da EF | PASS |
| `secret-hunter` | a branch tocou `.ai-router/`, `CLAUDE.md` e `AGENTS.md`, e vai para `main`, que dispara deploy | PASS_WITH_WARNINGS |

Não selecionados, com motivo declarado:

- `rls-auditor` — nenhuma migration nesta branch (é a Task 4). Roda depois dela.
- `identity-access-auditor` — o diff não toca membership, papel nem convite; o webhook não tem auth de usuário.
- `ai-automation-auditor` — o diff não toca o caminho do agente nem tools.
- `data-resilience-auditor` — sem upload, exclusão, retenção ou migration.
- `functional-auditor` — o elo "capability declarada vs implementada" já é gateado por `whatsapp-capability-guard.test.ts` com controle positivo.

---

## Findings

### MOD-datafy-whatsapp-001 — `.ai-router/` supostamente commitado — **REJEITADO, evidência contrária**

**P2 alegado pelo `secret-hunter`. Desqualificado por verificação direta.**

O auditor não tinha shell e leu apenas o `.gitignore`, concluindo que `.ai-router/` estava sendo versionado. Verificado:

```
$ git ls-files .ai-router/
(vazio)

$ git check-ignore -v .ai-router/TASKS/DATAFY-B5.json
.git/info/exclude:7:.ai-router/
```

O diretório é excluído por `.git/info/exclude`, não pelo `.gitignore` — que é exatamente onde o ai-router-br grava a regra na inicialização, por ser configuração local de ferramenta e não do projeto. Nenhum arquivo de `.ai-router/` está rastreado. Sem ação.

O raciocínio subjacente do auditor continua válido e vale registrar: `RESULTS/*.json` guarda o diff bruto devolvido por worker externo num campo de string, e um JSON assim passa por baixo de scanner configurado só para extensões de código. Se algum dia a regra local se perder, o canal existe. Está coberto hoje.

### MOD-datafy-whatsapp-002 — A superfície de 500 no lote é mais larga que o caso do `metadata` — **ACEITO, spec corrigida**

**P2. Documentação, não código.**

A pendência da Fase F, registrada na review da Task 5, descrevia a cadeia como específica de evento WABA sem `metadata.phone_number_id`. O auditor de confiabilidade mostrou em `webhook-whatsapp/index.ts:1745` que **qualquer** `result.ok === false` de qualquer parte do lote propaga como 500 — 401 de assinatura, 404 de canal, 400 de JSON inválido, 413 de payload grande. O caso do `metadata` é o mais provável, não o único.

Isso muda a decisão pendente: a saída "200 quando falta `metadata`" é insuficiente. A decisão tem que responder, parte a parte, quais falhas de filho são retentáveis pela Meta e quais não são.

**Correção aplicada:** subseção nova na spec (`### A superfície é mais larga que o caso do metadata`). Nenhuma mudança de código — corrigir o comportamento alcançaria o `official` junto e violaria a constraint das Fases A–D.

### MOD-datafy-whatsapp-003 — Dois canais ativos no mesmo `phone_number_id` — **PERGUNTA EM ABERTO, não é achado**

**P3.** Levantado pelo auditor de confiabilidade como hipótese explicitamente não fechada: se uma organização mantivesse simultaneamente um canal `official` e um `datafy` para o mesmo `phone_number_id` (janela de migração), a mesma mensagem física poderia ser processada duas vezes, porque a chave `(provider, message_id)` não colide entre providers **por design**.

Provavelmente inatingível: a Meta entrega webhook ao único app inscrito na WABA. E o repo tem o invariante de que `whatsapp_channels.is_active` admite um único `true` por unidade. Mas o cenário cruza duas unidades/providers, que é um eixo diferente.

**Não corrigido.** Vira pergunta para a Task 6, que é quem cria canal `datafy`, e para a spec de migração de unidade existente — nenhuma das duas existe nesta branch. Registrado para o review whole-branch.

### MOD-datafy-whatsapp-004 — Lacunas de cobertura declaradas pelos auditores

**P3, informativo.** Os dois auditores foram explícitos sobre o que não verificaram, o que é mais útil que uma conclusão apressada:

- O destino final de `providerMessageId: undefined` em `recordNotification` (`send-whatsapp`/`send-confirmation` não foram lidos). O comportamento do adapter Datafy é **idêntico** ao dos três irmãos já em produção, então qualquer lacuna aqui é pré-existente e compartilhada, não introduzida por esta branch.
- Ordem de escrita no caminho Datafy (registro fantasma, paralelo ao invariante do giftback) — **não verificado**, não "limpo".
- `applyDeliveryStatus` e a escrita de `manual_echo_verified_at` usam `.update().eq()` sem `.select()`, violação nominal do invariante do repo sobre UPDATE que casa zero linhas. Ambos são código **não tocado** por esta branch — dívida pré-existente compartilhada com os quatro providers.

---

## Controles aprovados (o que a auditoria confirmou funcionando)

**Isolamento entre tenants — a pergunta central, respondida.** O canal é resolvido por `url.searchParams.get("channel")` mais `SELECT` no banco (`index.ts:1572-1593`), **nunca** por algo do corpo do payload. Isso é o que faz a guarda de identidade valer alguma coisa: ela compara o payload contra um canal que o remetente não escolheu. E sem o `whsec_` daquele canal específico, o request morre em 401 antes de chegar à guarda.

**`trustedMetaPayload=true` é inalcançável de fora.** Duas chamadas do handler no repo inteiro: a recursão interna do split (`:1736`) e o `serve()` público (`:3715`, sempre `false`). E mesmo com `true`, `metaPayloadMatchesChannel` roda **incondicionalmente** — o flag pula só o HMAC, não a identidade.

**Lote misto entre unidades é rejeitado atomicamente.** `ids.every(id => id === expected)` roda sobre todos os `changes[]` do payload inteiro **antes** do split. Nenhuma parte é processada contra o canal errado.

**Idempotência não colide apesar do reuso de parser.** `provider` vem sempre de `channel.provider` (`:1594`), nunca de literal nem da função que fez o parse. Os seis pontos de escrita/claim em `processed_messages` usam essa variável.

**Paridade de timeout e retry.** `sendDatafy` usa `fetchProviderWithTimeout(url, init, 3)` — a mesma função dos três irmãos: 12s por tentativa, 3 retries com backoff exponencial e jitter. E o `retryOn` padrão só retenta em `>= 500 || 429`, então `AUTH_ERROR` (401/402/403) não entra em loop de retry.

**Secrets.** Token sempre em header `Authorization`, nunca na URL — o que torna inofensiva a URL embutida no `TypeError` do Deno, diferente da Z-API. Segredo sempre lido do banco, nunca literal. Log só com metadado. Varredura do histórico do range (`git log -p e493a89~1..83eaa0c`) por `sk-`, `sk-ant-`, `xai-`, `re_`, `AIza`, `eyJ`, `whsec_` com valor, hex de 64 e URL com credencial: **nenhum resultado**.

---

## Impacto fora do módulo

Nenhum. A auditoria não propôs mudança de código e nenhuma foi feita. A única alteração é a subseção na spec.

## Riscos residuais

1. **Nada foi exercitado contra a Datafy real** — não há credencial nesta sessão. Vale integralmente o aviso de `VALIDAÇÃO REAL COM PROVIDER PENDENTE` da spec, com o precedente do repo em que o envelope real divergiu da documentação e uma suíte verde por 14 dias exercitava uma forma inventada.
2. **O caminho de provisionamento não existe ainda** (Task 6). Hoje nenhum canal `datafy` pode existir no banco, então todo o caminho novo está inalcançável em produção — o risco desta branch está dormente até a Task 6.
3. **Gitleaks/trufflehog sobre o histórico completo do repo** (não só o range desta branch) não foi executado. A varredura do range está limpa; a do histórico inteiro é item de higiene do repo, não desta branch.

## Pendências

- `rls-auditor` sobre a migration da Task 4, quando existir.
- Reauditar isolamento e provisionamento quando a Task 6 criar o caminho de canal `datafy`.
- Decidir a pergunta em aberto do MOD-003 antes de qualquer migração de unidade existente para Datafy.
