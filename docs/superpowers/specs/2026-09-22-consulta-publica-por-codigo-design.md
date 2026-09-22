# Consulta pública por código — design

**Data:** 2026-09-22
**Migration:** 109
**Estado:** aprovado, aguardando plano de implementação

---

## 1. O problema

`public.get_reservation_by_code(text, uuid)` carrega **dois defeitos trançados**. Eles não se separam: fechar um pelo caminho óbvio piora o outro.

### Defeito A — funcional, atinge o cliente da loja

A consulta por código do portal público está quebrada. Medido com a anon key real do bundle, que é exatamente o que o visitante usa:

```
POST /rest/v1/rpc/get_reservation_by_code
HTTP 401
{"code":"42501","message":"permission denied for function get_reservation_by_code"}
```

Quebrou em `20260730160000_085_harden_public_function_acl.sql`, que revogou `anon`. São ~54 dias até hoje.

E é **invisível**. `useReservaByCode` faz `if (error) throw error`, mas `ReservaCodeLookup` ([PublicPortal.tsx:813](../../../src/pages/PublicPortal.tsx)) só destrutura `data` e `isLoading` — nunca `isError`. O render em `PublicPortal.tsx:862` é:

```tsx
{searchCode && !isLoading && !reserva && (
  <p className="text-sm text-destructive">Reserva não encontrada. Verifique o código.</p>
)}
```

Então o cliente que digita o código **certo** lê *"Reserva não encontrada. Verifique o código."*. É a classe que o `CLAUDE.md` já nomeia — *"Silenciar erro como 'lista vazia' já mascarou incidente em produção"* — e a mesma que a PR #19 fechou em `Clientes.tsx` dois dias atrás.

### Defeito B — segurança, P1

A função é `SECURITY DEFINER`, `language sql`, **sem `auth.uid()` em lugar nenhum** e sem nenhum helper de membresia, concedida a `authenticated`. Qualquer usuário logado de qualquer organização que possua um `reservation_code` lê `customer_name`, `customer_phone`, `customer_email` e `notes` da reserva de **qualquer** organização.

`p_unit_id` não protege: `reservation_code` carrega índice UNIQUE **global** (`reservations_reservation_code_key`), então o parâmetro só estreita 1 linha para 0 — filtra, nunca autoriza. Com `p_unit_id => null` nem isso.

Classificado **P1, não P0**: exige possuir um código, que são 8 caracteres de um alfabeto de 32 (~1,1e12). O vetor é dirigido — código vazado, colhido, impresso, ou ex-funcionário com conta ainda ativa em alguma org — não enumeração em massa.

### Defeito C — descoberto ao explorar, e some junto

O diálogo público renderiza `<ReservaCard>`, um **componente de painel**. Ele mostra `reserva.customer?.name` completo ([ReservaCard.tsx:51](../../../src/components/reserva/ReservaCard.tsx)), `formatPhone(reserva.customer.phone)` (:126) e `reserva.notes` (:132).

Ou seja: **antes da 085, o portal público exibia nome completo, telefone e a anotação interna do operador** para quem tivesse o código. A 085 quebrou a feature e, sem querer, tapou um vazamento de privacidade que já existia.

Isso elimina "só restaurar o grant de `anon`" como solução. A forma antiga não pode voltar.

---

## 2. Como chegamos aqui

O defeito A nasceu de uma frase errada, repetida quatro vezes:

| origem | o que diz | efeito |
|---|---|---|
| `005_hardening.sql:14` | "RPC controlada para consulta **pública** por código" | `grant ... to anon, authenticated` |
| `013_multi_tenant.sql:581` | "usado pelo **portal público** que conhece a unidade pelo slug" | mantém `anon` |
| `085_harden_public_function_acl.sql:178` | `-- Caller: src/hooks/useReservas.ts (hook do **painel**)` | **`revoke ... from public, anon`** |
| `107_drop_dead_rpc_overloads.sql:6` | "o único call site (src/hooks/useReservas.ts:101)" | repete |
| `df9ee70` (allowlist) | "Busca por código no painel" | repete |

A 085 leu o *hook* e concluiu "painel". O único call site em todo o repositório é `src/pages/PublicPortal.tsx:514` → `ReservaCodeLookup` → `useReservas.ts:97`. Nenhuma Edge Function, nenhuma tool do agente, nenhuma tela de `/g/` ou `/o/`.

A allowlist já foi corrigida em `f22f48a`. As migrations não — migration aplicada não se reescreve.

**A lição que vale além desta frente:** um comentário que nomeia o caller é load-bearing. Foi ele, e não o código, que decidiu revogar o grant.

---

## 3. Decisão

