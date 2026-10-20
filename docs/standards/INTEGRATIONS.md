# Integrações, webhooks, OAuth, IA com ferramentas e MCP

> Padrão SaaS v3.2 — documento normativo e **fonte única** deste assunto. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia em qualquer tarefa com API externa, webhook, OAuth/OIDC, fila de integração, Meta, Z-API, Datafy, pagamento, e-mail, ERP, storage externo, IA com tools ou MCP.
> Particularidades de cada provedor ficam em `docs/integrations/providers/<provider>.md`. Esses documentos complementam este padrão e não podem enfraquecê-lo.

## 1. Arquitetura [N1]

```text
Módulo → Caso de uso → Porta (capacidade) → Adapter do provedor → Cliente HTTP com política de endpoint
```

Módulos dependem de **capacidade**, não de provedor:

```ts
interface MessagingProvider {
  sendText(input: SendTextInput, ctx: IntegrationContext): Promise<SendResult>;
  sendTemplate(input: SendTemplateInput, ctx: IntegrationContext): Promise<SendResult>;
  getStatus(providerReference: string, ctx: IntegrationContext): Promise<MessageStatus>;
}
// Implementações: MetaMessagingAdapter · ZApiMessagingAdapter · DatafyMessagingAdapter · FakeMessagingAdapter
```

- SDK ou URL de provedor nunca aparece em componente, hook de tela ou domínio.
- O `FakeMessagingAdapter` é o adapter padrão em testes e desenvolvimento local.

Estrutura de referência:

```text
integrations/
  core/          contratos, registry, schemas, erros, endpoint-policy, retry-policy, idempotency, redaction
  providers/<p>/ adapter, client, mapper, webhook, tests
  application/   commands, queries, reconciliation
  infrastructure/ outbox, inbox, secret-store, queue
```

## 2. Classifique antes de codificar [N1]

Antes de escrever código, registre:

- a capacidade de negócio;
- os dados envolvidos (pessoais?);
- as credenciais;
- se há **efeito externo** e se ele é reversível;
- o nível de risco;
- as capacidades reais do provedor (§4);
- o plano de desligamento.

Confirme a versão vigente da API na documentação oficial. Nunca codifique versão ou política só de memória.

Os controles acompanham o tipo de fluxo. Aplique os que protegem o fluxo existente, não a lista inteira:

| Fluxo | Controles |
|---|---|
| **Consulta** sem efeito (ex.: CEP, cotação) | validação de input/resposta, política de endpoint, timeout, erro normalizado, rate limit; cache se fizer sentido |
| **Efeito externo** (enviar mensagem, cobrar, emitir nota) | + idempotência, estado `UNKNOWN`, reconciliação, auditoria; outbox em N2 |
| **Recebimento de eventos** (webhook) | + verificação de autenticidade, dedup durável, processamento recuperável, ordenação |
| **Conta do cliente via OAuth** | + §14, armazenamento seguro de token, revogação |
| **IA com ferramentas / MCP** | + §16 |

Uma consulta de CEP não precisa de inbox nem de fila. Um envio de cobrança precisa de idempotência desde o primeiro dia.

## 3. Registro de conexão [N1]

Cada conta conectada de um tenant é um registro próprio:

```text
integration_connection
  id, company_id, provider, capability, status (active | paused | revoked | error)
  external_account_id     -- unique por provider; é o que mapeia webhook → company_id
  secret_reference        -- referência ao Vault/secret store, nunca o segredo
  webhook_secret_reference
  config_public           -- configuração não sensível
  created_by, created_at, updated_at, last_health_check
```

A leitura de conexões **nunca** retorna segredo, nem mascarado parcialmente em resposta de API.

## 4. Capacidades do provedor [N1]

No `providers/<provider>.md`, registre o que o provedor **realmente** oferece, verificado na documentação oficial:

- aceita chave de idempotência remota?
- tem consulta de status por id?
- assina webhooks? Com qual algoritmo e header?
- garante ordem de eventos?
- qual a política de reentrega?
- quais os limites de taxa?
- tem sandbox?
- permite revogar tokens?
- qual a versão da API?

Não presuma uma capacidade para preencher checklist. O desenho de idempotência, reconciliação e webhook depende dessas respostas.

## 5. Credenciais [N1]

Siga SECURITY §6. Neste contexto, além disso:

- Tokens de provedor ficam só no servidor. Os de cada tenant ficam no Vault ou em criptografia em envelope (N2), referenciados pela conexão.
- Cada credencial só é enviada aos endpoints autorizados daquele provedor e daquela função.
- A redaction é central e cobre headers, bodies e **URLs**. Alguns provedores põem o token no path (ex.: Z-API); nesses casos a URL inteira é segredo e não pode aparecer em log, trace, breadcrumb do Sentry nem mensagem de erro de `fetch`.

## 6. Egress e SSRF [N1]

Para provedores conhecidos:

- base URL fixa no servidor, só HTTPS;
- host e porta em allowlist;
- redirects desabilitados;
- limite de tamanho de resposta e timeout;
- sem IP literal, `localhost`, redes privadas, link-local ou endpoints de metadata de cloud;
- proteção contra DNS rebinding: valide o IP resolvido e conecte ao IP validado.

URL configurável pelo cliente (webhook de saída, ERP próprio) é um recurso separado, com:

- permissão administrativa;
- validação das mesmas regras;
- auditoria e controles de rede;
- revalidação a cada redirect, se redirects forem permitidos;
- **nunca** acompanhada de credencial que não seja do próprio cliente.

## 7. Validação e timeout [N1]

- Valide com schema em runtime tudo o que cruza a fronteira:
  - body, query e headers;
  - **resposta do provedor** (mudanças de formato quebram em silêncio);
  - webhook;
  - configuração;
  - input e output de tools.
- Cada operação define timeout de conexão e timeout total. Nada de chamada sem timeout.

## 8. Idempotência e resultado desconhecido [N1]

Vale para todo efeito externo.

- **Chave:** `company_id` + intenção + id de negócio estável (ex.: `cobranca:<invoice_id>:envio`). Unique constraint no banco.
- **Mesma chave com payload diferente** é conflito: guarde o hash do payload e compare.
- **Ordem:** registre a intenção (`PENDING`) **antes** de chamar o provedor. Envie a chave de idempotência remota quando o provedor aceitar.
- **Estados:** `PENDING → CONFIRMED | FAILED | UNKNOWN`.
- **`UNKNOWN`** é o resultado ambíguo: timeout depois do envio, conexão caiu sem resposta, 5xx após aceite. **Reconcilie antes de qualquer repetição:** consulte o status no provedor ou espere o webhook.
- **Provedor sem consulta de status e sem idempotência remota:** não repita automaticamente. Marque para revisão humana.

Uma chave única no **seu** banco não impede o provedor de executar duas vezes. O cenário a testar é: o provedor executou, a resposta se perdeu, o sistema tenta de novo.

## 9. Retry, backoff e circuit breaker

**[N1]** Retry automático exige as **duas** condições:

1. **Erro transitório:** timeout, 429, 502/503/504 ou falha de transporte; **e**
2. **Repetição comprovadamente segura:** a operação é naturalmente idempotente, o provedor deduplica pela chave enviada, ou há evidência de que a tentativa anterior não foi aplicada.

**[N1]** Nunca faça retry automático de:

- erro de validação;
- 401/403 (exceção: renovar o token **uma** vez e repetir);
- outros 4xx definitivos;
- operação não idempotente sem chave.

**[N1]** Ao repetir:

- backoff exponencial com jitter;
- respeite `Retry-After`;
- limite máximo de tentativas;
- ao esgotar, dead-letter e reconciliação.

**[N2]** Circuit breaker por provedor/instância, com estado no Postgres (memória de função serverless não serve). Fallback para outro provedor nunca é automático quando puder duplicar o efeito.

## 10. Rate limit e quota

- **[N1]** Limite por tenant e por conexão/instância do provedor, respeitando os limites documentados do provedor.
- **[N2]** Limite também por usuário, operação e destino; concorrência máxima; orçamento de custo por tenant.
- O estado dos limitadores fica no Postgres ou no store definido em ADR.

## 11. Outbox

**[N1]** Em N1 sem worker, é aceitável chamar o provedor de forma síncrona **depois do commit**, desde que §8 esteja implementado (intenção registrada, `UNKNOWN`, reconciliação).

**[N2]** Quando uma mudança de negócio gera efeito externo:

1. valide;
2. altere o domínio e grave a outbox **na mesma transação**;
3. commit;
4. o dispatcher lê pendentes (`for update skip locked`);
5. o worker executa com idempotência;
6. registre status e auditoria.

Nunca publique na fila antes do commit: se a transação falhar, o efeito já terá saído.

A outbox entrega no mínimo uma vez. Por isso o consumidor é idempotente.

## 12. Webhooks recebidos (inbox) [N1]

Pipeline:

```text
bytes brutos → limite de tamanho → autenticidade → janela de replay → conta externa → conexão → company_id
→ gravação durável com unique (provider, event_id) → 2xx → processamento assíncrono → auditoria
```

### Autenticidade

- Verifique **sobre o corpo bruto**, antes de `JSON.parse`. O parse e a reserialização alteram bytes e invalidam a assinatura.
- Compare em tempo constante.
- Verify token (desafio GET de configuração) **não** substitui a assinatura dos POSTs.

Exemplo ilustrativo (Next.js App Router, assinatura HMAC no estilo da Meta):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
const MAX_BYTES = 1_000_000;

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return new Response(null, { status: 413 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.byteLength > MAX_BYTES) return new Response(null, { status: 413 });

  const received = Buffer.from(req.headers.get("x-hub-signature-256") ?? "");
  const expected = Buffer.from("sha256=" + createHmac("sha256", process.env.META_APP_SECRET!).update(raw).digest("hex"));
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return new Response(null, { status: 401 });
  }

  const payload = JSON.parse(raw.toString("utf8"));     // só depois de verificar
  await inbox.storeVerified("meta", payload);            // conexão → company_id; unique (provider, event_id)
  return new Response(null, { status: 200 });            // o processamento acontece no worker
}
```

### Provedor que não assina webhooks

Confirme no provider doc. Se o provedor não assinar:

- use um segredo aleatório (≥128 bits) por conexão no **path** da URL do webhook, comparado em tempo constante e rotacionável;
- adicione allowlist de IP se o provedor publicar uma lista;
- antes de agir sobre evento crítico (pagamento confirmado, por exemplo), confirme o estado pela API do provedor.

### Tenant e autorização

- O tenant vem do mapeamento `external_account_id → integration_connection → company_id`, **nunca** de um campo do payload.
- Evento externo informa um fato; ele não autoriza uma ação que exigiria permissão.

### Processamento recuperável

- A deduplicação usa registro **durável** no banco, nunca só cache. Marcar "recebido" num cache e falhar antes de gravar faria a reentrega ser descartada como duplicata.
- Status do evento: `received → processing → processed | failed`. As alterações locais e a marcação `processed` acontecem na mesma transação.
- Eventos presos em `processing` além do lease são reprocessados por um job de recuperação.
- Payloads têm retenção definida e redaction de dados pessoais (SECURITY §10).

### Duplicatas e fora de ordem

Duplicata é o caso normal e precisa ser segura. Ordem **não** é garantida, salvo se o provider doc disser o contrário.

- Cada entidade tem máquina de estados com transições válidas. Evento atrasado não faz status regredir: `delivered` não volta para `sent`.
- Use sequência, versão ou timestamp do provedor só conforme as garantias que ele documenta.
- Na dúvida, reconcilie com o estado autoritativo consultado na API.

## 13. Webhooks enviados pelo produto [N2]

API pública e chaves que o produto **emite** para os clientes: PUBLIC_API.md.


Quando o SaaS notifica sistemas dos clientes:

- assine com HMAC por cliente, incluindo timestamp;
- inclua `event_id` para deduplicação do lado deles;
- faça retries com backoff;
- aplique a política de §6 para URLs configuradas pelo cliente;
- desative automaticamente após falhas persistentes, com aviso ao cliente.

## 14. OAuth/OIDC [N1]

- **Início do fluxo:**
  - `state` único por fluxo, vinculado à sessão;
  - PKCE;
  - `nonce` em OIDC;
  - `redirect_uri` exata e registrada.
- **Validação:**
  - descubra o issuer via metadata;
  - valide issuer, audience/resource e assinatura do ID token;
  - peça os scopes mínimos.
- **Tokens:**
  - criptografados em repouso (Vault/envelope);
  - refresh token protegido e rotacionado quando o provedor suportar;
  - token vinculado ao issuer/provedor e usado só nos endpoints autorizados dele;
  - nunca em query string, log ou mensagem de erro.
- **Ciclo de vida:**
  - callback idempotente;
  - desconectar revoga o token no provedor e marca a conexão como `revoked`.

## 15. Erros normalizados e observabilidade [N1]

O adapter converte erros do provedor em:

```text
INTEGRATION_VALIDATION_ERROR · INTEGRATION_AUTH_ERROR · INTEGRATION_PERMISSION_ERROR
INTEGRATION_RATE_LIMITED · INTEGRATION_TIMEOUT_UNKNOWN · INTEGRATION_PROVIDER_REJECTED
INTEGRATION_TRANSIENT_ERROR · INTEGRATION_CONFIG_ERROR · INTEGRATION_INTERNAL_ERROR
```

Payload bruto do provedor nunca vai ao cliente.

Cada chamada registra (com redaction):

- `request_id`, `correlation_id`, `operation_id`;
- `company_id`, `provider`, `capability`;
- `status`, latência, tentativa;
- `provider_reference`, erro normalizado;
- custo/unidades quando aplicável.

**[N2]** Métricas por provedor:

- taxa de erro;
- latência p95;
- quantidade em `UNKNOWN`;
- tamanho da dead-letter;
- idade do evento pendente mais antigo.

Alertas sobre essas métricas.

## 16. IA com ferramentas e MCP

Estas regras valem para as **tools que o produto expõe** a modelos ou a clientes. Não se aplicam ao uso de terminal e arquivos pelo Claude Code/Codex durante o desenvolvimento (OPERATIONS §7).

### 16.1 Protocolo [N1]

- Verifique a versão vigente da especificação MCP e use o SDK oficial compatível. Não copie exemplo antigo sem verificar. Negocie e registre a versão.
- **MCP remoto (HTTP):**
  - autorização conforme a especificação vigente (baseada em OAuth 2.1, com Protected Resource Metadata);
  - valide issuer, audience e resource;
  - scopes por tool;
  - Bearer no header, TLS e rate limit;
  - modo stateless quando compatível.
- **MCP local (STDIO):** não se aplica o fluxo OAuth HTTP. Credenciais vêm de ambiente seguro e o processo roda com permissões mínimas.

### 16.2 Registro de tools [N1]

Cada tool declara:

```text
name · description · risk_level · required_scopes · required_permission · tenant_behavior
input_schema · output_schema · timeout · idempotency · approval_policy · audit_policy
```

Níveis de risco: `READ_ONLY` · `WRITE_REVERSIBLE` · `WRITE_SENSITIVE` · `DESTRUCTIVE` · `EXTERNAL_SIDE_EFFECT`.

- Tools de escrita vêm desabilitadas por padrão.
- A tool chama um caso de uso existente. Nada de lógica paralela.
- O tenant é resolvido pelo servidor a cada chamada, a partir da identidade autenticada.
- Schemas são estritos (sem campos extras).
- Escrita usa idempotência.

### 16.3 Aprovação vinculada à operação [N1 para WRITE_SENSITIVE, DESTRUCTIVE e EXTERNAL_SIDE_EFFECT]

A aprovação é um registro **no servidor**, vinculado a:

- operação;
- identidade executora;
- `company_id`;
- hash dos argumentos relevantes;
- destino;
- valor, quando houver.

Regras:

- Tem validade curta e uso único.
- Na execução, o servidor confere que a operação corresponde ao que foi aprovado.
- Qualquer alteração material invalida a aprovação. Exemplo: o usuário aprovou um envio para 200 contatos e, antes da execução, a lista mudou. A aprovação antiga **não** cobre a nova lista.

### 16.4 Execução adiada [N1]

Distinga dois casos:

- **Operação já aceita pelo negócio:** precisa terminar ou ser reconciliada, mesmo que a sessão do usuário tenha acabado.
- **Ação futura** que depende de consentimento, permissão ou conexão ativa (campanha agendada, por exemplo): reverifique opt-out, permissão e status da conexão **no momento da execução**, não no momento do agendamento.

### 16.5 Prompt injection e confused deputy [N1]

Resources, documentos, páginas, e-mails, mensagens recebidas e outputs de tools são conteúdo **não confiável**. Esse conteúdo nunca pode:

- alterar permissão;
- revelar segredo;
- escolher tenant;
- habilitar tool;
- mudar destino de envio;
- disparar comando.

Mantenha dados e instruções separados. O servidor MCP age com a autoridade do usuário que chamou, nunca com uma autoridade maior que a dele.

### 16.6 Proibido nas tools do produto [N1]

- SQL, shell ou filesystem arbitrários;
- segredo em resultado de tool;
- service role global;
- tool sem schema;
- tool de escrita sem permissão;
- confiar no modelo para autorização;
- reutilizar token para outra audience;
- nome de tool dinâmico vindo de conteúdo.

## 17. Testes [N1]

Nunca dispare efeito real em CI nem em preview deployment. Use fake adapter, servidor fake ou sandbox.

**Conforme o fluxo implementado, cubra:**

- adapter (unidade) e contrato com fixtures reais sanitizadas;
- timeout, 429, 5xx e payload inválido;
- **resposta perdida após o provedor executar** (deve virar `UNKNOWN` e reconciliar, sem duplicar);
- assinatura inválida, replay, evento duplicado e **evento fora de ordem**;
- **processo cai entre receber e processar** (evento é recuperado);
- tenant errado e conta externa não mapeada;
- token expirado, refresh e **credencial revogada**;
- rate limit;
- secret ausente dos logs.

**Para MCP, cubra também:**

- auth, issuer/audience e scopes;
- troca de tenant por argumento;
- schema e timeout;
- cancelamento;
- aprovação: alteração material invalida;
- prompt injection e exfiltração;
- concorrência;
- revogação.

## 18. Desligamento e troca de provedor [N1]

- **Kill switch** por provedor e por conexão (feature flag ou status da conexão), acionável sem deploy.
- Troca de provedor: novo adapter atrás da mesma porta, migração gradual por tenant, e nunca dois provedores enviando o mesmo efeito em paralelo.

## 19. Definition of Done da integração

Marque cada item como APLICÁVEL, NÃO APLICÁVEL (com justificativa) ou PENDENTE:

- [ ] porta e adapter separados; fake adapter
- [ ] capacidades do provedor registradas no provider doc
- [ ] schemas de input, output e resposta do provedor
- [ ] tenant resolvido pelo servidor; permissão verificada
- [ ] credenciais no servidor/Vault; redaction inclusive de URL
- [ ] política de endpoint e timeout
- [ ] idempotência, `UNKNOWN` e reconciliação (efeito externo)
- [ ] retry só transitório e seguro; backoff; dead-letter
- [ ] rate limit
- [ ] webhook: autenticidade no raw body, dedup durável, recuperação, ordenação
- [ ] outbox (N2)
- [ ] observabilidade e erros normalizados
- [ ] testes dos cenários de §17 aplicáveis
- [ ] kill switch
- [ ] documentação no nível certo (§20)
- [ ] nenhum segredo exposto; nenhum efeito real em CI

## 20. Onde documentar

- Particularidade durável do provedor → `docs/integrations/providers/<provider>.md`.
- Invariante do módulo → `docs/modules/<modulo>.md`.
- Decisão arquitetural → ADR.
- Progresso e evidências da implementação → `.tasks/<slug>/`.
- Nada durável → nenhuma atualização.

## Particularidades deste projeto

- WhatsApp: Z-API, uazapi, Datafy (parceiro oficial, proxy da Cloud API da Meta) e Meta Cloud API. Provider docs: `docs/integrations/providers/zapi.md` e `meta.md` (modelos do padrão, ainda sem verificação do projeto); uazapi e Datafy em `docs/whatsapp-multiprovider-uazapi.md` e `docs/datafy-parceiro-runbook.md`.
- Pagamentos: Stripe (caução) e Asaas (mensalidade; API verificada em `docs/billing-asaas/03-ASAAS-API-VERIFICADO.md`).
- IA: OpenAI, Anthropic, Gemini, xAI e DeepSeek, com chave por unidade (BYOK, sem fallback global). E-mail: Resend.
- Runner: outbox/filas Postgres + `pg_cron` → `pg_net` → Edge Function; inbound de WhatsApp por fila (`.claude/rules/whatsapp.md`).
- Regras por provedor e fluxo: `.claude/rules/whatsapp.md`, `whatsapp-templates.md`, `datafy.md`, `agente-ia.md`, `billing.md`.
