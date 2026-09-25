/**
 * Núcleo puro da ingestão assíncrona (Fase C).
 *
 * TODA decisão que a Fase C inventa mora aqui, e não no `index.ts` do
 * `webhook-whatsapp`: o vitest não importa aquela Edge Function (`serve()` no
 * carregamento + imports de `deno.land`), e regra que só se confere por
 * leitura já passou defeito duas vezes neste repo.
 *
 * Sem I/O, sem `Deno`, sem cliente Supabase. Só decisão.
 */

import { DATAFY_SIGNATURE_HEADER } from "./datafy-signature-core.ts";
import type { WebhookSignatureScheme } from "./whatsapp-provider-core.ts";

/** De onde veio a invocação. NÃO é o provider — é a porta de entrada. */
export type IngestionSource = "provider" | "queue" | "sweep";

/**
 * `unknown` NÃO é "não sei, então OFF". É "não consigo afirmar", e o caller
 * traduz em 503. Tratar leitura falha de gate como OFF processaria síncrono e
 * estouraria o orçamento do provider sem deixar rastro.
 */
export type IngestionMode = "async" | "sync" | "unknown";

export type InsertOutcome = "inserted" | "duplicate" | "failed" | "skipped";

export type AckVerdict =
  | { kind: "passthrough" }
  | { kind: "ack"; status: 200; outcome: string }
  | { kind: "retry"; status: 503; outcome: string };

/** Escada de retentativa da fila. Curta e rasa de propósito — ver header. */
export const INBOUND_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;
export const INBOUND_MAX_ATTEMPTS = INBOUND_RETRY_DELAYS_MS.length;

/** TTL do lease da linha. Espelha o takeover de `processed_messages`. */
export const INBOUND_LEASE_TTL_MS = 90_000;

/** Orçamento do deadline suave, contado do início do PROCESSAMENTO. */
export const AGENT_SOFT_DEADLINE_MS = 30_000;
/** Pior turno único medido: Gemini primary (12s+backoff) + fallback (12s+backoff). */
export const WORST_SINGLE_TURN_MS = 31_000;
/** Folga para sanitização, envio e append depois do loop. */
export const POST_LOOP_SEND_MS = 5_000;

export const PURGE_DONE_AFTER_DAYS = 7;
export const PURGE_DEAD_AFTER_DAYS = 30;

/** Espelha o CHECK de `delivery_id` da migration 111 (`length(btrim(delivery_id)) between 1 and 512`) — mudar um dos dois sem o outro é o começo do drift. */
const MAX_DELIVERY_ID_LEN = 512;

