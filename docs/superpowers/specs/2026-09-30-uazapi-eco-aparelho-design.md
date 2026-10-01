# UazAPI: eco do aparelho recusado com 401 por âncora de identidade inexistente

## Contexto

Quando a equipe da loja responde um cliente pelo celular ou pelo WhatsApp Web, a UazAPI entrega ao `webhook-whatsapp` um eco da mensagem (`fromMe: true`, `wasSentByApi: false`). O contrato do projeto manda esse eco entrar no thread como `role: "human"` e colocar a conversa em `human_active`, silenciando a IA.

No canal UazAPI do Ren Sushi (`a633d938…`, único canal ativo desde 05/09/2026) isso nunca aconteceu. `manualEchoMatchesConfiguredChannel` (webhook-whatsapp, linhas 199–204) só aceita o eco da UazAPI se o payload trouxer `instanceId`, `instance_id` ou `instance.id` igual a `external_instance_id`. A UazAPI não envia nenhum dos três. O eco cai em `hasManualEcho && !manualEchoMatchesChannel` e o webhook devolve 401.

Consequências, as duas em produção desde 05/09:

- A conversa no painel só mostra o que o cliente escreveu e o que a IA respondeu. O que a equipe mandou pelo aparelho some.
- A resposta manual não silencia a IA. Quando o cliente responde ao atendente, a IA responde por cima.

## Medição

- **`webhook_executions`, canal ativo, 30 dias:** 179 `webhook_unauthorized` e **zero** `own_message_echo_*`. Nenhum eco foi aceito desde a criação do canal.
- **Log da Edge Function (`evt`), por dia medido:** 30/09: 25 de 25 recusas são `manual_echo_channel_identity_mismatch`. 24/09: 6 de 6. 19/09: 17 de 18 (1 `webhook_unauthorized` de segredo inválido, origem não investigada).
- **Envelope real da UazAPI para mensagens** (instrumentação de forma em `ignored_non_text`): chaves de topo `BaseUrl, EventType, chat, chatSource, instanceName, message, owner, token`. Não há `instanceId`, `instance_id` nem `instance`.
- **O `token` do envelope é o token da instância.** As 348 mensagens de cliente processadas em 7 dias carregam a chave e passaram pela conferência em tempo constante contra `credentials.instance_token` resolvido do Vault (linhas 2617–2627). Nenhum `webhook_provider_token_mismatch` nas janelas medidas.
- **O parser do eco já funciona.** As recusas só acontecem depois de `parseUazApiOwnMessageEcho` classificar o payload como `manual_device`, com `messageid`, `text` e `messageTimestamp` válidos. O que nunca rodou com envelope real é o que vem depois da guarda: `handleOwnMessageEcho`.

O `webhook_unauthorized` grava `meta: {}` nas seis guardas que o produzem. Só o log da função, que expira, distinguiu qual delas recusou.

## Contrato

- **O eco do aparelho da UazAPI só prova identidade se carregar `token` igual ao token da instância do canal**, comparado em tempo constante. Ausente, vazio, não-string ou divergente → não casa → 401, como hoje.
- **O token é a âncora porque é segredo e é único por instância.** O `instanceId` procurado hoje não é segredo e a UazAPI não o envia. O `owner` (número da loja) não é segredo e pode estar desatualizado no cadastro.
- **Z-API, WAHA e Meta-shaped: comportamento idêntico ao atual.** A função muda de arquivo, não de regra.
- **O núcleo compara o token por conta própria; não depende da checagem das linhas 2617–2627.** Se a guarda dependesse de uma checagem 400 linhas antes, mover aquela checagem a tornaria decorativa sem nenhum teste reprovar.

## Desenho

### Núcleo puro: `supabase/functions/_shared/whatsapp-echo-identity-core.ts`

Recebe as três funções de identidade de canal no payload, que hoje vivem no `index.ts` onde o vitest não alcança:

- `metaPayloadMatchesChannel(payload, credentials)`: sem mudança.
- `declaredProviderIdentityMatchesChannel(provider, payload, credentials)`: sem mudança.
- `manualEchoMatchesConfiguredChannel(provider, payload, credentials, externalInstanceId)`: ramo UazAPI reescrito conforme o contrato. Os demais ficam sem mudança.

As três mudam juntas porque formam uma única pergunta ("este payload é deste canal?"), e o par `credentials.session_name?.trim() || "default"` precisa continuar num mesmo arquivo.

O núcleo importa só tipos e `isMetaShapedProvider` de `whatsapp-provider-core.ts`. A comparação em tempo constante é local ao núcleo. A função equivalente em `whatsapp-providers.ts` é privada, e exportá-la mudaria um arquivo importado por nove Edge Functions, todas a redeployar.

`credentials.instance_token` chega ao núcleo já resolvido do Vault: o `index.ts` chama `resolveChannelCredentials` para UazAPI antes da guarda, e esse fluxo não muda. Na re-entrada a partir da fila (Fase C), o corpo é o original, então o `token` está presente, e a resolução do Vault roda do mesmo jeito.

### `webhook-whatsapp/index.ts`

