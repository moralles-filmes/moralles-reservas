// scripts/datafy-probe/probe.mjs
// Probe da Fase 0 do parceiro Datafy (plano 2026-10-13, Task 0). NÃO é código de
// produção e não é importado pelo app. Leia o README ao lado antes de rodar.
//
// Uso (Node >= 20.6 por causa do --env-file; o resto roda em Node >= 18):
//   node --env-file=.env.local scripts/datafy-probe/probe.mjs <comando> [args] [flags]
//
// O token de conta (sk_acct_) alcança TODOS os canais da conta da plataforma,
// inclusive o canal de produção da Moralles. Dois riscos desenham este arquivo:
//  1. Vazamento no stdout, que o dono cola no chat. Toda saída passa por shape():
//     booleano e número curto aparecem com valor; string vira `string`,
//     `string<empty>`, `string<PREFIXO>`, `string<iso8601-…>`, `url<host>`,
//     `enum<valor>` (só chaves de vocabulário e só palavra que passa em
//     isEnumWord) ou `text<…>` (só texto de erro de resposta HTTP >= 400 que
//     passa em isSafeErrorText). Exceções deliberadas: id de canal (só serve com
//     o token de conta), o `name` de canal criado por este probe e o fingerprint
//     truncado de ids da Meta (ver fp()).
//  2. Chamada destrutiva no canal de produção. Todo comando que altera canal
//     existente consulta o canal antes e só segue, sem override, se ele foi
//     criado por este probe (name `probe-fase0-…`) e não está assinado (guardaCanal()).
//
// Erro de transporte é impresso só como `error.name` (+ `cause.code`): a mensagem
// de erro do fetch do Node pode embutir a URL chamada.
import http from "node:http";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = "https://cloud.datafyapi.com.br";
const TIMEOUT_MS = 15_000;
const PORT = 5599;
const MAX_DEPTH = 5;
const MAX_KEYS = 50;

// Prefixos mostrados na forma (`string<sk_live_>`) para saber QUE tipo de valor veio.
const KNOWN_PREFIXES = ["sk_acct_", "sk_live_", "whsec_", "ct_", "wamid.", "EAA", "eyJ"];
// Segredo no começo ou depois de separador (`invalid_token:sk_acct_…`, `expired:ct_…`, JWT).
const SECRET_AT_BOUNDARY = /(?:^|[^A-Za-z0-9])(?:sk_|whsec_|ct_|EAA|eyJ)/;
const looksSecret = (value) => SECRET_AT_BOUNDARY.test(value);
const digitCount = (value) => (value.match(/\d/g) ?? []).length;

// Chaves cujo valor é vocabulário fechado e é o que se mede: `source`/`event`/`type`
// do postMessage, `subscription` da conta, `status`. `code` só entra em resposta
// HTTP de erro (distingue os dois 409 do connect-link); no postMessage `code` e
// `state` são segredo de OAuth da Meta e ficam sempre mascarados.
const ENUM_KEYS_BASE = new Set(["source", "event", "type", "status", "subscription", "error", "events", "coexistence"]);
const ENUM_KEYS_HTTP = new Set([...ENUM_KEYS_BASE, "code"]);
const TEXT_KEYS = new Set(["message", "error", "detail"]);
const CTX_POSTMESSAGE = { enumKeys: ENUM_KEYS_BASE, errorText: false };
// `code` só vira enum em erro: num 2xx ele pode ser código de pareamento ou OTP.
const CTX_HTTP_OK = { enumKeys: ENUM_KEYS_BASE, errorText: false };
const CTX_HTTP_ERROR = { enumKeys: ENUM_KEYS_HTTP, errorText: true };
const ctxForStatus = (status) => (status >= 400 ? CTX_HTTP_ERROR : CTX_HTTP_OK);