O cliente digita o código e é **levado para a página de acompanhamento que já existe**.

[`AcompanharReserva.tsx`](../../../src/pages/AcompanharReserva.tsx) já é uma página pública completa e privacy-safe: 1º nome, data, hora, pessoas, código, status com copy por estado, polling de 20s visibility-aware, botão "Falar com o restaurante", link para o restaurante. A [migration 055](../../../supabase/migrations/20260607130000_055_public_tracking_rpc.sql) já define o payload público de reserva.

O que falta é só a **chave de busca**: `get_public_tracking` recebe o UUID; o cliente tem o código de 8 caracteres.

Então a frente constrói exatamente isso — um resolvedor de chave — e **dropa** `get_reservation_by_code`, que fica sem callers.

Consequências:

- **O defeito B fecha por remoção, não por guard.** Não dá para vazar por uma função que não existe. Nada a escrever, nada a auditar para sempre, uma entrada a menos na allowlist. Precedente: a 107 dropou overloads mortos.
- **O defeito C fecha junto**, porque o portal para de renderizar `ReservaCard`.
- **Não nasce payload público novo.** Quem devolve dado público continua sendo `get_public_tracking` — um lugar só onde a régua de privacidade precisa ser mantida, em vez de dois que podem divergir.

### Alternativas descartadas

**Devolver o payload público inline no diálogo.** Funciona, mas cria um segundo lugar que precisa continuar privacy-safe para sempre, e o cliente perde polling, copy por status e o botão de WhatsApp — que teriam de ser reescritos no diálogo. Único ganho real: o token não entra na URL/histórico. Não compensa, e o token já entra na URL de todo mundo que recebeu o link pelo WhatsApp.

**Remover o diálogo e apoiar só no link do WhatsApp.** Fecha os três defeitos sem construir nada, mas quem perdeu o link e só tem o código impresso na mão fica sem saída — e é exatamente esse cliente que abre o portal para consultar.

**Manter `get_reservation_by_code` com guard de membresia.** Deixa viva uma função `SECURITY DEFINER` sem caller nenhum, que passa a exigir auditoria permanente para servir um uso de painel que não existe (o painel busca por `search_reservations`, `SECURITY INVOKER`, com RLS aplicando).

---

## 4. Migration 109

Arquivo: `supabase/migrations/20260922150000_109_public_code_lookup.sql`

```sql
create or replace function public.resolve_tracking_token_by_code(
  p_code text, p_unit_id uuid          -- sem DEFAULT: obrigatório
) returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  select r.id
    from reservations r
    join units u on u.id = r.unit_id
   where r.reservation_code = upper(btrim(p_code))
     and r.unit_id = p_unit_id
     and u.is_public = true;
$$;

revoke all on function public.resolve_tracking_token_by_code(text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_tracking_token_by_code(text, uuid)
  to anon, authenticated;

comment on function public.resolve_tracking_token_by_code(text, uuid) is
  'Resolve reservation_code -> reservations.id (token de /acompanhar). Devolve SÓ o token, nunca dado: o payload público é de get_public_tracking. Gateada por units.is_public; p_unit_id é obrigatório e só estreita.';

drop function if exists public.get_reservation_by_code(text, uuid);
```

### Por que `language sql` e não `plpgsql`

A 108 precisou de `plpgsql` porque recusava com `raise ... 42501`: sobre um **agregado**, `count(*)` de conjunto vazio sempre produz linha, então "negar" e "não achar nada" ficariam indistinguíveis se a recusa fosse zero linha.

Aqui o retorno é **uma linha ou nenhuma**. `null` já é a resposta certa para código errado, unidade errada e unidade privada — os três indistinguíveis entre si, sem oráculo de existência. Não há o que `raise` acrescente.

### Por que `p_unit_id` é obrigatório

**Não é ele que autoriza.** Quem autoriza é `u.is_public`. O `p_unit_id` vem do slug da URL e só *estreita*: impede que o portal de uma loja vire oráculo universal onde um código de qualquer tenant resolve.

Isso **não** repete o erro que a 108 corrigiu. Lá o parâmetro do chamador era a única fonte do tenant e podia ser escolhido para afrouxar o guard. Aqui ele só pode tornar a checagem mais estrita — um atacante que informe o `unit_id` certo não ganha nada que não teria com o código sozinho contra aquele portal.

### O gate tem que ser o MESMO de `get_public_tracking`

As duas funções gateiam por `units.is_public = true`. Isso não é coincidência estética: se o resolvedor fosse mais frouxo, o código resolveria um token que a página de acompanhamento depois recusaria, e o cliente cairia em "Acompanhamento indisponível" **depois** de digitar o código certo — um beco sem saída pior que a mensagem de hoje. Afrouxar um dos dois lados sem o outro é regressão.