- Remove as três funções locais (e `metaPhoneNumberIds`) e importa do núcleo. Os call sites ficam iguais.
- **Cada `finish("webhook_unauthorized")` passa a gravar `meta.reason`**, com vocabulário fechado:

| Guarda | `reason` |
|---|---|
| assinatura/segredo inválido (linha 2579) | `signature_invalid` |
| identidade declarada Z-API/WAHA (2594) | `declared_identity_mismatch` |
| token UazAPI divergente (2624) | `provider_token_mismatch` |
| instância UazAPI divergente (2645) | `instance_mismatch` |
| `phone_number_id` Meta/Datafy (2656) | `meta_identity_mismatch` |
| eco do aparelho (2866) | `manual_echo_identity_mismatch` |

O `outcome` não muda (`whatsapp-health` e a classe 401 terminal da fila contam por ele). `meta` só carrega o nome da guarda, nunca valor.

## Fora de escopo

- **As 179 respostas já recusadas não voltam.** Nunca foram gravadas. Recuperar exigiria consultar a UazAPI por conversa, e a mesma questão de backfill pertence ao item 2 (mensagens do período desconectado).
- **Eco identificado só por LID.** `handleOwnMessageEcho` procura por `wa_chat_lid`, que hoje só é aprendido para Z-API. Eco UazAPI com `chatid` em `@lid` termina em `own_message_echo_unresolved`/`lid_unknown`, sem erro. Medir quantos depois do deploy, antes de decidir.
- **Eco para número que não é cliente** termina em `own_message_echo_unresolved`/`customer_unknown`, como já é o contrato.
- Eco de mídia pelo aparelho: `parseUazApiOwnMessageEcho` exige texto, e `peekUazApiMedia` descarta `fromMe`. O payload segue em `ignored_non_text`, como hoje.

## Mudança de comportamento visível para a loja

Com o conserto, **quando a equipe responder um cliente pelo celular, a IA para de responder aquele cliente** até a conversa ser devolvida à IA no painel ou até 12 h sem resposta humana (auto-resolve). É o contrato já documentado e o que já acontece com resposta pelo painel; a loja nunca viu isso acontecer pelo aparelho.

## Verificação

**Testes** em `src/lib/whatsapp-echo-identity-core.test.ts`, com fixture no envelope medido (chaves de topo reais, `message` com `fromMe`, `wasSentByApi`, `messageid`, `text`, `messageTimestamp`, `chatid`; valores fictícios):

- Envelope real com `token` igual ao da instância → casa.
- `token` ausente, vazio, não-string, divergente, ou `instance_token` do canal vazio → não casa.
- `token` com o mesmo prefixo e tamanho diferente → não casa (a comparação não aceita prefixo).
- Z-API, WAHA e Meta: casos atuais de casa/não casa preservados, incluindo `session_name` ausente caindo em `"default"`.
- `declaredProviderIdentityMatchesChannel` e `metaPayloadMatchesChannel`: não-regressão dos casos atuais.

**Controle positivo:** restaurar o ramo UazAPI antigo (âncora `instanceId`) e ver o caso do envelope real reprovar. Sem isso, o teste volta a não testar nada.

**Guarda estática:** `whatsapp-conversation-parity-guard.test.ts` passa a ler o núcleo onde hoje lê o `index.ts` para essas funções, e reprova se o `index.ts` voltar a definir `manualEchoMatchesConfiguredChannel` localmente. Também reprova se algum `finish("webhook_unauthorized")` ficar sem `reason`.

**Gates:** `typecheck`, `test`, `lint`, `build`; `saas-shield-br:tenant-isolation-auditor` e `integration-reliability-auditor` (a mudança toca guarda de identidade de canal num webhook multi-tenant).

**Em produção, após deploy:**

1. Sondas sem segredo e sem tráfego real: POST com corpo `{}` em `?channel=<canal ativo>` → 401 com `reason: signature_invalid` (prova que o `SELECT` do canal rodou); o mesmo POST com uuid inexistente → 404 (controle que distingue 401 de "tudo 401").
2. Alguém da loja manda uma mensagem pelo celular para um cliente de teste já cadastrado. Esperado: `own_message_echo_recorded` em `webhook_executions`, mensagem no thread como humano, conversa em `human_active`.
3. Em 24 h: zero `webhook_unauthorized` com `reason = manual_echo_identity_mismatch`, e contagem de `own_message_echo_recorded` × `own_message_echo_unresolved` por `reason` (insumo da decisão sobre LID).

## Deploy

Sem migration. Um arquivo novo em `_shared/`, consumido só por `webhook-whatsapp`: **redeploy apenas do `webhook-whatsapp`**. `whatsapp-provider-core.ts` e `whatsapp-providers.ts` não mudam.

Rollback: worktree no SHA em produção e `supabase functions deploy webhook-whatsapp --project-ref gbabxcrntkwgblgqsiit` de lá.

`CLAUDE.md` e `AGENTS.md` no mesmo commit: a invariante "o eco da UazAPI prova identidade pelo `token`; a UazAPI não envia `instanceId`" e a linha do núcleo novo no checklist de redeploy.