// Palavra de vocabulário: snake/kebab minúsculo, MAIÚSCULO ou camelCase legível,
// com no máximo 2 dígitos, segmentos curtos, um só tipo de separador (barra
// `joao.silva:exemplo`) e sem 6+ consoantes seguidas (palavra tem vogal; token
// aleatório só de minúsculas, não). Dígito só no fim do segmento (`v3`, `http2`),
// e nada com forma de código de pareamento (`ABCD-EFGH`). Token aleatório base62
// não passa. Resíduo conhecido: palavra minúscula pronunciável inventada passa.
const ENUM_WORD = /^(?:[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*|[A-Z][A-Z0-9]*(?:[_.:-][A-Z0-9]+)*|[a-z]{2,}(?:[A-Z][a-z]{2,})+)$/;
const CONSONANT_RUN = /[b-df-hj-np-tv-xz]{6,}/i;
const PAIRING_CODE = /\b[A-Z0-9]{4}[- ][A-Z0-9]{4}\b/i;
export const isEnumWord = (v) =>
  v.length <= 40 &&
  ENUM_WORD.test(v) &&
  digitCount(v) <= 2 &&
  v.split(/[_.:-]/).every((s) => s.length <= 16 && /^[A-Za-z]*\d{0,2}$/.test(s)) &&
  new Set(v.match(/[_.:-]/g) ?? []).size <= 1 &&
  !CONSONANT_RUN.test(v) &&
  !PAIRING_CODE.test(v) &&
  !SECRET_AT_BOUNDARY.test(v);

// Texto de erro da Datafy é cópia fixa de produto, não dado; é o que deixa o passo
// 11 dizer QUAL 409 veio. Só em resposta HTTP >= 400, nunca em 2xx nem postMessage.
// Além das regras do enunciado, cada segmento precisa parecer palavra: até 20
// letras, no máximo uma virada minúscula→maiúscula, sem 6+ consoantes seguidas,
// dígito só no fim e, com 6+ caracteres, sem misturar letra e dígito. E o texto
// não pode ter domínio (`x.com`), código de pareamento
// nem nome próprio: palavra Capitalizada fora do início da frase (fora de uma
// lista curta de produtos) é o que uma cópia interpolada com nome de pessoa ou
// de empresa ("…vinculado à conta de Joao Silva") produz.
const caseTransitions = (s) => (s.match(/[a-z][A-Z]/g) ?? []).length;
const PRODUCT_WORDS = new Set(["WhatsApp", "Meta", "Datafy", "Facebook", "Business", "Cloud", "Coexistence", "Embedded", "Signup", "Instagram"]);
const isWordLikeSegment = (seg) =>
  seg.length <= 20 &&
  caseTransitions(seg) < 2 &&
  !CONSONANT_RUN.test(seg) &&
  /^\p{L}*\d{0,2}$/u.test(seg) &&
  !(seg.length >= 6 && /\d/.test(seg) && /\p{L}/u.test(seg));
const hasProperNoun = (v) =>
  v.split(/[.!?:;]\s+/).some((sentence) =>
    sentence
      .split(/\s+/)
      .slice(1)
      .some((word) => /^\p{Lu}\p{Ll}+$/u.test(word.replace(/[^\p{L}]/gu, "")) && !PRODUCT_WORDS.has(word.replace(/[^\p{L}]/gu, ""))),
  );
export const isSafeErrorText = (v) =>
  v.length > 0 &&
  v.length <= 120 &&
  digitCount(v) <= 2 &&
  !v.includes("@") &&
  !v.includes("://") &&
  !SECRET_AT_BOUNDARY.test(v) &&
  !/\b(?:bearer|basic)\b/i.test(v) &&
  !/[\p{L}\d-]+\.\p{L}{2,}/u.test(v) &&
  !PAIRING_CODE.test(v) &&
  !hasProperNoun(v) &&
  v.split(/[^\p{L}\p{N}]+/u).every(isWordLikeSegment);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RESERVED_IDS = new Set(["global-webhook"]);
// `create` usa Date.now() (13 dígitos começando em 16–19 até 2033). Telefone BR de
// 13 dígitos começa com 55, então `probe-fase0-<telefone>` não passa por probe.
const PROBE_NAME = /^probe-fase0-1[6-9]\d{11}$/;
const KEY_FORMAT = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
const ERROR_CODE = /^[A-Z0-9_]{2,40}$/;
const OVERRIDE_FLAG = "--canal-fora-do-probe-ok";
const ALLOWED_FLAGS = new Set(["--autorizo-cobranca", "--autorizo-cancelamento", OVERRIDE_FLAG]);
const COMMANDS = new Set([
  "global", "list", "list-ids", "get", "link", "serve", "create", "dup",
  "webhook", "pause", "resume", "subscribe", "cancel", "delete",
]);
const EXIT = { USAGE: 1, TOKEN: 2, NOT_AUTHORIZED: 3, REFUSED: 4, TRANSPORT: 5, UNEXPECTED: 9 };

class Abort extends Error {
  constructor(exitCode) {
    super("abort");
    this.exitCode = exitCode;
  }
}

const asObject = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);
const is2xx = (status) => status >= 200 && status < 300;

function isoKind(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  const m = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  if (!m) return null;
  if (!m[1]) return "iso8601-local";
  return m[1].toUpperCase() === "Z" ? "iso8601-Z" : "iso8601-offset";
}

// Rótulo de host longo, com muitos dígitos ou com cara de token vira `<rótulo>`.
const isSafeHostLabel = (label) =>
  label.length <= 24 && digitCount(label) < 6 && !SECRET_AT_BOUNDARY.test(label) && !/(?:^|[-_])(?:ct|sk|whsec)[-_]/i.test(label);

const maskedHost = (url) =>
  url.hostname
    .split(".")
    .map((label) => (isSafeHostLabel(label) ? label : "<rótulo>"))
    .join(".") + (url.port ? `:${url.port}` : "");

export function shapeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "url<inválida>";
  }
  return `url<${maskedHost(url)}>`;
}