/**
 * As DUAS pernas do gate, mais a guarda anti-laço.
 *
 * `source !== "provider"` é a única coisa que impede a re-entrada a partir da
 * fila de persistir o evento de novo — laço infinito, o defeito mais perigoso
 * disponível neste desenho. Ele vive aqui, e não como um `if` solto no
 * handler, justamente para ter teste com controle positivo.
 *
 * As duas pernas são deliberadamente ASSIMÉTRICAS quanto a sinal de falha de
 * leitura, e isso não é descuido:
 *
 * - A perna da FLAG precisa de `flagReadFailed` porque `checkFlagEnabled`
 *   devolve `{ enabled, readFailed }`, e no call site uma leitura falha da
 *   flag é indistinguível de "a flag existe e está OFF" — sem o campo
 *   separado, as duas colapsam no mesmo `false`.
 * - A perna do CANAL não tem sinal equivalente porque uma leitura falha do
 *   canal já é TERMINAL rio acima de onde este gate é chamado: em
 *   `webhook-whatsapp/index.ts:1587`, `if (channelErr || !channel)` devolve
 *   404 antes de qualquer código chegar perto da resolução do gate (~linha
 *   1728). Fora isso, a coluna é `not null default false` — o banco
 *   fisicamente não devolve `null`. Logo `channelEnabled: null | undefined`
 *   só pode significar UMA coisa: o SELECT do caller não pediu a coluna, um
 *   defeito diferente (já rastreado à parte), não uma falha de leitura em
 *   trânsito.
 *
 * Consequência explícita: se algum dia este gate for movido para ANTES da
 * resolução do canal, ou a coluna virar nullable, a perna do canal passa a
 * ter um modo de falha genuíno e esta função precisa ganhar um parâmetro
 * `channelReadFailed`, no mesmo molde de `flagReadFailed`. Até lá, adicionar
 * esse parâmetro criaria um branch inalcançável e uma falsa sensação de
 * cobertura.
 *
 * A ORDEM DAS PERNAS É LOAD-BEARING: o CERTO decide antes do INCERTO, e
 * inverter de volta reintroduz um defeito de produção.
 *
 * `channelEnabled` é entrada CERTA — a coluna é `not null default false` e uma
 * leitura falha do canal já virou 404 rio acima —, enquanto a flag é a única
 * entrada que admite "não sei". Perguntar a incerta primeiro fazia um soluço de
 * leitura de `platform_flags` devolver `unknown` → 503 em TODO inbound de TODO
 * canal, inclusive dos quatro providers legados com o gate desligado nas duas
 * pernas: a loja em produção parava de responder por causa de uma tabela que
 * não tem nada a ver com ela. Para canal NÃO optado, "processar síncrono" é
 * exatamente o comportamento de hoje, então devolver `sync` ali não é risco
 * novo — é a ausência de um.
 *
 * Isto NÃO afrouxa o fail-closed: para canal optado (`channelEnabled === true`)
 * a flag ilegível continua produzindo `unknown` → 503, que é precisamente onde
 * a razão da spec se aplica (aquele canal PODE estar rodando assíncrono e não
 * há como saber). Quem "simplificar" esta ordem por simetria precisa ler este
 * parágrafo primeiro.
 */
export function decideIngestionMode(input: {
  source: IngestionSource;
  flagEnabled: boolean;
  flagReadFailed: boolean;
  channelEnabled: boolean | null | undefined;
}): IngestionMode {
  if (input.source !== "provider") return "sync";
  if (input.channelEnabled !== true) return "sync";
  if (input.flagReadFailed) return "unknown";
  if (!input.flagEnabled) return "sync";
  return "async";
}

/**
 * Régua herdada do `asaas-webhook`, adaptada ao contrato da Datafy:
 * 200 = já está durável ou foi descartado de propósito;
 * não-200 = não consegui guardar, reentrega.
 */
export function decideAckVerdict(input: {
  mode: IngestionMode;
  insert: InsertOutcome;
}): AckVerdict {
  if (input.mode === "unknown") {
    return { kind: "retry", status: 503, outcome: "queue_gate_unreadable" };
  }
  if (input.mode === "sync") return { kind: "passthrough" };
  if (input.insert === "inserted") {
    return { kind: "ack", status: 200, outcome: "queued" };
  }
  if (input.insert === "duplicate") {
    return { kind: "ack", status: 200, outcome: "queue_duplicate_delivery" };
  }
  return { kind: "retry", status: 503, outcome: "queue_insert_failed" };
}

/**
 * String vazia NÃO pode virar chave de dedupe: o unique é parcial
 * (`where delivery_id is not null`) e `''` não é null, então duas entregas
 * distintas com header vazio colidiriam e a segunda sumiria como "duplicata".
 */
export function normalizeDeliveryId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_DELIVERY_ID_LEN) return null;
  return trimmed;
}

/**
 * Header do id de entrega da Datafy. Constante exportada porque o webhook
 * também o instrumenta (FORMA, nunca valor) — duas digitações do mesmo nome de
 * header em arquivos diferentes é o começo do drift.
 */
export const DATAFY_DELIVERY_ID_HEADER = "x-datafy-delivery-id";

/**
 * Só a Datafy declara id de entrega hoje. Providers legados não têm, e para
 * eles `processed_messages (provider, message_id)` segue sendo a autoridade
 * de idempotência — exatamente como já é.
 *
 * Existe como predicado, e não como `provider !== "datafy"` repetido, porque o
 * webhook precisa da MESMA pergunta para decidir se instrumenta a forma do
 * header — e o repo já nomeia a cascata de `if (provider)` espalhada pelo
 * webhook como o jeito de o próximo provider entrar sem ninguém notar.
 */
