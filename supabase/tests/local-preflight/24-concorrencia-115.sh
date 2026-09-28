#!/usr/bin/env bash
# 24-concorrencia-115.sh — o `for share` do guard da 115 contra uma
# anonimização CONCORRENTE, medido com DUAS sessões reais (Git Bash).
#
# O `22`/`23` são de sessão única e só medem a perna sequencial (TP-6b). O que
# eles não alcançam é a corrida: um INSERT de touchpoint em voo enquanto o
# `UPDATE customers set deleted_at = ...` de anonymize_customer roda. O guard lê
# o cliente com `select ... for share`, que conflita com o `FOR NO KEY UPDATE`
# implícito do UPDATE: quem chega depois ESPERA, e em READ COMMITTED relê a
# versão committed. Sem o lock, a purga da anonimização não enxerga o INSERT
# ainda não committed e o ctwa_clid sobrevive para sempre (sem purga por tempo,
# D3 da spec).
#
#   CONC-1  a anonimização segura o lock; o INSERT ESPERA e é recusado (P0A15)
#   CONC-2  o INSERT segura o lock; a anonimização ESPERA e apaga a linha
#   CONC-3  controle de tempo: o mesmo INSERT sem concorrência leva < 1 s
#   CONC-4  controle positivo: guard SEM `for share` -> a linha SOBREVIVE;
#           restaura reaplicando a 115 e confere o md5 do guard
#
# Pré-requisito: banco com 00 -> 00a -> 22a -> 115 (na sequência do README,
# depois do 22 e do 23, que deixam a tabela vazia e o cliente A1 vivo). Recusa
# rodar se a tabela não existe. Entre casos, reseta `deleted_at` do cliente e
# confere 0 linhas na tabela. Sai com código != 0 se algum caso falhar.
#
# Uso:
#   PGPORT=55432 PGDB=fased115 bash supabase/tests/local-preflight/24-concorrencia-115.sh
#
# Tempos por relógio de parede em volta do psql (inclui a partida do cliente,
# ~0,1 s); aritmética por `awk` porque o Git Bash não tem `bc`.

set -u
export PGCLIENTENCODING=UTF8

PGBIN="${PGBIN:-$USERPROFILE/scoop/apps/postgresql/current/bin}"
PGPORT="${PGPORT:-55432}"
PGDB="${PGDB:-fased115}"

AQUI="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$AQUI/../../migrations/20260927120000_115_whatsapp_ad_touchpoints.sql"

CLIENTE='cccccccc-0000-0000-0000-000000000001'
UNIDADE='bbbbbbbb-0000-0000-0000-000000000001'
CANAL='dddddddd-0000-0000-0000-000000000001'
GUARD="'public.whatsapp_ad_touchpoints_guard()'::regprocedure"

TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

P() { "$PGBIN/psql.exe" -X -q -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 "$@"; }
# Um valor: -At, sem o \r que o psql do Windows deixa.
Q() { P -At -c "$1" | tr -d '\r'; }

agora_ns() { date +%s%N; }
segundos() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", (b - a) / 1e9 }'; }
ge() { awk -v x="$1" -v y="$2" 'BEGIN { exit !(x >= y) }'; }
lt() { awk -v x="$1" -v y="$2" 'BEGIN { exit !(x < y) }'; }

insert_sql() {
  printf "insert into public.whatsapp_ad_touchpoints (unit_id, channel_id, customer_id, provider, provider_message_id, message_at, ctwa_clid) values ('%s', '%s', '%s', 'datafy', '%s', now(), 'clid-%s');" \
    "$UNIDADE" "$CANAL" "$CLIENTE" "$1" "$1"
}

sobra_do_cliente() { Q "select count(*) from public.whatsapp_ad_touchpoints where customer_id = '$CLIENTE'"; }

FALHAS=0
veredito() { # $1 caso, $2 0=ok, $3 detalhe
  if [ "$2" -eq 0 ]; then printf '%-7s OK      %s\n' "$1" "$3"
  else printf '%-7s FALHOU  %s\n' "$1" "$3"; FALHAS=$((FALHAS + 1)); fi
}

entre_casos() {
  local residuo
  P -c "update public.customers set deleted_at = null where id = '$CLIENTE';"
  residuo="$(Q "select count(*) from public.whatsapp_ad_touchpoints")"
  if [ "$residuo" != "0" ]; then
    veredito "ENTRE" 1 "$residuo linha(s) residual(is) em whatsapp_ad_touchpoints antes do caso; apagando para medir o próximo"
    P -c "delete from public.whatsapp_ad_touchpoints;"
  fi
}

# ─── GUARDA ─────────────────────────────────────────────────────────────────
PRONTO="$(Q "select to_regclass('public.whatsapp_ad_touchpoints') is not null and exists (select 1 from public.customers where id = '$CLIENTE')")"
if [ "$PRONTO" != "t" ]; then
  echo "24-concorrencia-115.sh exige 00 -> 00a -> 22a -> 115 aplicados em $PGDB (porta $PGPORT): tabela public.whatsapp_ad_touchpoints ou cliente $CLIENTE ausente." >&2
  exit 2
fi

# ─── CONC-1: anonimização primeiro; o INSERT espera e é recusado ────────────
entre_casos
P -c "begin; update public.customers set deleted_at = now() where id = '$CLIENTE'; select pg_sleep(3); commit;" \
  >/dev/null 2>"$TMPD/conc1-a.err" &