function shapeString(value, ctx, key) {
  if (value.length === 0) return "string<empty>";
  const prefix = KNOWN_PREFIXES.find((p) => value.startsWith(p));
  if (prefix) return `string<${prefix}>`;
  if (/^https?:\/\//i.test(value)) return shapeUrl(value);
  const iso = isoKind(value);
  if (iso) return `string<${iso}>`;
  if (key !== undefined && ctx.enumKeys.has(key) && isEnumWord(value)) return `enum<${value}>`;
  if (key !== undefined && ctx.errorText && TEXT_KEYS.has(key) && isSafeErrorText(value)) return `text<${value}>`;
  return "string";
}

// Chave com dígitos de telefone/id, `@`, prefixo conhecido ou formato fora de
// identificador é mascarada: objeto indexado por dado vaza pela CHAVE.
// Mais estrito que a revisão pediu: 6+ dígitos (não 8) e 4+ viradas de caixa
// (`aBcDeFgH…`, chave opaca) também mascaram.
const isSafeKey = (key) =>
  digitCount(key) < 6 &&
  caseTransitions(key) < 4 &&
  !key.includes("@") &&
  !KNOWN_PREFIXES.some((p) => key.startsWith(p)) &&
  !looksSecret(key) &&
  KEY_FORMAT.test(key);

export function shape(value, ctx = CTX_POSTMESSAGE, depth = 0, key = undefined) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Número com 6+ dígitos na parte inteira pode ser telefone, id da Meta ou o
    // PIN de 6 dígitos da verificação em duas etapas do WhatsApp: sai só a
    // contagem de dígitos (que basta para ver se é epoch s/ms). `expires_in: 86400` passa.
    if (Number.isFinite(value) && Math.abs(value) >= 1e5) {
      const digits = Math.floor(Math.log10(Math.abs(value))) + 1;
      return Number.isInteger(value) ? `number<int:${digits}d>` : `number<dec:${digits}d>`;
    }
    return value;
  }
  if (typeof value === "string") return shapeString(value, ctx, key);
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (depth >= MAX_DEPTH) return "array<depth>";
    if (key !== undefined && ctx.enumKeys.has(key)) {
      const items = value.slice(0, 10).map((v) => shape(v, ctx, depth + 1, key));
      return value.length > 10 ? [...items, `len:${value.length}`] : items;
    }
    return [shape(value[0], ctx, depth + 1), `len:${value.length}`];
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "object<depth>";
    const keys = Object.keys(value).sort();
    const entries = keys
      .slice(0, MAX_KEYS)
      .map((k, i) => [isSafeKey(k) ? k : `<chave-mascarada:${i}>`, shape(value[k], ctx, depth + 1, k)]);
    if (keys.length > MAX_KEYS) entries.push(["<…>", `+${keys.length - MAX_KEYS} chaves`]);
    return Object.fromEntries(entries);
  }
  return typeof value;
}

const sha12 = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

// Fingerprint impresso DE PROPÓSITO: 12 primeiros hex do SHA-256 de
// phone_number_id, waba_id e business_id. Esses ids da Meta não são credencial
// (usá-los exige token), mas identificam o número e a WABA do cliente, e o
// relatório colado no chat só precisa saber se MUDARAM ao mover o número entre
// canais. SHA-256 puro, sem chave, para dar para conferir contra o valor gravado
// no banco sem o token: left(encode(sha256(convert_to(<id>, 'UTF8')), 'hex'), 12).
// Inteiro seguro vira texto antes do hash, então "123" e 123 dão o mesmo fingerprint.
// NÃO é garantia de sigilo: id numérico tem pouca entropia e o hash truncado é
// atacável por força bruta. Por isso `phone` (telefone, entropia mínima) nunca
// ganha fingerprint, e token/webhook_secret também não.
export function fp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return sha12(value);
  if (typeof value === "number" && Number.isInteger(value)) {
    return Number.isSafeInteger(value) ? sha12(String(value)) : "<inteiro-impreciso>";
  }
  return "<não-string>";
}

// Mesma régua do fp(): presença do número sem afirmar nada que não se leu.
export function numberPresence(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return true;
  if (typeof value === "number" && Number.isInteger(value)) return Number.isSafeInteger(value) ? true : "<inteiro-impreciso>";
  return "<não-string>";
}

// O envelope real pode divergir do OpenAPI (é isso que o probe mede), então a
// leitura é tolerante: prefere o objeto que tem campo de canal (raiz, `data`,
// `channel`); sem nenhum, cai no primeiro objeto com `id`.
const CHANNEL_FIELDS = ["subscribed", "phone_number_id", "waba_id", "paused", "on_trial"];
const hasChannelFields = (c) => CHANNEL_FIELDS.some((f) => f in c);

// Dois objetos com cara de canal (raiz e `data`/`channel`) na mesma resposta: a
// trava não adivinha qual vale e recusa.
export function isAmbiguousChannelEnvelope(body) {
  const root = asObject(body);
  if (!root) return false;
  return [root, asObject(root.data), asObject(root.channel)].filter((c) => c && hasChannelFields(c)).length > 1;
}

export function pickChannel(body) {
  const root = asObject(body);
  if (!root) return null;
  const candidates = [root, asObject(root.data), asObject(root.channel)].filter(Boolean);
  return (
    candidates.find(hasChannelFields) ??
    candidates.find((c) => "id" in c) ??
    root
  );
}

export function findChannelsArray(body) {
  if (Array.isArray(body)) return body;
  const root = asObject(body);
  if (!root) return null;
  if (Array.isArray(root.channels)) return root.channels;
  if (Array.isArray(root.data)) return root.data;
  const data = asObject(root.data);
  return data && Array.isArray(data.channels) ? data.channels : null;
}

// `wamid.` e outros prefixos conhecidos nunca são id de canal (o wamid é base64
// que carrega o telefone); só dígitos (8+) parece telefone ou id da Meta.
const isPrintableId = (v) =>
  typeof v === "string" &&
  ID_PATTERN.test(v) &&
  !/^\d{8,}$/.test(v) &&
  !looksSecret(v) &&
  !KNOWN_PREFIXES.some((p) => v.startsWith(p)) &&
  !RESERVED_IDS.has(v);

function printableId(value) {
  if (value === undefined) return "absent";
  return isPrintableId(value) ? value : shape(value, CTX_HTTP_OK);
}

function pickId(body) {
  const ch = pickChannel(body);
  return ch && isPrintableId(ch.id) ? ch.id : null;
}

function rawFlag(obj, key) {
  if (!(key in obj)) return "absent";
  return typeof obj[key] === "boolean" ? obj[key] : shape(obj[key], CTX_HTTP_OK);
}