export function providerDeclaresDeliveryId(provider: string): boolean {
  return provider === "datafy";
}

export function deliveryDedupeKey(
  provider: string,
  headerGet: (name: string) => string | null,
): string | null {
  if (!providerDeclaresDeliveryId(provider)) return null;
  return normalizeDeliveryId(headerGet(DATAFY_DELIVERY_ID_HEADER));
}

/**
 * Header que carrega a assinatura, por ESQUEMA — não por provider.
 *
 * Existe para preencher `whatsapp_inbound_events.signature_header`, que é
 * AUDITORIA e não autoridade: nada decide nada a partir dele. Fica chaveado
 * pelo tipo `WebhookSignatureScheme` (e não por `Record<string, string>`)
 * porque assim um esquema novo sem entrada aqui reprova no `tsc -b` que
 * alcança este arquivo pelo teste em `src/lib/` — enquanto o `index.ts` do
 * webhook, onde este mapa nasceria, não é alcançado por compilador nenhum.
 *
 * A entrada da Datafy vem da constante canônica de `datafy-signature-core.ts`,
 * que é quem VALIDA esse header: uma fonte só. As outras duas são literais
 * porque não existe constante equivalente — `x-hub-signature-256` está inline
 * em `validateMetaSignature` e `x-webhook-secret` em `validateChannelSecret`
 * (`_shared/whatsapp-providers.ts`). Extrair as duas obrigaria redeploy de nove
 * Edge Functions.
 *
 * ESSAS DUAS PODEM DIVERGIR DOS VALIDADORES, e é decisão consciente não montar
 * guarda estática contra isso. O teste deste núcleo PINA o mapa (detecta quem
 * mexer AQUI), não confere o fonte de `whatsapp-providers.ts` — logo quem
 * renomear o header lá deixa este mapa desatualizado sem nada ficar vermelho. A
 * consequência é `signature_header` gravado `null` numa coluna de AUDITORIA:
 * nada decide nada a partir dela, nenhum caminho quebra. Guarda que lê fonte
 * custa manutenção permanente e aqui pagaria por um campo que ninguém lê em
 * runtime. Não é esquecimento.
 *
 * `channel_secret` também aceita `?secret=` na querystring. Nesse caso o header
 * é ausente e a coluna fica `null`, de propósito: guardar o valor da
 * querystring persistiria uma credencial VIVA numa linha de tabela.
 */
export const SIGNATURE_HEADER_BY_SCHEME: Readonly<Record<WebhookSignatureScheme, string>> = {
  meta_app_secret: "x-hub-signature-256",
  datafy_whsec: DATAFY_SIGNATURE_HEADER,
  channel_secret: "x-webhook-secret",
};

/**
 * Corpo cru → literal `bytea` do Postgres.
 *
 * `bytea` e não `text` porque Postgres recusa `\u0000` em `text` (22021), e um
 * único inbound com NUL faria o INSERT falhar, virar 503, e o provider
 * reentregar até desistir. A revalidação de assinatura exige o byte exato, e
 * é por isso que o corpo nunca é re-serializado por `JSON.parse`/`stringify`
 * em lugar nenhum deste caminho.
 */
