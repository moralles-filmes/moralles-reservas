# FASE D — Captura do `referral` de anúncio Click-to-WhatsApp (CTWA)

**Data:** 2026-09-27 · **Branch:** `feat/datafy-fase-d-ctwa` · **Depende de:** Fase C (mergeada em `main`, **não aplicada**; ver §10)

Design da Fase D do plano de integração Datafy. Resolve o **R2** da [auditoria de Fase 0](2026-09-22-datafy-whatsapp-oficial-meta-ads-auditoria.md) dentro dos limites da **decisão de negócio nº 4**: *"Sem anúncio CTWA hoje; preservar o dado desde já. [...] A Conversions API (Fase I) fica para quando houver anúncio real."* Fecha a entrega A–D (decisão nº 2).

---

## 1. O problema, medido

Quando um cliente clica num anúncio Click-to-WhatsApp e manda a primeira mensagem, a Meta entrega `messages[].referral` com o `ctwa_clid` (identificador do clique). Nada no repositório lê esse objeto, e ele não volta depois.

### 1.1 O que a leitura do código confirmou, e o que corrigiu

| Afirmação do handoff | Veredito | O que o código mostra |
|---|---|---|
| `parseOfficialInbound` descarta todo tipo não-texto | **Confirmada no parser, falsa no handler** | O `return null` está em [whatsapp-provider-core.ts:554](../../../supabase/functions/_shared/whatsapp-provider-core.ts). Mas o handler chama em seguida `peekInboundMedia` ([webhook-whatsapp/index.ts:2818](../../../supabase/functions/webhook-whatsapp/index.ts)), e `peekOfficialMedia` aceita **todo** `type !== "text"` (o desconhecido vira `"other"`): reivindica o dedupe, cria cliente e conversa e responde `MEDIA_REPLY_TEXT`. O clique não-texto **deixa rastro**. O que some é só o `referral`, porque `InboundMediaPeek` não carrega `raw` nem nada do anúncio. |
| `raw` é o corpo inteiro do POST | **Só com uma mensagem por POST** | É o corpo **da invocação**. Lote com mais de uma parte re-entra por parte com `JSON.stringify(part)` ([index.ts:2683](../../../supabase/functions/webhook-whatsapp/index.ts)) — campos compartilhados, `contacts` filtrados pelo remetente e **só aquela mensagem**. Nos três caminhos (POST simples, lote, fila) `value.messages[0]` é a mensagem certa, e o split copia o objeto `message` inteiro, com o `referral` junto. Ninguém lê `InboundMessage.raw`. |
| `official` e `datafy` compartilham o parser | **Confirmada** | [whatsapp-providers.ts:554](../../../supabase/functions/_shared/whatsapp-providers.ts) e [:593](../../../supabase/functions/_shared/whatsapp-providers.ts). Compartilham também `peekOfficialMedia` (556 e 595). |
| A purga da Fase C apaga o corpo cru em 7 dias | **Confirmada, com nuance** | [migration 113](../../../supabase/migrations/20260924120200_113_inbound_claim_rpc.sql): `done` com `received_at < now() - 7 days`, `dead` com 30. O prazo conta do **recebimento**, não do fim do processamento. |
| `adReferral` declarada `true` para `official` e `datafy` | **Confirmada** | [whatsapp-provider-core.ts:344 e :379](../../../supabase/functions/_shared/whatsapp-provider-core.ts). A capability afirma uma coisa que o código não faz. |

### 1.2 O que a produção mostrou (consultas `read only`, 2026-09-27)

- **Canais:** existem dois, um `uazapi` ativo e um `zapi` inativo. **Não existe nenhum canal `official` nem `datafy`.** Mexer no caminho Meta não alcança loja viva nenhuma hoje.
- **Histórico:** `processed_messages` só tem `zapi` (11.282) e `uazapi` (1.913). **Nunca passou um inbound Meta-shaped por este sistema**, logo nunca chegou um `referral`.
- **Migrations:** a última aplicada é a **110**. As **111–114 (Fase C) não estão aplicadas**: `whatsapp_inbound_events` não existe em produção.
- **Papéis:** `postgres` e `service_role` têm `rolbypassrls = true`; `anon` e `authenticated`, não. Isso decide o §4.4.

### 1.3 O que decide se o dado sobrevive

Não é "o que cita `referral`", é o que acontece com o inbound Meta antes de alguém poder lê-lo:

1. **Guardas antes do ACK** (assinatura, identidade Meta, `phone_number_id`): o payload recusado nunca foi dado do tenant. Correto.
2. **Canal inativo** descarta tudo com `inactive_channel` ([index.ts:2778](../../../supabase/functions/webhook-whatsapp/index.ts)). Correto: touchpoint é dado de CRM, e canal inativo não entra em CRM.
3. **Parser de texto** não expõe o campo. **Peek de mídia** não o carrega.
4. **Saídas antes do cliente** no caminho de texto: rate limit ([index.ts:3047](../../../supabase/functions/webhook-whatsapp/index.ts)), organização bloqueada e WhatsApp suspenso (3097, 3119). Só a partir de 3144 o cliente é resolvido. Um touchpoint gravado "depois do cliente" morreria nesses três desvios.