// O ORIGINAL foi nomeado à mão e o name pode conter o telefone: só o name de canal
// criado por este probe sai cru. O ORIGINAL se reconhece por subscribed,
// has_number e fp_phone_number_id.
export function summarizeListItem(item) {
  const obj = asObject(item);
  if (!obj) return { item: shape(item, CTX_HTTP_OK) };
  const name = obj.name;
  const nameOut = typeof name === "string" && PROBE_NAME.test(name)
    ? { name }
    : { name: shape(name, CTX_HTTP_OK), name_len: typeof name === "string" ? name.length : "absent" };
  return {
    id: printableId(obj.id),
    ...nameOut,
    subscribed: rawFlag(obj, "subscribed"),
    on_trial: rawFlag(obj, "on_trial"),
    paused: rawFlag(obj, "paused"),
    has_number: numberPresence(obj.phone_number_id),
    fp_phone_number_id: fp(obj.phone_number_id),
  };
}

// Forma do que a janela da Datafy mandou por postMessage. A página local envia o
// `data` cru ao servidor local (só memória, nunca impresso); a forma é calculada
// aqui, numa régua só. `data` em string JSON é aberto: o Embedded Signup da Meta
// posta JSON serializado, e a Datafy pode fazer o mesmo. `from_popup` diz se veio
// da janela de conexão (extensões do navegador também postam na página).
export function describePostMessage(entry) {
  const obj = asObject(entry);
  if (!obj) return { origin: "ilegível", from_popup: "ilegível", data_kind: "ilegível", shape: "<relatório-inválido>" };
  const origin = printableOrigin(obj.origin);
  const fromPopup = typeof obj.from_popup === "boolean" ? obj.from_popup : "ilegível";
  if (obj.serializable === false) return { origin, from_popup: fromPopup, data_kind: "não-serializável", shape: "<não-serializável>" };
  let data = obj.data;
  let dataKind = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (parsed !== null && typeof parsed === "object") {
        data = parsed;
        dataKind = "json-string";
      }
    } catch {
      // string comum, fica como está
    }
  }
  return { origin, from_popup: fromPopup, data_kind: dataKind, shape: shape(data, CTX_POSTMESSAGE) };
}

function printableOrigin(value) {
  if (typeof value !== "string") return shape(value, CTX_POSTMESSAGE);
  if (value === "null") return "null";
  try {
    const url = new URL(value);
    // Origem http(s) sai como origem, mas com a mesma máscara de rótulo do shapeUrl.
    if (url.origin === value) return `${url.protocol}//${maskedHost(url)}`;
    // Extensão do navegador (chrome-extension://<id>): só o esquema.
    if (!/^https?:$/.test(url.protocol) && /^[a-z][a-z0-9+.-]{0,30}:$/.test(url.protocol)) return `origin<${url.protocol.slice(0, -1)}>`;
  } catch {
    // não é origem
  }
  return shape(value, CTX_POSTMESSAGE);
}

// Presença, quantidade e host (mascarado) do primeiro webhook global, em qualquer
// envelope razoável: objeto, lista na raiz, lista ou objeto em `data`.
export function globalWebhookSummary(body) {
  const ILEGIVEL = { presence: "ilegível", count: null, host: null };
  const summarize = (v) => {
    if (v === null || v === undefined) return { presence: "ausente", count: 0, host: null };
    const list = Array.isArray(v) ? v : [v];
    if (list.length === 0) return { presence: "ausente", count: 0, host: null };
    const hook = asObject(list[0]);
    if (!hook) return { ...ILEGIVEL, count: list.length };
    return { presence: "presente", count: list.length, host: typeof hook.url === "string" ? shapeUrl(hook.url) : null };
  };
  if (Array.isArray(body)) return summarize(body);
  const root = asObject(body);
  if (!root) return ILEGIVEL;
  for (const holder of [root, asObject(root.data)]) {
    if (!holder) continue;
    for (const key of ["webhook", "global_webhook", "globalWebhook", "webhooks"]) {
      if (key in holder) return summarize(holder[key]);
    }
    if ("url" in holder) return summarize(holder);
  }
  if (Array.isArray(root.data)) return summarize(root.data);
  if ("data" in root && root.data === null) return summarize(null);
  return ILEGIVEL;
}

function errorName(error) {
  return error instanceof Error ? error.name : typeof error;
}

function causeCode(error) {
  const code = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause.code : undefined;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
}

async function call(token, method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  const media = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(media) ? media : "outro";
  if (text.length === 0) return { status: response.status, kind: "empty", body: null, contentType };
  try {
    return { status: response.status, kind: "json", body: JSON.parse(text), contentType };
  } catch {
    return { status: response.status, kind: "non-json", body: null, contentType };
  }
}

function printTransportError(label, error) {
  const out = { label, status: null, error: errorName(error) };
  const code = causeCode(error);
  if (code) out.cause_code = code;
  console.log(JSON.stringify(out, null, 2));
}

async function callOrAbort(token, label, method, path, body) {
  try {
    return await call(token, method, path, body);
  } catch (error) {
    printTransportError(label, error);
    throw new Abort(EXIT.TRANSPORT);
  }
}

function bodyShape(result) {
  if (result.kind === "empty") return "<vazio>";
  if (result.kind === "non-json") return "<não-json>";
  return shape(result.body, ctxForStatus(result.status));
}

function report(label, result, extra = {}) {
  const out = { label, status: result.status, shape: bodyShape(result), ...extra };
  if (result.kind === "non-json") out.content_type = result.contentType;
  console.log(JSON.stringify(out, null, 2));
}