### Por que só reserva, nunca fila

`waitlist.code` é um inteiro pequeno por unidade ("senha #7"), trivialmente enumerável. Resolvê-lo para um token de acompanhamento seria um buraco de verdade. A copy do diálogo já diz "código de 8 caracteres".

### O que a migration NÃO faz

Não reescreve o cabeçalho errado da 085 — migration aplicada não se reescreve, e como a função é dropada não sobra objeto para `comment on function`. O cabeçalho da 109 carrega a correção do registro histórico.

---

## 5. Frontend

### `ReservaCodeLookup` ([PublicPortal.tsx:809](../../../src/pages/PublicPortal.tsx))

Deixa de ser query e vira **mutation** — é ação de um disparo, e dá `isPending`/`isError`/`data` limpos sem o jogo do `enabled` com `searchCode`.

| resultado | o que o cliente vê |
|---|---|
| uuid | `navigate("/acompanhar/<uuid>")` — a troca de rota desmonta o diálogo, não é preciso fechá-lo à mão |
| `null` | "Reserva não encontrada. Verifique o código." |
| erro | "Não foi possível consultar agora. Tente novamente em instantes." + botão "Tentar de novo" |

**O terceiro ramo é o motivo desta frente existir.** Hoje ele não existe, e foi por isso que 54 dias de 401 passaram como "código errado". A copy precisa dizer *falha*, nunca *não encontrado* — é a distinção inteira.

A mutation fica **inline em `ReservaCodeLookup`**, não num hook em `src/hooks/useReservas.ts`. `AcompanharReserva.tsx` já chama `supabase.rpc` inline pelo mesmo motivo, e foi exatamente um hook público morando no arquivo de hooks de painel que produziu o comentário `(hook do painel)` da 085 e 54 dias de quebra. A superfície pública fica visível na página pública.

### Remoções

| o quê | onde | por quê |
|---|---|---|
| `useReservaByCode` | `src/hooks/useReservas.ts:97` | sem caller |
| `mapRpcRowToReserva` | `src/hooks/useReservas.ts:22` | só usado por ele |
| `ReservationByCodeRow` | `src/hooks/useReservas.ts:7` | idem |
| bloco `mapRpcRowToReserva` | `src/hooks/useReservas.test.ts` | testa código removido |
| `<ReservaCard>` + import | `PublicPortal.tsx:6,869` | componente de painel em página pública |

Depois disso `ReservaCard` volta a ser exclusivo de painel (5 call sites em `/g/` e `/o/`), e **nome completo, telefone e `notes` param de ter caminho para uma página pública**.

---

## 6. Não-objetivos e riscos aceitos

### Rate limit: não vai ser construído

`rate_limit_events` é chaveado por `phone` + `unit_id` (criação de reserva) e não serve para busca por código. Um mecanismo novo seria infra nova para um risco que a conta não sustenta: 8 caracteres × alfabeto de 32 = ~1,1e12, escopado por unidade (não dá para somar tenants). Achar um código válido numa unidade com 10 mil reservas custa ~1e8 tentativas.

### A exposição nova, dita na cara

Hoje o payload público de uma reserva só é alcançável com um UUID (2^122). Depois desta frente, também com o código (~1,1e12), no portal da unidade certa. **É um segredo mais fraco para o mesmo dado.**

É o preço de existir consulta por código em qualquer forma — a alternativa "inline no diálogo" tem exatamente a mesma exposição — e é o que a 005 e a 013 pretendiam desde o início. Fica registrado como risco aceito, não omitido.

### Fora de escopo

- Corrigir os cabeçalhos das migrations 085 e 107 (não se reescreve migration aplicada).
- Corrigir `docs/hotfix-acl/01-INVENTARIO-E-CLASSIFICACAO.md:116` e `02-VALIDACAO-E-RISCOS.md:121`, que repetem "painel". São documentos datados de uma frente encerrada; a allowlist, que é viva, já foi corrigida.
- Qualquer mudança em `get_public_tracking`.

---

## 7. Testes e critérios de aceite

Controle positivo — reintroduzir o defeito, ver o teste falhar, restaurar — **é critério de aceite, não gentileza**: há loja real em produção.

### Pré-voo local (`supabase/tests/local-preflight/`)

Arquivos novos `14-public-code-lookup-109.sql` e `15-controles-109.sql`, seguindo o par 12/13 da 108.