---

## 2. Decisões

| # | Decisão | Por quê, em uma frase |
|---|---|---|
| D1 | **O touchpoint pertence à UNIDADE que recebeu o clique (`unit_id` + `channel_id`) e aponta para o CLIENTE da organização (`customer_id`). Sem coluna `organization_id`.** | O `ctwa_clid` só tem sentido para o WABA que o recebeu, e o WABA é do canal, que é da unidade. |
| D2 | **Persistir três campos tipados (`ctwa_clid`, `source_type`, `source_id`), o tipo da mensagem e a subárvore `referral` crua, limitada a 16 KiB.** | O envelope não foi medido; guardar só o que a documentação promete perde o valor se o nome do campo divergir. |
| D3 | **Sem purga por tempo nesta fase. A anonimização LGPD do cliente apaga os touchpoints dele, por trigger.** | O único consumidor (Fase I) não existe e a janela de atribuição da Meta não foi medida; o prazo é pré-requisito dela, não chute desta. |
| D4 | **Clique não-texto captura pelo caminho de mídia que já existe. A resposta ao cliente não muda (`MEDIA_REPLY_TEXT`).** | O caminho já existe e já responde; faltava só ler o campo. |
| D5 | **Nenhuma UI, nenhum painel, nenhuma contagem no diagnóstico.** | Não há anúncio rodando, então não há o que mostrar; a verificação é por log de forma e SQL de runbook. |
| D6 | **Nenhum backfill.** | Nunca chegou inbound Meta (§1.2), e o corpo cru nunca foi guardado. |
| D7 | **`InboundMessage` não muda. O adapter ganha o método opcional `parseAdReferral`, e a capability passa a EXIGIR o método.** | Estender o contrato dos cinco providers para um campo que três nunca preenchem espalha a pergunta; o método opcional a confina a quem declara a capability. |
| D8 | **Falha ao gravar o touchpoint é reentregável: `throw` antes de qualquer efeito externo. `23505` é dedupe silencioso.** | É o contrato que o handler já tem para dado de inbound que não pode se perder. |

### 2.1 D1 em detalhe — unidade ou organização

As duas escolhas extremas perdem alguma coisa:

- **Só organização:** o relatório da unidade A passa a mostrar atribuição gerada pela B, e — o argumento decisivo — a Fase I enviaria à Meta um clique recebido pelo WABA de uma unidade como conversão de outra. A Conversions API para mensagens liga o `ctwa_clid` ao WABA/dataset que recebeu o clique. Atribuir entre unidades não é escolha de relatório, é erro do lado da Meta.
- **Só unidade, sem cliente:** o mesmo cliente que clicou em anúncio da A e depois falou com a B vira dois históricos soltos.

**Guardar `unit_id` + `channel_id` + `customer_id` dá as duas visões sem uma segunda coluna de tenant.** A visão da unidade é `where unit_id = U`. A visão da organização é `where customer_id = K`, porque `customers` já é da organização. `organization_id` redundante seria mais uma FK independente sem nada que amarre a coerência — exatamente a fragilidade que o `CLAUDE.md` registra entre `channel_id` e `unit_id` de `whatsapp_inbound_events`. Aqui a coerência é **amarrada no banco** (§4.3).

**O que isso fecha e o que abre para a Fase I:**

- **Fecha:** o escopo de isolamento. Consulta de atribuição é `unit_id = U and customer_id = K`, com `unit_id` vindo da reserva.
- **Abre (decisão da Fase I, não desta):**
  1. **Atribuição entre unidades** — cliente clicou no anúncio da A e reservou na B. Por padrão **não** se atribui. Se a organização tiver um WABA com vários números, `channel_id` permite agrupar por WABA quando a Fase I souber o `waba_id` de cada canal (a Datafy o devolve no `/me`; o `official` não o guarda hoje).
  2. **Prazo de retenção do `ctwa_clid`** (D3).

### 2.2 D2 em detalhe — o que se persiste, como pergunta de privacidade

A documentação da Meta descreve `referral` com `source_url`, `source_type` (`ad`/`post`), `source_id`, `headline`, `body`, `media_type`, `image_url`/`video_url`/`thumbnail_url` e `ctwa_clid`. **Nada disso foi visto chegar** (§1.2).