// TOKEN_CONTA_DATAFY (o nome do .env.local) vence: o --env-file NÃO sobrescreve
// variável que já existe no shell, então uma DATAFY_ACCOUNT_TOKEN velha ganharia.
function readToken() {
  const fromFile = process.env.TOKEN_CONTA_DATAFY ?? "";
  const fromShell = process.env.DATAFY_ACCOUNT_TOKEN ?? "";
  if (fromFile && fromShell) console.error("Aviso: TOKEN_CONTA_DATAFY e DATAFY_ACCOUNT_TOKEN estão definidas; usando TOKEN_CONTA_DATAFY.");
  const token = (fromFile || fromShell).trim();
  if (!token.startsWith("sk_acct_")) {
    console.error(
      "Token de conta ausente ou fora do formato sk_acct_. Defina TOKEN_CONTA_DATAFY (ex.: node " +
        "--env-file=.env.local ...) ou DATAFY_ACCOUNT_TOKEN. O valor nunca é exibido.",
    );
    throw new Abort(EXIT.TOKEN);
  }
  if (/\s/.test(token)) {
    console.error("O token de conta contém espaço ou quebra de linha no meio. Confira a linha no .env.local.");
    throw new Abort(EXIT.TOKEN);
  }
  return token;
}

function requireId(value) {
  if (typeof value !== "string" || value.length === 0) {
    console.error("Falta o <id> do canal.");
    throw new Abort(EXIT.USAGE);
  }
  if (looksSecret(value)) {
    console.error("O argumento parece um token, não um id de canal. Nada foi enviado (o valor não é exibido).");
    throw new Abort(EXIT.USAGE);
  }
  if (!isPrintableId(value)) {
    console.error("Id de canal fora do formato esperado (letras, números, _ . : -; até 128; não só dígitos). O valor não é exibido.");
    throw new Abort(EXIT.USAGE);
  }
  return value;
}

function requireHttpsUrl(value) {
  let url = null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") {
    console.error("Falta a URL do webhook, ou ela não é https. O valor não é exibido.");
    throw new Abort(EXIT.USAGE);
  }
  return url.href;
}

function requireFlag(flags, flag, message) {
  if (!flags.has(flag)) {
    console.error(message);
    throw new Abort(EXIT.NOT_AUTHORIZED);
  }
}

const channelPath = (id) => `/channels/whatsapp/${encodeURIComponent(id)}`;

// Trava dos comandos que alteram canal existente. Lista POSITIVA: sem override,
// só segue canal criado por este probe (name `probe-fase0-<n>`) e com
// `subscribed === false`. Não depende do que `subscribed` passa a significar
// depois de desconectar o número. Fail-closed: GET que falha, campo ilegível ou
// canal fora da regra recusa (saída 4).
// `requireNoNumber` (só o delete) exige também canal sem número e sem waba_id: não
// se mediu se apagar canal com número descadastra o número ou tira o app da WABA,
// o que cortaria o ORIGINAL logo depois de religado na mesma WABA.
async function guardaCanal(token, id, flags, { requireNoNumber = false } = {}) {
  const r = await callOrAbort(token, "trava", "GET", channelPath(id));
  if (!is2xx(r.status)) {
    console.log(JSON.stringify({ label: "trava", status: r.status }));
    console.error(
      `Recusado: não consegui consultar o canal antes de alterá-lo (HTTP ${r.status}). ` +
        "Sem a consulta, a trava não sabe se é um canal de produção.",
    );
    throw new Abort(EXIT.REFUSED);
  }
  const ch = r.kind === "json" ? pickChannel(r.body) : null;
  const subscribed = ch ? ch.subscribed : undefined;
  const nameIsProbe = Boolean(ch) && typeof ch.name === "string" && PROBE_NAME.test(ch.name);
  const hasNumber = ch ? numberPresence(ch.phone_number_id) : "ilegível";
  const hasWaba = ch ? numberPresence(ch.waba_id) : "ilegível";
  const ambiguous = r.kind === "json" && isAmbiguousChannelEnvelope(r.body);
  console.log(JSON.stringify({
    label: "trava",
    status: r.status,
    name_do_probe: nameIsProbe,
    subscribed: typeof subscribed === "boolean" ? subscribed : "ilegível",
    has_number: hasNumber,
    has_waba: hasWaba,
    envelope_ambiguo: ambiguous,
  }));
  const numberFree = hasNumber === false && hasWaba === false;
  if (!ambiguous && nameIsProbe && subscribed === false && (!requireNoNumber || numberFree)) return;
  const reasons = [];
  if (ambiguous) reasons.push("a resposta traz dois objetos com cara de canal e a trava não sabe qual vale");
  if (!nameIsProbe) reasons.push("o name não é probe-fase0-<número> (pode ser o canal original da Moralles)");
  if (subscribed === true) reasons.push("o canal está ASSINADO");
  else if (subscribed !== false) reasons.push("o campo subscribed está ilegível");
  if (requireNoNumber && hasNumber !== false) {
    reasons.push("o canal ainda tem número (desconecte no painel e confira com get antes de apagar)");
  }
  if (requireNoNumber && hasWaba !== false) {
    reasons.push("o canal ainda tem waba_id (apagar pode mexer na WABA do ORIGINAL)");
  }
  if (flags.has(OVERRIDE_FLAG)) {
    console.error(`Aviso: ${reasons.join("; ")}. Seguindo por causa de ${OVERRIDE_FLAG}.`);
    return;
  }
  console.error(
    `Recusado: a trava só altera canal criado por este probe e não assinado${requireNoNumber ? ", e só apaga canal sem número e sem WABA" : ""}; ` +
      `aqui ${reasons.join("; ")}. ` +
      `Se for mesmo para alterá-lo, rode de novo com ${OVERRIDE_FLAG}.`,
  );
  throw new Abort(EXIT.REFUSED);
}