PID_A=$!
sleep 1
T0=$(agora_ns)
SAIDA_B="$(P -v VERBOSITY=verbose -c "$(insert_sql wamid.CONC1)" 2>&1 | tr -d '\r')"
T1=$(agora_ns)
wait "$PID_A"; RC_A=$?
T=$(segundos "$T0" "$T1")
SOBRA=$(sobra_do_cliente)
OK=1
if ge "$T" 1.5 && [ "$RC_A" -eq 0 ] && [ "$SOBRA" = "0" ] \
   && [[ "$SAIDA_B" == *anonimizado* ]] && [[ "$SAIDA_B" == *P0A15* ]]; then OK=0; fi
veredito "CONC-1" "$OK" "INSERT esperou ${T} s (>= 1.5); recusa: $(printf '%s' "$SAIDA_B" | head -1); sobraram $SOBRA; sessao A rc=$RC_A"

# ─── CONC-2: INSERT primeiro; a anonimização espera e apaga a linha ─────────
entre_casos
P -c "begin; $(insert_sql wamid.CONC2) select pg_sleep(3); commit;" >/dev/null 2>"$TMPD/conc2-b.err" &
PID_B=$!
sleep 1
T0=$(agora_ns)
P -c "update public.customers set deleted_at = now() where id = '$CLIENTE';" 2>"$TMPD/conc2-a.err"; RC_A=$?
T1=$(agora_ns)
wait "$PID_B"; RC_B=$?
T=$(segundos "$T0" "$T1")
SOBRA=$(sobra_do_cliente)
OK=1
if ge "$T" 1.5 && [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ] && [ "$SOBRA" = "0" ]; then OK=0; fi
veredito "CONC-2" "$OK" "anonimizacao esperou ${T} s (>= 1.5); sobraram $SOBRA (esperado 0); rc A=$RC_A B=$RC_B $(tr -d '\r' < "$TMPD/conc2-b.err" | head -1)"

# ─── CONC-3: controle de tempo — sem concorrência, o INSERT não espera ──────
entre_casos
T0=$(agora_ns)
P -c "begin; $(insert_sql wamid.CONC3) rollback;" 2>"$TMPD/conc3.err"; RC=$?
T1=$(agora_ns)
T=$(segundos "$T0" "$T1")
SOBRA=$(sobra_do_cliente)
OK=1
if lt "$T" 1 && [ "$RC" -eq 0 ] && [ "$SOBRA" = "0" ]; then OK=0; fi
veredito "CONC-3" "$OK" "INSERT sem concorrencia levou ${T} s (< 1); rc=$RC $(tr -d '\r' < "$TMPD/conc3.err" | head -1)"

# ─── CONC-4: controle positivo — guard SEM `for share`, a linha sobrevive ───
entre_casos
MD5_REAL="$(Q "select md5(pg_get_functiondef($GUARD))")"
P >/dev/null 2>"$TMPD/conc4-sab.err" <<'SQL'
do $$
declare
  v_real text := pg_get_functiondef('public.whatsapp_ad_touchpoints_guard()'::regprocedure);
  v_sab  text := replace(v_real, 'where c.id = new.customer_id for share;', 'where c.id = new.customer_id;');
begin
  if v_sab = v_real then
    raise exception 'CONC-4: o replace nao mudou nada (o trecho "for share" nao esta no guard)';
  end if;
  execute v_sab;
end $$;
SQL
RC_SAB=$?
MD5_SAB="$(Q "select md5(pg_get_functiondef($GUARD))")"
SOBRA="n/a"; T="n/a"
if [ "$RC_SAB" -eq 0 ] && [ "$MD5_SAB" != "$MD5_REAL" ]; then
  P -c "begin; $(insert_sql wamid.CONC4) select pg_sleep(3); commit;" >/dev/null 2>"$TMPD/conc4-b.err" &
  PID_B=$!
  sleep 1
  T0=$(agora_ns)
  P -c "update public.customers set deleted_at = now() where id = '$CLIENTE';" 2>"$TMPD/conc4-a.err"
  T1=$(agora_ns)
  wait "$PID_B"
  T=$(segundos "$T0" "$T1")
  SOBRA=$(sobra_do_cliente)
fi
# Restore SEMPRE, sabotagem aplicada ou não: limpa e reaplica a 115.
P -c "delete from public.whatsapp_ad_touchpoints;"
P -f "$MIGRATION" >/dev/null 2>"$TMPD/conc4-restore.err"; RC_RESTORE=$?
MD5_DEPOIS="$(Q "select md5(pg_get_functiondef($GUARD))")"
OK=1
if [ "$RC_SAB" -eq 0 ] && [ "$MD5_SAB" != "$MD5_REAL" ] && [ "$SOBRA" = "1" ] \
   && [ "$RC_RESTORE" -eq 0 ] && [ "$MD5_DEPOIS" = "$MD5_REAL" ]; then OK=0; fi
veredito "CONC-4" "$OK" "sem for share: anonimizacao levou ${T} s, sobrou $SOBRA (esperado 1); sabotou=$([ "$MD5_SAB" != "$MD5_REAL" ] && echo t || echo f) restaurou=$([ "$MD5_DEPOIS" = "$MD5_REAL" ] && echo t || echo f) $(tr -d '\r' < "$TMPD/conc4-sab.err" | grep -m1 ERROR)"

entre_casos

if [ "$FALHAS" -ne 0 ]; then
  echo "FALHOU: $FALHAS verificacao(oes) vermelha(s)"
  exit 1
fi
echo "4/4 OK"