| Dado | Natureza | Destino |
|---|---|---|
| `ctwa_clid` | **Identificador pessoal pseudonimizado**: a Meta o resolve até a pessoa que clicou | Coluna tipada — é a chave da Fase I |
| `source_type`, `source_id` | Metadado do anúncio, não da pessoa | Colunas tipadas — `source_id` é o id do anúncio, que a Fase I e qualquer relatório agrupam |
| `headline`, `body`, `source_url`, `media_type`, URLs de mídia | Conteúdo do anúncio (texto da própria loja e URLs de CDN da Meta) | Só na subárvore crua |
| Telefone, nome, texto da mensagem | Pessoal | **Nunca nesta tabela.** A pessoa entra só por `customer_id`, e o texto já está na conversa |

**Por que guardar a subárvore crua.** É a proteção direta contra a lição dos 14 dias de suíte verde. Se a Datafy entregar o clique com o identificador sob outro nome, as colunas tipadas ficam nulas, mas o **valor** está na linha e pode ser re-extraído quando o envelope for medido. Só com colunas tipadas, a linha diria "chegou um referral" e o dado estaria perdido. O custo é guardar conteúdo de anúncio e URLs de CDN, que não identificam a pessoa. A subárvore **não** é o corpo da mensagem: nela não entram telefone, nome nem texto.

**Limite.** O núcleo mede a subárvore em **bytes UTF-8** e descarta a parte crua (mantendo as colunas tipadas) acima de **16 KiB**. O CHECK do banco é de **64 KiB**, uma rede de segurança, e não a regra: o `jsonb::text` do Postgres insere espaço depois de `:` e `,` e fica mais longo que o `JSON.stringify`. Com os dois no mesmo número, o banco recusaria o que o núcleo aceitou, e pela D8 essa recusa viraria reentrega eterna. Campo tipado acima do limite de tamanho vira `null` (não é truncado: truncar um identificador o corrompe).

### 2.3 D3 em detalhe — retenção

- **Anonimização:** o `anonymize_customer` faz *soft delete* (`UPDATE customers set deleted_at = now()`), então a FK com `on delete cascade` **não dispara**. Um trigger `AFTER UPDATE OF deleted_at` em `customers` apaga os touchpoints do cliente. Ser trigger, e não uma linha a mais dentro da RPC, cobre qualquer caminho que venha a marcar `deleted_at` e não reescreve o corpo de uma função `SECURITY DEFINER` que já tem três versões de histórico.
- **Exclusão física** do cliente ou da unidade: `on delete cascade`.
- **Tempo:** nenhuma purga. **Esta é uma decisão consciente, e ela tem custo:** se um anúncio começar a rodar antes da Fase I, as linhas acumulam sem prazo. É a troca que a decisão nº 4 fez ao mandar "preservar o dado desde já". A Fase I não entra sem definir o prazo a partir da janela de atribuição da Meta, medida e não suposta.

### 2.4 D7 em detalhe — por que não estender `InboundMessage`

`InboundMessage` é o contrato dos cinco providers. Um campo `referral?` nele seria preenchido por um parser e ignorado por três; e o caminho de mídia não usa `InboundMessage`, então o campo **não resolveria** o clique não-texto (D4) — seria preciso estender `InboundMediaPeek` também. Um método opcional no adapter, chamado sobre o `payload` que os dois caminhos já têm na mão, resolve os dois com uma peça só e deixa `parseOfficialInbound` **intocado**.

**`official` e `datafy` ganham o método juntos, por decisão explícita.** Os dois declaram `adReferral: true` desde a Fase A e compartilham o envelope. Dar o método só à Datafy obrigaria a desdeclarar a capability do `official` — e desdeclarar para não implementar é a mesma mentira pelo outro lado. O efeito no `official` é uma escrita a mais **quando há referral**, num provider sem nenhum canal em produção (§1.2).

---

## 3. Arquitetura

### 3.1 Onde a captura acontece

```
POST /webhook-whatsapp?channel=<id>
  ├─ canal pela querystring + SELECT; assinatura; identidade Meta      (inalterado)
  ├─ [Fase C: ACK e fila, se o gate estiver ON]                          (inalterado)
  ├─ split do lote Meta → uma mensagem por parte                         (inalterado)
  ├─ status / conexão / eco / canal inativo                              (inalterado)
  ├─ parseInbound → texto?
  │    ├─ sim: telefone plausível → claim processed_messages
  │    │        → ★ captureAdTouchpoint                                  ← NOVO
  │    │        → rate limit → billing → suspensão → cliente → agente
  │    └─ não: peekInboundMedia → telefone plausível → claim
  │             → ★ captureAdTouchpoint                                  ← NOVO
  │             → cliente → conversa → gate → MEDIA_REPLY_TEXT
```

