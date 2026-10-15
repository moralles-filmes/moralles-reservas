#!/usr/bin/env bash
# 61b-concorrencia-datafy-onboarding.sh — o CLIQUE DUPLO da Review Focus 1 do
# plano Datafy parceiro, medido com DUAS sessões reais (Git Bash).
#
# O `61` é de sessão única: o C4 prova que o segundo claim SEQUENCIAL não leva
# nada. O que ele não alcança é a corrida — dois `official_connect_start` (ou
# dois `confirm`) chegando juntos, cada um na sua conexão, antes de qualquer um
# commitar. A exclusão é o `for update` de `claim_datafy_onboarding_step`: quem
# chega depois ESPERA o primeiro commitar e, em READ COMMITTED, relê o claim já
# gravado. Sem o lock, os dois leem a linha sem claim, os dois decidem tomá-la,
# e o UPDATE do segundo (reavaliado só por `id`) sobrescreve o do primeiro: dois
# `claimed = t`, dois POSTs à Datafy.
#
#   CONC-61-1  A segura o claim (sessão aberta 3 s); B ESPERA e recebe
#              claimed = f, sem cerca; a linha fica com a cerca de A
#   CONC-61-2  controle de tempo: o mesmo claim sem concorrência leva < 1 s
#   CONC-61-3  controle positivo: claim SEM `for update` -> os DOIS levam;
#              restaura reaplicando a migration e confere o md5 da função
#
# Pré-requisito: banco com 00 -> 00a -> 61a -> migration (na sequência do
# README, depois do `61`). Cria um onboarding próprio na unidade C1 e o apaga no
# fim. Sai com código != 0 se algum caso falhar.
#
# Uso:
#   PGBIN="/c/Program Files/PostgreSQL/18/bin" PGPORT=55462 PGDB=datafy61 \
#     bash supabase/tests/local-preflight/61b-concorrencia-datafy-onboarding.sh
#
# Tempos por relógio de parede em volta do psql (inclui a partida do cliente,
# ~0,1 s); aritmética por `awk` porque o Git Bash não tem `bc`.

set -u
export PGCLIENTENCODING=UTF8

PGBIN="${PGBIN:-$USERPROFILE/scoop/apps/postgresql/current/bin}"
PGPORT="${PGPORT:-55432}"
PGDB="${PGDB:-datafy61}"

AQUI="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$AQUI/../../migrations/20261014120000_datafy_partner_onboarding.sql"

ONB='eeeeeeee-0000-0000-0000-000000000061'
UNIDADE='bbbbbbbb-0000-0000-0000-000000000003'
ORG='aaaaaaaa-0000-0000-0000-000000000003'
FN="'public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)'::regprocedure"

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

P() { "$PGBIN/psql.exe" -X -q -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 "$@"; }
# Um valor: -At, sem o \r que o psql do Windows deixa.
Q() { P -At -c "$1" | tr -d '\r'; }

agora_ns() { date +%s%N; }
segundos() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", (b - a) / 1e9 }'; }
ge() { awk -v x="$1" -v y="$2" 'BEGIN { exit !(x >= y) }'; }
lt() { awk -v x="$1" -v y="$2" 'BEGIN { exit !(x < y) }'; }

# `boolean || text` vira 'true'/'false', não 't'/'f': o `case` fixa a forma.
claim_sql() { printf "select (case when claimed then 't' else 'f' end) || '|' || coalesce(claim_id::text, '') from public.claim_datafy_onboarding_step('%s', '%s', 'create_channel', null);" "$ONB" "$UNIDADE"; }
cerca_da_linha() { Q "select coalesce(claim_id::text, '') from public.whatsapp_datafy_onboardings where id = '$ONB'"; }

FALHAS=0
veredito() { # $1 caso, $2 0=ok, $3 detalhe
  if [ "$2" -eq 0 ]; then printf '%-10s OK      %s\n' "$1" "$3"
  else printf '%-10s FALHOU  %s\n' "$1" "$3"; FALHAS=$((FALHAS + 1)); fi
}

entre_casos() {
  P -c "update public.whatsapp_datafy_onboardings
           set claim_id = null, claim_step = null, claim_started_at = null, claim_expires_at = null, claim_actor_id = null,
               uncertain_steps = '{}', last_error = null
         where id = '$ONB';"
}

# A segura o claim por 3 s; B chega 1 s depois. Deixa em A_OUT/B_OUT a saída
# `claimed|claim_id` de cada sessão e em T_B o tempo de B.
corrida() {
  P -At -c "begin;" -c "$(claim_sql)" -c "select pg_sleep(3);" -c "commit;" >"$TMPD/a.out" 2>"$TMPD/a.err" &
  local pid_a=$!
  sleep 1
  local t0 t1
  t0=$(agora_ns)
  B_OUT="$(P -At -c "$(claim_sql)" 2>"$TMPD/b.err" | tr -d '\r')"; RC_B=$?
  t1=$(agora_ns)
  wait "$pid_a"; RC_A=$?
  A_OUT="$(tr -d '\r' < "$TMPD/a.out" | grep '|' | head -1)"
  T_B=$(segundos "$t0" "$t1")
}