| caso | espera |
|---|---|
| CODE-1 | código certo + unidade certa + pública → devolve `reservations.id` |
| CODE-2 | mesmo código + **unidade errada** → `null` |
| CODE-3 | unidade com `is_public = false` → `null` |
| CODE-4 | código inexistente → `null` |
| CODE-5 | código em minúsculas e com espaços → mesmo resultado de CODE-1 (`upper(btrim())`) |
| CODE-6 | `to_regprocedure('public.get_reservation_by_code(text,uuid)')` é `null` |
| CODE-7 | migration roda duas vezes sem erro (idempotência) |

**CONTROLE-8:** remover `and u.is_public = true` → **CODE-3 tem que falhar**. Restaura e CODE-3 volta a passar.
**CONTROLE-9:** remover `and r.unit_id = p_unit_id` → **CODE-2 tem que falhar**. Restaura e CODE-2 volta a passar.

O harness não prova RLS, grants nem ACL — isso exige Supabase de verdade (ver `README.md` do pré-voo). A parte de ACL é coberta pelo teste estático da allowlist e pela sonda de produção.

### Frontend (vitest)

Os três ramos de `ReservaCodeLookup`: uuid → `navigate` chamado com `/acompanhar/<uuid>`; `null` → "não encontrada"; erro → ramo de erro com "Tentar de novo" e **não** "não encontrada".

**CONTROLE POSITIVO:** reintroduzir o `!reserva` que engole erro → o teste do ramo de erro tem que reprovar.

### Produção, depois do merge

| sonda | hoje | esperado |
|---|---|---|
| `resolve_tracking_token_by_code` com a anon key real | — | 200 com uuid |
| `get_reservation_by_code` | 401 | função não existe (`PGRST202`) |
| código do Ren Sushi contra `unit_id` da Moralles | devolve a reserva | `null` |
| código de unidade com `is_public=false` | devolve a reserva | `null` |
| Advisor lido da API de verdade | `0028=9 0029=14 total=23` | `0028=10 0029=14 total=24` |
| `audit_function_acl()` × allowlist | 16 ↔ 16 | 16 ↔ 16 |

Sondas rodam em transação `read only` (receita em `memory/verificar-guard-em-producao-sem-mcp.md`).

**Confirmação manual do usuário, que só ele pode exercer:** abrir `/r/<slug>` do Ren Sushi, usar "Já tem reserva? Consulte pelo código" com um código real e chegar na página de acompanhamento.

---

## 8. Allowlist e a conta do Advisor

Em `scripts/function-acl-allowlist.json`:

- **sai** a entrada `get_reservation_by_code` / `p_code text, p_unit_id uuid` do bucket `authenticated_tenant`;
- **entra** `resolve_tracking_token_by_code` / `p_code text, p_unit_id uuid` no bucket `public_anon`, `roles: ["anon","authenticated"]`, `security_definer: true`, `advisor_lints: ["0028","0029"]`.

Derivação do `_expected_advisor`:

| | antes | delta | depois |
|---|---|---|---|
| `0028` | 9 | +1 (DEFINER novo com `anon`) | **10** |
| `0029` | 14 | −1 (drop) +1 (entrada nova) | **14** |
| total | 23 | | **24** |

`get_reservation_by_code` declarava só `0029` por ser DEFINER concedida apenas a `authenticated`; a nova declara os dois, como `get_public_tracking`, por ser DEFINER concedida a `anon`.

Esse número é gate de CI (`advisor-divergence-core.test.ts`) **e** tem que bater com o Advisor real lido depois de aplicar. Divergência entre os dois é achado, não ruído.

---

## 9. Invariante para `CLAUDE.md` e `AGENTS.md`

Nos dois arquivos, no mesmo commit:

> **Consulta pública por código resolve só o TOKEN, nunca o dado** — `resolve_tracking_token_by_code` devolve `reservations.id` e quem entrega payload público continua sendo `get_public_tracking` (1º nome, sem telefone/e-mail/`notes`). Dois produtores de payload público divergem; um só, não. As duas gateiam por `units.is_public` e afrouxar uma sem a outra deixa o cliente num beco: código resolve, acompanhamento recusa. Componente de painel não entra em página pública — o `ReservaCard` no portal exibia nome completo, telefone e `notes`. [migration 109](../../../supabase/migrations/20260922150000_109_public_code_lookup.sql).

---

## 10. Gates antes do merge

- `saas-shield-br:migration-validator`
- `saas-shield-br:tenant-isolation-auditor`
- `saas-shield-br:identity-access-auditor` (superfície pública + grant a `anon`)
- `acl-estatico` conferido na aba Checks do PR (não é required status check)
- `npm run typecheck` (`tsc -b --noEmit`), `npm run lint`, suíte completa
- Migration aplicada por `supabase db push`, nunca colada no Studio