export function encodeRawBodyHex(bodyText: string): string {
  const bytes = new TextEncoder().encode(bodyText);
  let hex = "\\x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Inverso de `encodeRawBodyHex`, para a re-entrada a partir da fila. Aceita com
 * e sem o prefixo `\x` porque quem devolve o valor é o PostgREST, não nós.
 *
 * ESTOURA em qualquer entrada que não seja hex par e completo, e isso é
 * DESEJADO: corpo corrompido não pode virar payload silenciosamente diferente do
 * que o provider assinou. Quem chama está dentro de um `try/catch` que
 * transforma a exceção em retentativa da linha — um erro claro na linha da fila,
 * em vez de um 401 inexplicável na revalidação do HMAC.
 *
 * A validação é explícita porque as duas formas "naturais" de escrever isto
 * falham em silêncio: `parseInt` devolve `NaN` para caractere não-hex, e `NaN`
 * atribuído a um `Uint8Array` grava `0` sem erro nenhum — exatamente o byte
 * trocado que este comentário jura não tolerar. (Comprimento ímpar já estouraria
 * por conta do `RangeError` de `new Uint8Array`, mas depender disso deixaria a
 * garantia dependendo de um efeito colateral.)
 */
export function decodeRawBodyHex(hex: string): string {
  const clean = hex.startsWith("\\x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`raw_body_hex_odd_length:${clean.length}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error("raw_body_hex_not_hex");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** `null` significa: esgotou, promove para `dead`. */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (!Number.isFinite(attempts) || attempts < 0) return null;
  if (attempts >= INBOUND_MAX_ATTEMPTS) return null;
  return INBOUND_RETRY_DELAYS_MS[attempts];
}

/**
 * Limite do texto de erro que atravessa para o SQL. A migration 113 tem
 * `left(p_error, 500)` como BACKSTOP para quem não passe por aqui; este é o
 * limite real, e os dois números são diferentes de propósito.
 */
export const INBOUND_ERROR_TEXT_MAX = 300;

/**
 * Deixa o texto de erro GRAVÁVEL numa coluna `text` do Postgres.
 *
 * Isto não é higiene: é o que impede uma linha da fila de ficar presa para
 * sempre. Postgres **recusa** `\u0000` em `text` (SQLSTATE 22021) — é a mesma
 * razão pela qual `raw_body` é `bytea` e não `text`, escrita no cabeçalho da
 * migration 111. Se um octeto NUL chegasse a `p_error`, a finalização falharia
 * SEMPRE, e como são a finalização quem escreve `attempts` e `next_attempt_at`,
 * a linha nunca avançaria: continuaria devida e reivindicável, retomada a cada
 * 90 s pelo takeover, para sempre, sem nunca virar dead letter. E como a
 * varredura ordena por `next_attempt_at`, essa linha seria SEMPRE a primeira —
 * consumindo o orçamento de laço e adiando o inbound de todos os outros tenants.
 *
 * `sanitizeProviderError` (em `ai-providers.ts`) redige credencial e corta em
 * 300, mas não toca em caractere de controle: ele foi escrito para LOG, onde
 * NUL é feio e não fatal. Quem escreve em coluna passa por aqui também.
 *
 * Remove todo C0/C1 (inclusive `\n` e `\t`: o valor vai para uma coluna de
 * diagnóstico de uma linha, não para um bloco de texto) e normaliza para espaço
 * em vez de apagar, para não fundir palavras — o defeito que este repo já pagou
 * ao descartar `\n` de texto colado.
 */
export function sanitizeQueueErrorText(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const cleaned = input
    // Escritos como `\uXXXX` e não como literais de controle: a regra
    // `no-control-regex` não reclama desta forma, e ela é legível.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, INBOUND_ERROR_TEXT_MAX);
}

/**
 * O veredito da LINHA DA FILA, a partir do desfecho HTTP da re-entrada.
 *
 * `retryDelaySeconds` é SEGUNDOS, não timestamp, e isso é a metade visível de
 * uma regra: quem escreve `next_attempt_at` é o banco, por `now() + interval`.
 * Devolver um instante daqui obrigaria o Deno a escolher o relógio que o banco
 * depois compara — o defeito de borda que este repo já pagou em
 * `availability.ts`, na outra coluna.
 *
 * TRÊS classes, e a do meio existe por medição:
 *
 * 1. **2xx → `done`.** Inclui desfechos que não respondem nada ao cliente
 *    (canal inativo, conversa em handoff humano, duplicata em
 *    `processed_messages`, callback de status): o pipeline devolve 200 neles
 *    porque são desfechos CORRETOS, não falhas.
 * 2. **401 → TERMINAL, e termina em `done`, não em `dead`.** Existe uma guarda
 *    de 401 que fica DEPOIS da fronteira do ACK e não pode subir
 *    (`manual_echo_channel_identity_mismatch`: ela julga eco da parte única,
 *    depois do split do lote). Com o gate ligado ela deixa de ser 401 síncrono e
 *    vira linha na fila. Retentá-la queimaria três tentativas sobre payload que
 *    NUNCA será aceito; e marcá-la `dead` reteria o CORPO CRU — telefone e texto
 *    de cliente, PII — por 30 dias, quando o rastro de segurança já existe em
 *    `webhook_executions` (`outcome: webhook_unauthorized`, TTL 30 d) SEM o
 *    corpo. Então a linha morre no purge de 7 dias, não no de 30.
 * 3. **Qualquer outro não-2xx, ou exceção antes de haver resposta
 *    (`httpStatus: null`) → escada de `nextAttemptDelayMs`.** Esgotada, `dead`
 *    com `promoteToHandoff`, porque quem assume aí é uma pessoa.
 *
 * Só 401 é terminal, e não uma faixa 4xx: os outros 4xx do handler são
 * inalcançáveis na re-entrada (o corpo já parseou e já passou pela guarda de
 * tamanho na porta do provider), e 404 significaria canal apagado — caso em que
 * a linha já sumiu por cascade. Alargar para `>= 400` transformaria um 503 de
 * Vault indisponível (UazAPI) em descarte silencioso.
 *
 * ─── O QUE ESTA CLASSE ABSORVE, E O PREÇO ACEITO ──────────────────────────────
 *
 * A classe 401 não pega só a guarda de eco: ela pega TODAS as guardas de
 * identidade do handler, inclusive as que ficam antes da fronteira do ACK
 * (a âncora `phone_number_id` de `metaPayloadMatchesChannel` e as vizinhas).
 * Na porta do provider isso é inalcançável pela fila — payload que falha ali
 * nunca é persistido. Na RE-ENTRADA é alcançável por UM caminho: as credenciais
 * do canal MUDARAM entre a persistência e o reprocessamento, então a linha
 * enfileirada — cuja assinatura FOI validada — passa a falhar uma guarda que
 * havia passado.
 *
 * O preço é conhecido e aceito: numa rotação de credencial, a mensagem de
 * cliente que estava na janela da escada (no máximo ~7,5 min) é descartada em
 * silêncio, sem handoff. As duas alternativas são piores.
 *
 * Retentar não resolve: a âncora antiga não volta a casar, então as três
 * tentativas terminam no mesmo 401 e a linha vira dead letter — retendo o corpo
 * cru por 30 dias para chegar ao mesmo lugar.
 *
 * E promover a handoff supõe que a linha pertence a este tenant, o que NÃO é
 * garantido. Uma entrega simplesmente mal-roteada pelo provider não chega aqui —
 * a guarda de identidade a recusa na porta, ANTES do insert, então ela nunca
 * entra na fila (foi um erro afirmar o contrário numa versão anterior deste
 * comentário). O caso real é outro e mais desconfortável: a âncora que ACEITOU
 * o payload pode ter sido a errada, porque `manage-channels:update` aceita
 * `phone_number_id` vindo do corpo, e porque a âncora pode migrar para um canal
 * de outra organização. Aí a linha enfileirada é de um tenant e o handoff cairia
 * no outro — pedindo a uma pessoa daqui que responda a um cliente que não é
 * dela. Descartar em silêncio erra menos que acusar o tenant errado.
 *
 * Só o rastro fica: `queue_unauthorized_terminal` na linha e
 * `webhook_unauthorized` em `webhook_executions`.
 *
 * A consequência disso é VISIBILIDADE, e ela é trabalho da Task 8 (diagnóstico
 * de dead letter): contar `queue_unauthorized_terminal` por unidade é o que
 * transforma "sumiu" em "some quando alguém roda uma rotação".
 */
export interface QueuedEventVerdict {
  status: "done" | "received" | "dead";
  outcome: string;
  retryDelaySeconds: number | null;
  promoteToHandoff: boolean;
}

export function queuedEventVerdict(input: {
  /** `null` = exceção antes de haver resposta (decode do corpo, rede, etc.). */
  httpStatus: number | null;
  /** O valor ATUAL da linha, antes deste desfecho — quem incrementa é o SQL. */
  attempts: number;
}): QueuedEventVerdict {
  const { httpStatus } = input;

  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    return {
      status: "done",
      outcome: "queue_processed",
      retryDelaySeconds: null,
      promoteToHandoff: false,
    };
  }

  if (httpStatus === 401) {
    return {
      status: "done",
      outcome: "queue_unauthorized_terminal",
      retryDelaySeconds: null,
      promoteToHandoff: false,
    };
  }

  const delayMs = nextAttemptDelayMs(input.attempts);
  if (delayMs === null) {
    return {
      status: "dead",
      outcome: "queue_dead_letter",
      retryDelaySeconds: null,
      promoteToHandoff: true,
    };
  }
  return {
    status: "received",
    outcome: "queue_retry_scheduled",
    retryDelaySeconds: Math.ceil(delayMs / 1000),
    promoteToHandoff: false,
  };
}

/**
 * Suave: impede COMEÇAR nova rodada de ferramenta, nunca aborta a em curso.
 * Abortar depois de `create_reservation` deixaria reserva criada e cliente sem
 * resposta — o risco que o `mutatingToolUsed` de hoje já tenta cobrir.
 */
export function agentDeadlineVerdict(input: {
  startedAt: number;
  now: number;
  budgetMs?: number;
}): "continue" | "stop_new_rounds" {
  const budget = input.budgetMs ?? AGENT_SOFT_DEADLINE_MS;
  const elapsed = input.now - input.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return "continue";
  return elapsed >= budget ? "stop_new_rounds" : "continue";
}

/**
 * O TTL do lock de conversa deixa de ser adivinhado.
 *
 * `AI_LOCK_TTL_SECONDS = 90` foi dimensionado contra "~51s de pior caso do
 * runOnce" — que era pior caso de UM turno, não do loop de até 12. Esta função
 * existe para que um teste reprove quem subir o orçamento sem subir o TTL.
 */
export function lockTtlSecondsRequired(input?: { budgetMs?: number }): number {
  const budget = input?.budgetMs ?? AGENT_SOFT_DEADLINE_MS;
  return Math.ceil((budget + WORST_SINGLE_TURN_MS + POST_LOOP_SEND_MS) / 1000);
}

/**
 * Janela de rajada por conversa, em milissegundos.
 *
 * Mora aqui, e não como literal no `index.ts`, porque a varredura precisa dela
 * para reservar o pior caso de um evento — e um número igual digitado em dois
 * arquivos é como a divergência nasce. `DEBOUNCE_WINDOW_MS`, no
 * `webhook-whatsapp/index.ts`, é ESTA constante: quem mudar a janela muda a
 * reserva da varredura junto, sem precisar lembrar.
 */
export const INBOUND_DEBOUNCE_WINDOW_MS = 6_000;

/**
 * Pior caso de UM evento da fila, do claim ao fim do envio.
 *
 * Derivado, nunca digitado: é a janela de debounce mais a MESMA aritmética de
 * `lockTtlSecondsRequired` — orçamento do laço + um turno de pior caso + a folga
 * de envio. A soma é essa (e não "orçamento OU turno") porque o deadline é
 * SUAVE: ele impede COMEÇAR rodada nova, então uma rodada iniciada a 29,999 s
 * ainda roda um turno inteiro de pior caso. É exatamente por isso que o TTL do
 * lock de conversa já vale 90 s e não 31 s.
 *
 * Hoje: 6 000 + 66 000 = 72 000 ms. Subir o orçamento do agente sobe esta
 * reserva sozinho, que é o ponto de derivá-la.
 */
export const WORST_CASE_QUEUED_EVENT_MS =
  INBOUND_DEBOUNCE_WINDOW_MS + lockTtlSecondsRequired() * 1000;

/**
 * Orçamento de PAREDE de uma varredura, em milissegundos.
 *
 * Dois números o cercam. Por baixo, ele precisa ser maior que
 * `WORST_CASE_QUEUED_EVENT_MS`, senão a varredura nunca começaria um SEGUNDO
 * evento e a fila andaria a uma linha por minuto. Por cima, o agendamento é de
 * 1 em 1 minuto e **`pg_cron` NÃO pula execuções sobrepostas**: duas varreduras
 * podem estar no ar ao mesmo tempo. O que torna a sobreposição segura é o claim
 * por linha, não o agendamento — o orçamento existe para que ela seja exceção,
 * não rotina.
 *
 * Com 120 s, a varredura para de COMEÇAR evento novo depois de 48 s de trabalho
 * (120 − 72), então no caso comum (eventos rápidos: duplicata, callback de
 * status, canal inativo) ela termina dentro do próprio minuto e não encosta na
 * seguinte. Só um evento genuinamente lento a leva além — e aí a sobreposição é
 * o comportamento certo, porque a outra varredura pega OUTRAS linhas.
 *
 * Estourar mesmo assim não perde nada: o worker morre, a linha em curso fica
 * `processing` com lease vivo e o takeover de 90 s a retoma. O orçamento torna
 * isso raro; a cerca é que o torna inofensivo.
 *
 * ─── O LIMITE REAL NÃO FOI MEDIDO, E ESTE NÚMERO NÃO É UMA AFIRMAÇÃO SOBRE ELE ─
 *
 * Este orçamento é HEURÍSTICO de propósito, e não deriva de nenhum teto que se
 * conheça, por duas razões:
 *
 * 1. Nada foi deployado nesta fase (ruling R10), então o wall clock desta função
 *    não foi observado uma vez sequer. Há, noutro ponto deste repo, um comentário
 *    que fala em "limite de 60 s da Edge Function"
 *    (`AGENT_RETRY_BUDGET_MS`, em `webhook-whatsapp/index.ts`): é crença
 *    herdada, não medição, e o próprio repo a contradiz — o TTL do lock de
 *    conversa existe porque um turno de pior caso leva ~51 s, e somado ao
 *    debounce isso já passaria de 60 s no caminho SÍNCRONO que roda em produção
 *    hoje. Não corrija um número pelo outro: meça.
 * 2. Ainda que houvesse um teto publicado, **o wall clock é do WORKER e não da
 *    request**. Um worker que já serviu outras requisições chega aqui com menos
 *    tempo do que um recém-criado, e nenhuma constante pode saber quanto. Um
 *    orçamento exato é impossível por construção.
 *
 * Por isso a correção NÃO depende deste valor. Ele só decide a FREQUÊNCIA de
 * sobreposição entre varreduras; quem garante que a sobreposição não duplica
 * resposta é o claim cercado por UUID, e quem garante que o worker morto não
 * perde trabalho é o lease de 90 s. Errar este número para mais faz o worker
 * morrer no meio às vezes (retomado em 90 s); errar para menos faz a varredura
 * processar menos linhas por invocação. Nenhum dos dois perde inbound.
 *
 * Medir é passo do dono, está no procedimento de deploy, e a medição certa não é
 * "qual o teto documentado" e sim quanto tempo uma varredura de verdade leva —
 * `net._http_response` guarda isso por execução.
 */
export const SWEEP_WALL_CLOCK_BUDGET_MS = 120_000;

/** Teto de linhas pedidas por varredura. O banco também limita (`least(..., 100)`). */
export const SWEEP_SELECT_LIMIT = 20;

/**
 * A varredura para de COMEÇAR; ela NUNCA aborta o evento em curso.
 *
 * Abortar no meio deixaria reserva criada e cliente sem resposta — a mesma razão
 * pela qual `agentDeadlineVerdict` é suave. E não há nada a desfazer: linha que
 * não foi começada não foi REIVINDICADA, então ela simplesmente fica para o
 * minuto seguinte. Nada órfão, nada perdido.
 *
 * A primeira linha começa SEMPRE. Uma varredura que não processa nada nunca
 * esvazia a fila, e o custo máximo de começar uma só é o worker ser derrubado no
 * meio dela — que o lease de 90 s já cobre.
 *
 * A reserva é o PIOR CASO, não uma média. A média é o que faz o worker morrer no
 * meio: eventos de fila são majoritariamente rápidos, e é justamente o lento que
 * precisa caber inteiro no que resta.
 */
export function sweepShouldStartAnother(input: {
  startedAt: number;
  now: number;
  processed: number;
}): boolean {
  if (!(input.processed > 0)) return true;
  const elapsed = input.now - input.startedAt;
  // Relógio não-monotônico: mesma postura de `agentDeadlineVerdict` — o dado é
  // inútil, e recusar por causa dele calaria a varredura inteira.
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  return elapsed + WORST_CASE_QUEUED_EVENT_MS <= SWEEP_WALL_CLOCK_BUDGET_MS;
}

/**
 * Os ids devolvidos por `select_due_whatsapp_inbound_events`.
 *
 * Existe porque a FORMA do retorno de uma função `returns setof uuid` é do
 * PostgREST, não nossa, e ela NÃO PÔDE SER MEDIDA nesta task (nada foi aplicado a
 * banco nenhum, nenhuma função foi deployada). O esperado é um array de escalares
 * (`["uuid", ...]`); a forma alternativa plausível é um array de objetos de uma
 * chave só. Aceitar as duas custa três linhas; errar a aposta custaria uma
 * varredura que devolve `{"processed":0}` para sempre, com a fila cheia e nenhum
 * erro — o modo de falha mais caro disponível aqui, porque ele se parece com
 * "não havia nada a fazer".
 *
 * Fora dessas duas formas, descarta o item em vez de inventar id: chamar o claim
 * com lixo só gastaria ida ao banco.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelectedEventIds {
  ids: string[];
  /**
   * Itens que vieram e não viraram id. `> 0` com `ids` vazio é o sinal de que a
   * aposta sobre a forma errou — e é o ÚNICO sinal que existe, porque uma forma
   * imprevista não produz erro nenhum: o PostgREST devolve 200, a varredura
   * devolve `{"processed":0}` e `net._http_response` fica verde enquanto a fila
   * cresce. Sem este contador, o modo de falha mais caro disponível aqui se
   * parece com "não havia nada a fazer", 1440 vezes por dia.
   */
  descartados: number;
}