# ─── GUARDA ─────────────────────────────────────────────────────────────────
PRONTO="$(Q "select to_regprocedure('public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)') is not null and exists (select 1 from units where id = '$UNIDADE')")"
if [ "$PRONTO" != "t" ]; then
  echo "61b exige 00 -> 00a -> 61a -> migration 20261014120000 aplicados em $PGDB (porta $PGPORT): RPC ou unidade $UNIDADE ausente." >&2
  exit 2
fi

P -c "delete from public.whatsapp_datafy_onboardings where id = '$ONB';
      insert into public.whatsapp_datafy_onboardings (id, organization_id, unit_id) values ('$ONB', '$ORG', '$UNIDADE');"

# ─── CONC-61-1: clique duplo — B espera e não leva ──────────────────────────
entre_casos
corrida
CERCA="$(cerca_da_linha)"
A_CLAIMED="${A_OUT%%|*}"; A_CERCA="${A_OUT#*|}"
OK=1
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ] && [ "$A_CLAIMED" = "t" ] && [ -n "$A_CERCA" ] \
   && [ "$B_OUT" = "f|" ] && ge "$T_B" 1.5 && [ "$CERCA" = "$A_CERCA" ]; then OK=0; fi
veredito "CONC-61-1" "$OK" "B esperou ${T_B} s (>= 1.5); A=${A_CLAIMED} B='${B_OUT}' (esperado 'f|'); cerca da linha e de A=$([ "$CERCA" = "$A_CERCA" ] && echo t || echo f); rc A=$RC_A B=$RC_B $(tr -d '\r' < "$TMPD/b.err" | grep -m1 ERROR)"

# ─── CONC-61-2: controle de tempo — sem concorrência, o claim não espera ────
entre_casos
T0=$(agora_ns)
SAIDA="$(P -At -c "$(claim_sql)" 2>"$TMPD/c2.err" | tr -d '\r')"; RC=$?
T1=$(agora_ns)
T=$(segundos "$T0" "$T1")
OK=1
if lt "$T" 1 && [ "$RC" -eq 0 ] && [ "${SAIDA%%|*}" = "t" ]; then OK=0; fi
veredito "CONC-61-2" "$OK" "claim sem concorrencia levou ${T} s (< 1); claimed=${SAIDA%%|*} rc=$RC $(tr -d '\r' < "$TMPD/c2.err" | grep -m1 ERROR)"

# ─── CONC-61-3: controle positivo — sem `for update`, os DOIS levam ─────────
entre_casos
MD5_REAL="$(Q "select md5(pg_get_functiondef($FN))")"
P >/dev/null 2>"$TMPD/c3-sab.err" <<'SQL'
do $$
declare
  v_real text := pg_get_functiondef('public.claim_datafy_onboarding_step(uuid,uuid,text,uuid,integer)'::regprocedure);
  -- `\s+`, e não `\n` literal: num checkout com core.autocrlf o corpo chega
  -- com CRLF e um `replace` exato não mudaria nada.
  v_sab  text := regexp_replace(v_real, 'where o\.id = p_onboarding_id\s+for update;', 'where o.id = p_onboarding_id;');
begin
  if v_sab = v_real then
    raise exception 'CONC-61-3: o replace nao mudou nada (o trecho "for update" nao esta na RPC)';
  end if;
  execute v_sab;
end $$;
SQL
RC_SAB=$?
MD5_SAB="$(Q "select md5(pg_get_functiondef($FN))")"
A_OUT="n/a"; B_OUT="n/a"; T_B="n/a"
if [ "$RC_SAB" -eq 0 ] && [ "$MD5_SAB" != "$MD5_REAL" ]; then
  corrida
fi
# Restore SEMPRE, sabotagem aplicada ou não: reaplica a migration.
P -f "$MIGRATION" >/dev/null 2>"$TMPD/c3-restore.err"; RC_RESTORE=$?
MD5_DEPOIS="$(Q "select md5(pg_get_functiondef($FN))")"
OK=1
if [ "$RC_SAB" -eq 0 ] && [ "$MD5_SAB" != "$MD5_REAL" ] && [ "${A_OUT%%|*}" = "t" ] && [ "${B_OUT%%|*}" = "t" ] \
   && [ "$RC_RESTORE" -eq 0 ] && [ "$MD5_DEPOIS" = "$MD5_REAL" ]; then OK=0; fi
veredito "CONC-61-3" "$OK" "sem for update: A=${A_OUT%%|*} B=${B_OUT%%|*} (esperado os dois t; B esperou ${T_B} s); sabotou=$([ "$MD5_SAB" != "$MD5_REAL" ] && echo t || echo f) restaurou=$([ "$MD5_DEPOIS" = "$MD5_REAL" ] && echo t || echo f) $(tr -d '\r' < "$TMPD/c3-sab.err" | grep -m1 ERROR)"

P -c "delete from public.whatsapp_datafy_onboardings where id = '$ONB';"

if [ "$FALHAS" -ne 0 ]; then
  echo "FALHOU: $FALHAS verificacao(oes) vermelha(s)"
  exit 1
fi
echo "3/3 OK"