**Depois do claim**, porque a reentrega que o dedupe barra não chega aqui (o `UNIQUE` é a segunda barreira, não a primeira). **Antes de rate limit, billing e suspensão**, porque esses três desviam antes de o cliente ser resolvido (§1.3), e o fato "esta pessoa chegou por este anúncio" não depende de a loja estar adimplente — é o mesmo raciocínio do `persistInboundOnly`, que guarda a mensagem recebida mesmo com a organização bloqueada. **Antes de qualquer efeito externo**, porque é isso que torna a falha reentregável (§8).

### 3.2 `captureAdTouchpoint` (adapter de I/O em `index.ts`)

1. `parseAdReferral(provider, payload)` pela fachada do registry. **`null` para todo provider sem a capability** — Z-API, WAHA e UazAPI não fazem nenhuma consulta nova. Fim.
2. Log de forma (§7).
3. Lê `units.organization_id` pelo `unitId` do canal.
4. `resolveOrCreateCustomer` (idempotente; no caminho de texto o cliente ainda não foi resolvido neste ponto, no de mídia será resolvido de novo logo adiante — uma consulta a mais, só quando há referral).
5. `buildAdTouchpointRow` (núcleo) monta a linha ou recusa com motivo.
6. `INSERT`. `classifyTouchpointInsert` (núcleo) decide: gravado, duplicado (`23505`, silencioso) ou falha (`throw ad_touchpoint_persist_failed`).

`unit_id` e `channel_id` saem do `channel` lido no `SELECT` da querystring — nunca do payload, e nunca do `referral`, que é dado do cliente e não identidade de tenant.

---

## 4. `whatsapp_ad_touchpoints` (migration 115)

Arquivo `20260927120000_115_whatsapp_ad_touchpoints.sql` (timestamp maior que `20260924120300`, da 114).

### 4.1 Tabela

```sql
create table if not exists whatsapp_ad_touchpoints (
  id                   uuid        primary key default gen_random_uuid(),
  unit_id              uuid        not null references units(id) on delete cascade,
  channel_id           uuid                 references whatsapp_channels(id) on delete set null,
  customer_id          uuid        not null references customers(id) on delete cascade,
  provider             text        not null check (provider in ('official','datafy')),
  provider_message_id  text        not null check (length(btrim(provider_message_id)) between 1 and 512),
  message_type         text        check (message_type is null or length(message_type) between 1 and 32),
  message_at           timestamptz not null,
  received_at          timestamptz not null default now(),
  ctwa_clid            text        check (ctwa_clid   is null or length(ctwa_clid)   between 1 and 512),
  source_type          text        check (source_type is null or length(source_type) between 1 and 64),
  source_id            text        check (source_id   is null or length(source_id)   between 1 and 256),
  referral             jsonb       check (referral is null or octet_length(referral::text) <= 65536)
);
```

- **`provider` só admite quem declara `adReferral`.** É o espelho no banco da capability: Z-API e UazAPI não conseguem gravar aqui nem por engano. A lista é **gêmea declarada** de `PROVIDER_CAPABILITIES[*].adReferral === true`, e um teste estático reprova divergência (§11).
- **`source_type` não tem CHECK de enum.** O envelope não foi medido; um `'ad'|'post'` rígido recusaria um valor novo, e pela D8 a recusa viraria reentrega eterna com o cliente sem resposta.
- **`channel_id` é `on delete set null`, não `cascade`.** Apagar um canal não apaga o histórico de atribuição.

### 4.2 Índices

- `unique (provider, provider_message_id)` — um touchpoint por mensagem, mesma chave de `processed_messages`. Reentrega é `23505`, tratado como dedupe.
- `(unit_id, customer_id, message_at desc)` — a consulta da Fase I.
- `(customer_id)` — o `delete` da anonimização.

### 4.3 Guarda da linha (`whatsapp_ad_touchpoints_guard`, `BEFORE INSERT OR UPDATE`)

- **INSERT — coerência de tenant amarrada no banco:** `channel_id` (quando não nulo) pertence a `unit_id`, e o `customer_id` é da organização dona de `unit_id`. Recusa com mensagem que nomeia qual perna falhou.
- **INSERT — cliente vivo:** recusa `customer_id` com `deleted_at` preenchido. Sem isso, uma anonimização que caia entre o `resolveOrCreateCustomer` e o `INSERT` deixaria um `ctwa_clid` preso a um cliente já anonimizado, depois de o trigger da §4.4 ter rodado.
- **UPDATE — imutabilidade:** recusa **qualquer** `UPDATE`, com uma única exceção: a coerção que o `on delete set null` faz em `channel_id` (`não nulo → nulo`, com todas as outras colunas iguais). **Esta exceção não é opcional**: é o conflito FK × CHECK da migration 089, em que exigir o campo não nulo tornou o `on delete set null` inexecutável e abortou o `DELETE` inteiro. O pré-voo mede as duas metades.
- `SECURITY INVOKER`, `search_path = ''`. Só o `service_role` escreve (ele ignora RLS); qualquer outro papel já é barrado pela RLS.