// Página da medição do postMessage. O window.open é SÍNCRONO no clique (fora do
// gesto do usuário o navegador bloqueia o popup); o link só chega depois e vai
// direto para w.location.href, nunca para a tela nem para o terminal.
// Referrer-Policy no-referrer imita o index.html do app, para medir o que o
// portal de verdade vai mandar.
export function buildPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Probe Datafy</title>
<style>
body { font: 15px/1.5 system-ui, sans-serif; margin: 16px; max-width: 760px; }
button { font-size: 16px; padding: 10px 18px; }
#o div { font-family: ui-monospace, Consolas, monospace; white-space: pre-wrap; border-bottom: 1px solid #ddd; padding: 6px 0; }
</style>
</head>
<body>
<h1>Probe Datafy: janela de conexão</h1>
<p>Clique em "Abrir conexão", conclua o Embedded Signup na janela que abrir e volte aqui. Esta página mostra só a forma das mensagens recebidas; o link de conexão nunca aparece.</p>
<button id="b" type="button">Abrir conexão</button>
<div id="o"></div>
<script>
(function () {
  var out = document.getElementById("o");
  var received = 0;
  var fromPopupCount = 0;
  var current = null;
  var poll = null;
  function log(text) {
    var d = document.createElement("div");
    d.textContent = new Date().toLocaleTimeString() + "  " + text;
    out.appendChild(d);
  }
  function post(path, payload) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  }
  window.addEventListener("message", function (e) {
    // Da janela de conexão ou de um frame dentro dela. .top de outra origem é
    // permitido, mas o try/catch protege de qualquer fonte exótica.
    var fromPopup = false;
    if (current !== null && e.source) {
      try { fromPopup = e.source === current || e.source.top === current; } catch (err) { fromPopup = e.source === current; }
    }
    received += 1;
    if (fromPopup) fromPopupCount += 1;
    var payload;
    try {
      payload = { origin: e.origin, from_popup: fromPopup, serializable: true, data: JSON.parse(JSON.stringify(e.data === undefined ? null : e.data)) };
    } catch (err) {
      payload = { origin: e.origin, from_popup: fromPopup, serializable: false };
    }
    post("/report", payload)
      .then(function (r) { return r.json(); })
      .then(function (j) { log("postMessage " + JSON.stringify(j)); })
      .catch(function () { log("postMessage recebido, mas o relatório ao servidor local falhou."); });
  });
  function watch(w) {
    if (poll) clearInterval(poll);
    var start = Date.now();
    var before = received;
    var beforePopup = fromPopupCount;
    poll = setInterval(function () {
      if (!w.closed) return;
      clearInterval(poll);
      poll = null;
      var info = {
        after_s: Math.round((Date.now() - start) / 1000),
        postmessages_since_open: received - before,
        popup_postmessages_since_open: fromPopupCount - beforePopup
      };
      log("Janela detectada como fechada " + JSON.stringify(info) + ". Se ela ainda estiver visível na tela, o navegador cortou o vínculo com esta página (COOP): anote isso.");
      post("/closed", info).catch(function () {});
    }, 1000);
  }
  document.getElementById("b").addEventListener("click", function () {
    var w = window.open("about:blank", "datafy-conexao", "width=600,height=760");
    if (!w) { log("Popup bloqueado pelo navegador. Libere popups para esta página e tente de novo."); return; }
    current = w;
    log("Janela aberta; pedindo o link ao servidor local.");
    fetch("/link", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || typeof j.url !== "string") {
          log("Link não gerado: " + JSON.stringify({ status: j ? j.status : null, error: j ? j.error : null }));
          w.close();
          return;
        }
        w.location.href = j.url;
        log("Janela indo para a Datafy. Acompanhe aqui e no terminal.");
        watch(w);
      })
      .catch(function () { log("Falha ao pedir o link ao servidor local."); w.close(); });
  });
  log("Página pronta. Clique em Abrir conexão.");
})();
</script>
</body>
</html>`;
}

// CSP da página: só o script e o estilo inline dela, fetch só para a própria
// origem, e ninguém a emoldura.
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJson(text) {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function serve(token, id) {
  const page = buildPage();
  // Host e Origin conferidos: outra aba (ou DNS rebinding) não pede link nem
  // injeta relatório neste servidor.
  const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  const origins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

  async function handle(req, res) {
    if (!hosts.has(req.headers.host ?? "")) {
      res.writeHead(421);
      res.end();
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": PAGE_CSP,
      });
      res.end(page);
      return;
    }
    if (req.method !== "POST" || !origins.has(req.headers.origin ?? "")) {
      res.writeHead(req.method === "POST" ? 403 : 404);
      res.end();
      return;
    }
    if (path === "/link") {
      let r;
      try {
        r = await call(token, "POST", `${channelPath(id)}/connect-link`);
      } catch (error) {
        printTransportError("connect-link", error);
        sendJson(res, 502, { url: null, status: null, error: errorName(error) });
        return;
      }
      report("connect-link", r);
      const root = r.kind === "json" ? asObject(r.body) : null;
      const raw = root ? (root.url ?? asObject(root.data)?.url) : undefined;
      // Único destino do link: a resposta para a página, que o põe na janela.
      sendJson(res, 200, { url: typeof raw === "string" && /^https:\/\//i.test(raw) ? raw : null, status: r.status });
      return;
    }
    if (path === "/report") {
      const entry = describePostMessage(parseJson(await readBody(req, 256 * 1024)));
      console.log(`POSTMESSAGE ${JSON.stringify(entry)}`);
      sendJson(res, 200, entry);
      return;
    }
    if (path === "/closed") {
      const info = asObject(parseJson(await readBody(req, 4 * 1024)));
      const num = (v) => (typeof v === "number" && Number.isSafeInteger(Math.round(v)) ? Math.round(v) : "ilegível");
      console.log(`JANELA_FECHADA ${JSON.stringify({
        after_s: num(info?.after_s),
        postmessages_since_open: num(info?.postmessages_since_open),
        popup_postmessages_since_open: num(info?.popup_postmessages_since_open),
      })}`);
      sendJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  const handler = (req, res) => {
    handle(req, res).catch((error) => {
      console.log(JSON.stringify({ label: "serve", error: errorName(error) }));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const errorCode = (error) => (typeof error.code === "string" && ERROR_CODE.test(error.code) ? error.code : null);
  const v4 = http.createServer(handler);
  v4.on("error", (error) => {
    console.error(JSON.stringify({ label: "serve", error: errorName(error), code: errorCode(error) }));
    process.exitCode = EXIT.TRANSPORT;
  });
  v4.listen(PORT, "127.0.0.1", () => {
    console.log("Servidor local pronto. Abra no navegador:");
    console.log(`  http://localhost:${PORT}   (passo 9)`);
    console.log(`  http://127.0.0.1:${PORT}   (passo 15)`);
    console.log("O que se mede é se o postMessage chega a uma página local, e em qual dos dois endereços.");
    console.log("Linhas POSTMESSAGE e JANELA_FECHADA aparecem aqui. Ctrl+C encerra.");
    // Segunda escuta em ::1: no Windows, "localhost" pode resolver para IPv6.
    const v6 = http.createServer(handler);
    v6.on("error", () => console.log("(Sem escuta em [::1]; se localhost não abrir, use 127.0.0.1 e anote.)"));
    v6.listen(PORT, "::1");
  });
}