export function parseSelectedEventIds(data: unknown): SelectedEventIds {
  if (!Array.isArray(data)) {
    // `null`/`undefined` NÃO contam descarte, e isto é tolerância deliberada, não
    // uma afirmação: para `returns setof uuid` o corpo de zero linhas é `[]`, não
    // `null` — então um `null` aqui já seria forma inesperada. Ele é isentado
    // porque o supabase-js também devolve `data: null` em situações de borda que
    // nada têm a ver com a forma, e um canário que gritasse a cada varredura de
    // fila vazia seria desligado pelo operador em uma semana — junto com o sinal
    // que ele existe para dar.
    //
    // Consequência a saber ao exercitar à mão: o `curl` contra fila vazia NÃO
    // distingue `[]` de `null`, então ele não responde qual forma o PostgREST
    // usa. Quem responde isso é a primeira varredura com linha devida de verdade.
    return { ids: [], descartados: data === null || data === undefined ? 0 : 1 };
  }
  const ids: string[] = [];
  let descartados = 0;
  for (const item of data) {
    // Exige FORMA DE UUID, não "primeira string": um objeto de várias chaves
    // (uma forma que ninguém previu) entregaria a primeira string qualquer —
    // um timestamp, um status — e o claim seria chamado com lixo, gastando ida
    // ao banco e devolvendo zero linhas, que é indistinguível de "não era
    // reivindicável".
    if (typeof item === "string") {
      if (UUID_RE.test(item.trim())) ids.push(item.trim());
      else descartados++;
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const found = [record.id, ...Object.values(record)].find(
        (value) => typeof value === "string" && UUID_RE.test(value.trim()),
      );
      if (typeof found === "string") ids.push(found.trim());
      else descartados++;
      continue;
    }
    descartados++;
  }
  return { ids, descartados };
}