### 4.4 Anonimização (`purge_ad_touchpoints_on_customer_anonymize`, `AFTER UPDATE OF deleted_at ON customers`)

`WHEN (old.deleted_at is null and new.deleted_at is not null)` → `delete from whatsapp_ad_touchpoints where customer_id = new.id`.

**Tem de ser `SECURITY DEFINER`.** A tabela é `FORCE RLS` sem policies: um `DELETE` rodado como `authenticated` (por exemplo, um membro fazendo soft delete pelo PostgREST, se a policy de `customers` permitir) apagaria **zero linhas em silêncio**, e os `ctwa_clid` do cliente anonimizado sobreviveriam. Como dono (`postgres`, com `rolbypassrls = true` medido em produção, §1.2) o `DELETE` alcança as linhas. O pré-voo roda a anonimização como `authenticated` e mede que as linhas somem, com controle positivo trocando para `SECURITY INVOKER`.

### 4.5 RLS e ACL

- `enable` + `force row level security`, **sem policies**. Mesma disciplina de `whatsapp_channels`, `processed_messages` e `whatsapp_inbound_events`: a separação entre clientes depende inteiramente do `.eq("unit_id", …)` no código, e aqui do guard da §4.3 também.
- As duas funções de trigger: `revoke all ... from public, anon, authenticated` com a assinatura completa (`CREATE FUNCTION` concede a PUBLIC; regra do `CLAUDE.md` para toda trigger function). Nenhuma é concedida a `anon`/`authenticated`, então nenhuma entra em `scripts/function-acl-allowlist.json`.
- **Sem RPC nova.** O `INSERT` é feito pelo supabase-js com `service_role`, e nenhuma função exposta ao PostgREST é criada.
- O lint INFO 0008 (`rls_enabled_no_policy`) passa de 17 para **19** tabelas depois da 111 e da 115 (o 17 foi medido em 2026-09-18, antes da `whatsapp_inbound_events` da Fase C); o `_doc` da allowlist cita o número e é atualizado. *Corrigido na execução: a redação original dizia 18 e esquecia a tabela da Fase C.*

---

## 5. Contrato de provider

Em `whatsapp-provider-core.ts`:

```ts
export interface AdReferral {
  /** Id da mensagem que carregou o referral — conferido contra o do inbound (§6). */
  providerMessageId: string;
  /** `messages[0].type` como veio, sem normalizar. */
  messageType: string | null;
  ctwaClid: string | null;
  sourceType: string | null;
  sourceId: string | null;
  /** Subárvore `referral` CRUA, exatamente como chegou. Nunca redigitada. */
  raw: unknown;
}
```

- `WhatsAppProviderAdapter.parseAdReferral?(payload): AdReferral | null` — **opcional**.
- `parseOfficialAdReferral(p)`: lê `entry[0].changes[0].value.messages[0]`, devolve `null` se não houver `referral` (ou se for `null`), **para qualquer `type`**. Campos tipados só se forem `string` (`typeof`, nunca `String(...)` — a mesma regra do `webhook_secret` da Datafy: `String({})` vira `"[object Object]"` e passaria como identificador).
- Registrado nos adapters `official` e `datafy`. Os outros três não o têm.
- `CAPABILITY_REQUIRED_METHOD` ganha `adReferral: "parseAdReferral"`, e o comentário da linha 49 ("capabilities de payload não exigem chamada própria") é corrigido — era ele que deixava a mentira passar.
- **O guard de capability passa a valer nas duas direções:** capability `true` exige o método (hoje) **e** método presente exige capability `true` (novo). A segunda direção é o que impede um adapter legado de ganhar a leitura sem declarar a capability.
- Fachada `parseAdReferral(provider, payload)` em `whatsapp-providers.ts`, no molde de `peekInboundMedia`.

---

## 6. Núcleo puro: `_shared/whatsapp-ad-touchpoint-core.ts`

O vitest não importa `webhook-whatsapp/index.ts` (`serve()` no carregamento + `deno.land`), e regra que só se confere por leitura já deixou passar defeito duas vezes neste repo. Tudo que a Fase D **decide** mora aqui; o `index.ts` só faz I/O.

| Função | Decide |
|---|---|
| `buildAdTouchpointRow(input)` | Monta a linha: `trim`, vazio vira `null`, limite de tamanho por campo (acima vira `null`), subárvore crua medida em bytes UTF-8 contra `REFERRAL_RAW_MAX_BYTES = 16384`. **Recusa** (`ok: false`, com motivo) quando `referral.providerMessageId` difere do id do inbound — cinto contra atribuir o anúncio de uma mensagem a outra se o split um dia mudar. |
| `classifyTouchpointInsert(error)` | `"inserted"` \| `"duplicate"` (só `23505`) \| `"failed"` |
| `describeReferralProbe(payload)` | A linha de log de forma da §7 — nomes e `typeof`, via `shapeOf` |