const USAGE = `Uso: node --env-file=.env.local scripts/datafy-probe/probe.mjs <comando> [args] [flags]
Token: TOKEN_CONTA_DATAFY (vence) ou DATAFY_ACCOUNT_TOKEN, formato sk_acct_. Saída: só forma, nunca valor sensível.

Leitura (não altera nada):
  global                     webhook global da conta (recebe eventos de TODOS os canais)
  list                       forma da listagem de canais
  list-ids                   uma linha por canal: id, name (só o do probe), subscribed, on_trial, paused, has_number, fp_phone_number_id
  get <id>                   forma do canal + fingerprints (phone_number_id, waba_id, business_id) + webhook_count
  link <id>                  gera link de conexão (só a forma; o link nunca é impresso)
  serve <id>                 página local na porta ${PORT} que abre a janela de conexão e mede o postMessage

Criação (canal novo em trial; não toca nos existentes):
  create                     cria canal de teste; imprime CHANNEL_ID e CHANNEL_NAME
  dup <id>                   cria outro canal com o MESMO name do canal <id>; imprime DUPLICATE_ID

Alteração (só seguem, sem ${OVERRIDE_FLAG}, em canal probe-fase0-<número> não assinado):
  webhook <id> <https-url>   cadastra webhook (messages, smb_message_echoes) e lista os webhooks
  pause <id>
  resume <id>
  subscribe <id> --autorizo-cobranca       COBRA NA HORA; repete o subscribe só se o primeiro der 2xx
  cancel <id> --autorizo-cancelamento
  delete <id>                além da regra acima, só apaga canal sem número e sem waba_id

Saída: 0 ok (inclusive HTTP 4xx/5xx medido) | 1 uso | 2 token | 3 falta autorização
       | 4 recusado pela trava | 5 erro de transporte | 9 erro inesperado`;

function printMissingId(label, status, extra) {
  console.log(`${label} ausente ou fora do formato na resposta (ver a forma acima).`);
  if (is2xx(status)) console.log(`O status foi ${status}: o canal pode ter sido criado. Apague-o pelo painel da Datafy ${extra}.`);
}