Os limites de tamanho são **gêmeos declarados** dos CHECKs da 115 (SQL não importa TypeScript), com ponteiro nos dois lados, no idioma de `MAX_DELIVERY_ID_LEN` da Fase C.

`strict: false` no `tsconfig.app.json`: o resultado é consumido com `r.ok === false` ou early-return, nunca `if (!r.ok) { r.reason }`.

---

## 7. Instrumentação de forma

O `referral` é o único campo desta entrega que **não se pode ver chegar**. Dois eventos, os dois pela disciplina de [webhook-payload-shape-core.ts](../../../supabase/functions/_shared/webhook-payload-shape-core.ts) — nome de campo e `typeof`, **nunca valor**:

- **`ad_referral_captured`** — sempre que há referral: `{ provider, outcome, message_type, referral_shape: shapeOf(referral), raw_omitted }`. Responde: *os campos têm o nome que a documentação diz?*
- **`meta_inbound_referral_probe`** — para todo inbound de provider com `adReferral`: `{ provider, has_referral, message_shape: shapeOf(messages[0]) }`. Responde a pergunta que o primeiro evento não alcança: *o clique chegou com o referral em OUTRO lugar?* Sem ele, um envelope divergente produz silêncio, e silêncio é indistinguível de "ninguém clicou".

`shapeOf` tem `SHAPE_MAX_DEPTH = 1`: as chaves do primeiro nível da mensagem e do referral são nomes fixos do protocolo, nunca dado indexado. O teste reprova, com controle positivo, a troca da folha por `String(value)`. Hoje o volume é zero (não há canal Meta). O probe sai quando a pendência nº 8 (§13) for respondida — a remoção é tarefa de acompanhamento, não desta fase.

---

## 8. Falhas e idempotência

| Situação | Resultado |
|---|---|
| Provider sem `adReferral` | `null` na fachada, zero I/O. Comportamento de hoje, byte a byte. |
| Sem `referral` na mensagem | Só o probe. Nenhuma escrita. |
| Reentrega da mesma mensagem | Barrada pelo claim de `processed_messages`; se passar (takeover depois de falha), `23505` → dedupe silencioso. |
| `buildAdTouchpointRow` recusa (id divergente) | Log `ad_referral_rejected` com o motivo, **sem gravar e sem `throw`** — a mensagem segue. Um bug nosso de split não pode calar o cliente. |
| Falha de banco no `INSERT`, no cliente ou na unidade | `throw ad_touchpoint_persist_failed` → o `catch` externo libera o claim (nenhum efeito externo começou) → 500 → o provider reentrega. Com o gate da Fase C ON, a linha da fila é re-tentada pela escada dela. |
| Cliente com `deleted_at` (soft delete, inclusive direto pelo PostgREST sem trocar o telefone) | Guard recusa com `P0A15`; núcleo classifica `customer_not_alive`; loga e segue, sem reentrega. |

Em modo fila (Fase C com o gate ligado), "o provider reentrega" é a escada da fila: falha persistente termina em `dead`, sem alerta até `ASYNC_INGESTION_DEADLETTER_ALERT` existir — mais um motivo para o gate seguir desligado.

**O risco da D8, e por que ele é aceitável aqui:** uma falha **persistente** travaria todo inbound com referral desse cliente. É o que os limites no núcleo (§6), a ausência de CHECK de enum (§4.1) e o CHECK de tamanho folgado (§2.2) existem para impedir: nenhuma entrada de provider consegue produzir uma linha que o banco recuse. O que sobra é o banco fora do ar, que já derruba o claim antes daqui.

---

## 9. O que esta fase deliberadamente NÃO faz

- **Não envia nada à Conversions API** (Fase I).
- **Não altera o caminho de Z-API, WAHA ou UazAPI.** Eles não declaram a capability, a fachada devolve `null` antes de qualquer I/O, e o CHECK de `provider` recusaria a escrita mesmo se o código errasse.
- **Não altera `parseOfficialInbound`, `peekOfficialMedia` nem `InboundMessage`.**
- **Não muda a resposta ao cliente** em nenhum caminho.
- **Não lê `context`** (resposta citada, também citada no R2). É da Fase E.
- **Não leva o referral ao prompt do agente.** Se um dia levar, `referral` é JSONB e nunca é interpolado cru em template literal.
- **Não constrói relatório de atribuição** (D5).

---

## 10. Ordem de aplicação e redeploy

**Pré-requisito: a Fase C aplicada primeiro, pelo procedimento dela.** `supabase db push` aplica **tudo** que está pendente: empurrar a 115 hoje aplicaria 111–115 juntas, inclusive a 114, que agenda um `pg_cron` a cada minuto contra um `webhook-whatsapp` que ainda está na versão anterior à Fase C. A ordem da Fase C é: `db push` → `select cron.unschedule('whatsapp-inbound-sweep');` → deploy do `webhook-whatsapp` → exercitar `?sweep=1` à mão → reagendar → conferir em `net._http_response`. **Nenhum `db push` sai desta fase sem confirmação do dono.**

Depois dela:

1. `supabase db push` da 115 — **banco primeiro.** Com a EF nova e sem a tabela, todo inbound Meta com referral daria `throw` (D8) e reentrega eterna. Hoje não há canal Meta, então o dano seria zero; a ordem é regra do mesmo jeito.
2. Deploy das **nove** EFs que alcançam `whatsapp-provider-core.ts`/`whatsapp-providers.ts`. Medido nesta branch pelos imports: direto em `webhook-whatsapp`, `manage-channels`, `manage-organizations`, `whatsapp-health` e `process-whatsapp-channel-health`, e via `whatsapp-send.ts` em `send-whatsapp`, `send-confirmation`, `send-cancellation` e `send-manual-message`. Só o `webhook-whatsapp` **usa** o código novo; as outras oito entram porque `_shared/` não compartilha bundle em runtime e a regra do repo é não deixar cópias divergentes em memória.
3. `whatsapp-ad-touchpoint-core.ts` (novo) → `webhook-whatsapp`, único consumidor.

**Cuidado que o relatório de fechamento precisa medir, não supor:** redeployar as nove EFs a partir da `main` leva junto **tudo** o que foi mergeado e não deployado nelas — no `webhook-whatsapp`, a Fase C inteira. As diferenças entre o que está em produção e a `main` serão listadas por EF antes do deploy.

---

## 11. Testes e critérios de aceite

**Vitest** (`src/lib/`), com controle positivo onde o nome diz:

1. `parseOfficialAdReferral`: referral em mensagem de texto, em imagem e em tipo desconhecido; sem referral → `null`; `referral: null` → `null`; campos não-string viram `null` e o valor não aparece em lugar nenhum; `raw` é a subárvore original.
2. **Lote Meta com dois clientes, só um com referral:** após o split, só a parte dele devolve referral. Controle positivo: ler o referral do POST inteiro atribuiria o anúncio ao outro cliente.
3. Fachada: `zapi`, `waha` e `uazapi` devolvem `null` mesmo com um objeto `referral` no payload (controle positivo: registrar o método num adapter legado faz o teste de capability ficar vermelho).
4. Guard de capability nas duas direções, com controle positivo em cada uma.
5. **Gêmeo declarado:** a lista do CHECK de `provider` na 115 é igual ao conjunto de providers com `adReferral: true` (teste lê o arquivo da migration).
6. `buildAdTouchpointRow`: limites de campo, subárvore acima de 16 KiB em bytes (texto com multibyte, onde contar caracteres passaria), id divergente recusado.
7. `classifyTouchpointInsert`: `23505` é duplicado; qualquer outro código é falha.
8. Log de forma: nenhum valor na saída; controle positivo com a folha trocada por `String(value)`.
9. Acoplamento: o `index.ts` chama `captureAdTouchpoint` nos DOIS caminhos, cada um depois de um `claim_processed_whatsapp_message`, e não redigita decisão do núcleo.

**Pré-voo local** (`supabase/tests/local-preflight/`, banco próprio, com `RED` antes da migration pela guarda do topo):

| Caso | Mede |
|---|---|
| TP-1 | Insert válido |
| TP-2 | Reentrega → `23505` |
| TP-3 | `UPDATE` de qualquer coluna recusado |
| TP-4 | `DELETE` do canal conclui, a linha fica com `channel_id` nulo |
| TP-5 / TP-6 | Canal de outra unidade / cliente de outra organização recusados |
| TP-6b | Cliente com `deleted_at` recusado |
| TP-7 | `provider = 'zapi'` recusado |
| TP-8 | CHECK de tamanho da subárvore |
| TP-9 | Soft delete do cliente **como `authenticated`** apaga os touchpoints dele e só os dele |
| TP-10 | RLS forçada, zero policies, ACL das duas funções sem `anon`/`authenticated` |
| TP-11 | Idempotência: 115 aplicada três vezes |

Controles positivos: sem a exceção do `set null` (TP-4 aborta o `DELETE`); sem as pernas de coerência (TP-5/6 passam); guarda de `UPDATE` removida (TP-3 passa); trigger de anonimização como `SECURITY INVOKER` (TP-9 apaga zero); `drop` + `create` sem `revoke` (TP-10). Cada controle captura a definição do catálogo, sabota, mede, desfaz por rollback de subtransação e confere o restore — a 115 é `create ... if not exists` e reaplicá-la **não** restaura nada, como na 111.