async function main(argv) {
  const command = argv[0];
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command !== undefined && !COMMANDS.has(command)) {
    console.error(USAGE);
    throw new Abort(EXIT.USAGE);
  }
  const token = readToken();
  if (command === undefined) {
    console.error(USAGE);
    throw new Abort(EXIT.USAGE);
  }
  const rest = argv.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) {
      console.error(`Flag desconhecida. Aceitas: ${[...ALLOWED_FLAGS].join(", ")}.`);
      throw new Abort(EXIT.USAGE);
    }
  }
  const api = (label, method, path, body) => callOrAbort(token, label, method, path, body);

  switch (command) {
    case "global": {
      const r = await api("global", "GET", "/channels/whatsapp/global-webhook");
      const summary = r.kind === "json" ? globalWebhookSummary(r.body) : { presence: "ilegível", count: null, host: null };
      report("global", r, { global_webhook: summary.presence, global_webhook_count: summary.count, global_webhook_host: summary.host });
      return;
    }
    case "list":
      report("list", await api("list", "GET", "/channels/whatsapp"));
      return;
    case "list-ids": {
      const r = await api("list-ids", "GET", "/channels/whatsapp");
      const items = r.kind === "json" ? findChannelsArray(r.body) : null;
      if (!items) {
        report("list-ids", r);
        console.log("Array de canais não encontrado no corpo (ver a forma acima).");
        return;
      }
      console.log(JSON.stringify({ label: "list-ids", status: r.status, count: items.length }));
      for (const item of items) console.log(JSON.stringify(summarizeListItem(item)));
      return;
    }
    case "get": {
      const id = requireId(args[0]);
      const r = await api("get", "GET", channelPath(id));
      const ch = r.kind === "json" ? pickChannel(r.body) : null;
      let webhookCount = "absent";
      if (ch && Array.isArray(ch.webhooks)) webhookCount = ch.webhooks.length;
      else if (ch && "webhooks" in ch) webhookCount = shape(ch.webhooks, CTX_HTTP_OK);
      report("get", r, {
        fingerprints: { phone_number_id: fp(ch?.phone_number_id), waba_id: fp(ch?.waba_id), business_id: fp(ch?.business_id) },
        has_number: numberPresence(ch?.phone_number_id),
        webhook_count: webhookCount,
      });
      return;
    }
    case "create": {
      // O name é nosso e não é sensível; o id do canal só serve com o token de conta.
      const name = `probe-fase0-${Date.now()}`;
      const r = await api("create", "POST", "/channels/whatsapp", { name, description: "Probe da Fase 0. Pode apagar." });
      report("create", r);
      const newId = r.kind === "json" ? pickId(r.body) : null;
      if (newId) console.log(`CHANNEL_ID=${newId}`);
      else printMissingId("CHANNEL_ID", r.status, "procurando o CHANNEL_NAME abaixo");
      console.log(`CHANNEL_NAME=${name}`);
      return;
    }
    case "dup": {
      // Mede se `name` é único na conta (base da reconciliação por nome). Só LÊ o canal alvo.
      const id = requireId(args[0]);
      const g = await api("dup-get", "GET", channelPath(id));
      const ch = g.kind === "json" ? pickChannel(g.body) : null;
      const name = ch ? ch.name : undefined;
      if (!is2xx(g.status) || typeof name !== "string" || name.length === 0) {
        console.log(JSON.stringify({ label: "dup-get", status: g.status, name: shape(name, CTX_HTTP_OK) }));
        console.error("Recusado: não consegui ler um name do canal alvo; não há o que duplicar.");
        throw new Abort(EXIT.REFUSED);
      }
      const r = await api("dup", "POST", "/channels/whatsapp", { name, description: "Probe da Fase 0 (duplicado). Pode apagar." });
      report("dup", r);
      const dupId = r.kind === "json" ? pickId(r.body) : null;
      if (dupId) console.log(`DUPLICATE_ID=${dupId}`);
      else printMissingId("DUPLICATE_ID", r.status, "(mesmo name do canal alvo, descrição \"Probe da Fase 0 (duplicado)\")");
      if (PROBE_NAME.test(name)) console.log(`DUPLICATE_NAME=${name}`);
      return;
    }
    case "webhook": {
      const id = requireId(args[0]);
      const url = requireHttpsUrl(args[1]);
      await guardaCanal(token, id, flags);
      report("webhook-create", await api("webhook-create", "POST", `${channelPath(id)}/webhooks`, {
        url,
        events: ["messages", "smb_message_echoes"],
      }));
      report("webhook-list", await api("webhook-list", "GET", `${channelPath(id)}/webhooks`));
      return;
    }
    case "link": {
      const id = requireId(args[0]);
      report("connect-link", await api("connect-link", "POST", `${channelPath(id)}/connect-link`));
      return;
    }
    case "serve":
      serve(token, requireId(args[0]));
      return;
    case "pause":
    case "resume": {
      const id = requireId(args[0]);
      await guardaCanal(token, id, flags);
      report(command, await api(command, "POST", `${channelPath(id)}/${command}`));
      return;
    }
    case "subscribe": {
      const id = requireId(args[0]);
      requireFlag(flags, "--autorizo-cobranca", "Assinar cobra na hora. Rode de novo com --autorizo-cobranca só se o dono autorizou.");
      await guardaCanal(token, id, flags);
      const first = await api("subscribe", "POST", `${channelPath(id)}/subscribe`);
      report("subscribe", first);
      // Segundo subscribe mede idempotência; só faz sentido se o primeiro passou.
      if (is2xx(first.status)) report("subscribe-again", await api("subscribe-again", "POST", `${channelPath(id)}/subscribe`));
      return;
    }
    case "cancel": {
      const id = requireId(args[0]);
      requireFlag(
        flags,
        "--autorizo-cancelamento",
        "Cancelar mexe na assinatura do canal. Rode de novo com --autorizo-cancelamento só se o dono autorizou " +
          `(canal assinado também exige ${OVERRIDE_FLAG}).`,
      );
      await guardaCanal(token, id, flags);
      report("cancel", await api("cancel", "POST", `${channelPath(id)}/cancel`));
      return;
    }
    case "delete": {
      const id = requireId(args[0]);
      await guardaCanal(token, id, flags, { requireNoNumber: true });
      report("delete", await api("delete", "DELETE", channelPath(id)));
      return;
    }
    default:
      console.error(USAGE);
      throw new Abort(EXIT.USAGE);
  }
}

function isCliEntry() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

// DATAFY_PROBE_IMPORT_ONLY=1 permite importar as funções puras num teste local
// sem rodar comando nenhum. Fora isso, o arquivo sempre executa.
if (process.env.DATAFY_PROBE_IMPORT_ONLY === "1") {
  if (isCliEntry()) console.error("DATAFY_PROBE_IMPORT_ONLY=1 está definida: nenhum comando foi executado. Remova a variável para usar o probe.");
} else {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof Abort) {
      process.exitCode = error.exitCode;
    } else {
      console.error(JSON.stringify({ label: "erro-inesperado", error: errorName(error) }));
      process.exitCode = EXIT.UNEXPECTED;
    }
  }
}