**Critérios de aceite**

1. Com provider legado, o comportamento é indistinguível do de hoje, com zero consulta nova (teste 3).
2. Com `official`/`datafy`, um inbound com referral grava **uma** linha, em texto ou mídia, mesmo com organização bloqueada ou WhatsApp suspenso.
3. Nenhum `UPDATE` altera um touchpoint; nenhum caminho de código faz `UPDATE` na tabela.
4. Anonimizar o cliente apaga os touchpoints dele.
5. `npm run test`, `npm run typecheck` (`tsc -b`) e `npm run lint` verdes; pré-voo com as contagens do README atualizadas.

---

## 12. Gates antes do merge

Toca banco, webhook e multi-tenant. Obrigatórios: `saas-shield-br:migration-validator` (115), `saas-shield-br:rls-auditor` (tabela `FORCE RLS` sem policy + as duas funções de trigger), `saas-shield-br:tenant-isolation-auditor` (guarda de coerência, `unit_id` pelo canal, D1), `saas-shield-br:integration-reliability-auditor` (dedupe, falha reentregável, parser de webhook). Conferir o `acl-estatico` na aba Checks do PR: a migration cria duas funções.

`CLAUDE.md` e `AGENTS.md` ganham, **no mesmo commit**, as regras permanentes: touchpoint imutável por trigger (com a exceção do `set null`), captura depois do claim e antes dos desvios, capability ⇔ método nas duas direções, escopo unidade + cliente, anonimização por trigger `SECURITY DEFINER`, e a linha de redeploy do núcleo novo.

---

## 13. Pendências de validação real

**VALIDAÇÃO REAL COM PROVIDER PENDENTE.** Não há anúncio CTWA rodando nem credencial Datafy, e nunca passou um inbound Meta por este sistema (§1.2). Nada desta fase foi exercitado contra tráfego real. Às pendências abertas das Fases 0 e C, esta fase acrescenta:

8. **Forma real do `referral`**, no `official` e na Datafy: nome e tipo dos campos, e se o `ctwa_clid` está onde a documentação diz. Responder por `ad_referral_captured` e `meta_inbound_referral_probe` no primeiro clique real — forma, nunca valor.
9. **O clique chega também como mensagem não-texto?** A captura cobre os dois caminhos, mas só o tráfego real diz se o caminho de mídia é exercitado.
10. **Janela de atribuição da Meta para o `ctwa_clid`**, que define o prazo de retenção (D3). Pré-requisito da Fase I.

Até lá, a Fase D **não é declarada validada**.

---

## 14. Emendas de execução

O que a execução mudou em relação ao desenho acima, e por quê:

1. **A perna `cliente-vivo` do guard recusa com SQLSTATE dedicado `P0A15`, não fatal.** O núcleo o classifica como `customer_not_alive` (`CUSTOMER_NOT_ALIVE_SQLSTATE`, gêmeo declarado) e o webhook loga e segue, sem `throw`. A policy de `customers` deixa um membro fazer soft delete direto pelo PostgREST sem trocar o telefone; aí `resolveOrCreateCustomer` devolve sempre o mesmo cliente, e com `check_violation` a recusa viraria reentrega eterna — exatamente o que a D8 não pode ter.
2. **O guard lê o cliente com `for share`.** Sem o lock, uma anonimização concorrente apaga os touchpoints antes de o INSERT em voo commitar e o `ctwa_clid` sobrevive a ela. Medido com duas sessões reais em `supabase/tests/local-preflight/24-concorrencia-115.sh`, nas duas ordens e com controle positivo (sem o `for share`, a linha sobrevive).
3. **Índice parcial em `channel_id`** (`where channel_id is not null`), além dos três de §4.2: FK com `on delete set null` sem índice faz o DELETE do canal varrer a tabela, e o advisor (lint 0001) acusa.
4. **`revoke all on table whatsapp_ad_touchpoints from anon, authenticated`** na própria 115: segunda tranca além da RLS forçada, como em `whatsapp_channels`/`processed_messages`; a tabela guarda identificador pessoal pseudonimizado.
5. **Denylist de chaves pessoais de primeiro nível na subárvore crua** (`REFERRAL_RAW_DENIED_KEYS`: `from`, `wa_id`, `phone`, `phone_number`, `name`, `profile`, `email`, `contacts`, `text`), descartadas antes da medição e contadas no log (`raw_dropped_keys`). A D2 promete telefone, nome e texto fora desta tabela e o envelope não foi medido; chaves aninhadas não são inspecionadas (`welcome_message.text` é campo do anúncio).
6. **O TP-4b mede a dupla cascata do DELETE da unidade, mas não a exceção do `set null`**: as ações de FK do canal chegam depois do cascade direto, que já apagou o touchpoint. Quem mede a exceção é o TP-4, com o C-115-1 como controle.
