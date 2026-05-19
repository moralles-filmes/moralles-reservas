// Limpeza periódica de blobs órfãos no bucket `unit-assets`.
//
// Cobre a limitação dos cleanups inline dos hooks (Conta, MenuDetail,
// MeusCardapios, MenuBannerEditor): quando o usuário sobe uma imagem
// e fecha a aba do navegador SEM salvar nem cancelar, o blob fica em
// Storage sem referência em DB. Os hooks de save apagam órfãos da
// sessão atual, mas não cobrem abandono pós-upload. Este worker varre
// o bucket inteiro semanalmente e remove o que sobrou.
//
// Disparado por pg_cron via wrapper SECURITY DEFINER (vide migration
// 20260520000000_storage_orphan_cleanup_cron.sql). Pode também ser
// invocado manualmente via curl com x-internal-key:
//
//   POST /functions/v1/cleanup-orphan-assets[?dry=1&grace_minutes=60]
//   Header: x-internal-key: <INTERNAL_API_KEY>
//   Body (opcional): { "dry": true, "grace_minutes": 60 }
//
// Comportamento:
//   1. RPC list_orphan_unit_assets(grace_minutes) faz o cruzamento em SQL,
//      respeitando o grace period (default 60min — evita pegar uploads em
//      curso de usuários ativos).
//   2. Se dry=true OU não houver órfãos, retorna report sem deletar.
//   3. Senão, apaga em batches de 100 via Storage API (não SQL direto —
//      a API respeita policies e triggers internos de metadata cleanup).
//   4. Sempre retorna JSON estruturado: deleted, errors, sample, duração.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonLog, requireInternalAuth } from "../_shared/security.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const BUCKET = "unit-assets";
const DEFAULT_GRACE_MINUTES = 60;
// Storage API aceita até 1000 paths por chamada `remove`. Mantemos
// conservador em 100 pra erros parciais ficarem mais granulares.
const REMOVE_BATCH_SIZE = 100;

interface OrphanRow {
  path: string;
  bytes: number | string | null;
  created_at: string;
}

interface Params {
  dry: boolean;
  graceMinutes: number;
}

async function readParams(req: Request): Promise<Params> {
  const url = new URL(req.url);
  let dry = url.searchParams.get("dry") === "1";
  const graceQuery = url.searchParams.get("grace_minutes");
  let graceMinutes = graceQuery !== null ? parseInt(graceQuery, 10) : NaN;

  // Cron manda body JSON ({grace_minutes:60}). Aceita também sem body.
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      if (typeof body?.dry === "boolean") dry = body.dry;
      if (typeof body?.grace_minutes === "number") graceMinutes = body.grace_minutes;
    } catch {
      // body vazio ou não-JSON — ignora silenciosamente
    }
  }

  return {
    dry,
    graceMinutes:
      Number.isFinite(graceMinutes) && graceMinutes >= 0
        ? graceMinutes
        : DEFAULT_GRACE_MINUTES,
  };
}

serve(async (req) => {
  if (!requireInternalAuth(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAt = Date.now();
  const { dry, graceMinutes } = await readParams(req);

  // 1) Lista órfãos via RPC SECURITY DEFINER (respeita grace period).
  const { data: orphans, error: listErr } = await supabase.rpc(
    "list_orphan_unit_assets",
    { grace_minutes: graceMinutes },
  );

  if (listErr) {
    jsonLog("error", {
      evt: "cleanup_orphans",
      phase: "list",
      error: listErr.message,
    });
    return new Response(
      JSON.stringify({ error: "list_failed", details: listErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const rows = (orphans ?? []) as OrphanRow[];
  const orphansFound = rows.length;
  const totalBytes = rows.reduce((sum, r) => sum + Number(r.bytes ?? 0), 0);

  // 2) Dry-run ou nada pra apagar — retorna report e sai.
  if (dry || orphansFound === 0) {
    jsonLog("info", {
      evt: "cleanup_orphans",
      dry,
      orphansFound,
      totalBytes,
      graceMinutes,
      duration_ms: Date.now() - startedAt,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        dry,
        grace_minutes: graceMinutes,
        orphans_found: orphansFound,
        total_bytes: totalBytes,
        deleted: 0,
        errors: 0,
        sample: rows.slice(0, 20).map((r) => r.path),
        duration_ms: Date.now() - startedAt,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // 3) Apaga em batches. Storage API silencia paths inexistentes — ok.
  let deleted = 0;
  let errors = 0;
  const errorBatches: Array<{ size: number; error: string }> = [];

  for (let i = 0; i < rows.length; i += REMOVE_BATCH_SIZE) {
    const batch = rows.slice(i, i + REMOVE_BATCH_SIZE).map((r) => r.path);
    const { error: rmErr, data } = await supabase.storage
      .from(BUCKET)
      .remove(batch);

    if (rmErr) {
      errors += batch.length;
      errorBatches.push({ size: batch.length, error: rmErr.message });
      jsonLog("warn", {
        evt: "cleanup_orphans",
        phase: "remove",
        batchSize: batch.length,
        error: rmErr.message,
      });
    } else {
      // data.length pode ser menor que batch.length se algum path já
      // tinha sumido — ainda assim tratamos como "limpo".
      deleted += data?.length ?? batch.length;
    }
  }

  jsonLog("info", {
    evt: "cleanup_orphans",
    orphansFound,
    deleted,
    errors,
    totalBytes,
    graceMinutes,
    duration_ms: Date.now() - startedAt,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      dry: false,
      grace_minutes: graceMinutes,
      orphans_found: orphansFound,
      total_bytes: totalBytes,
      deleted,
      errors,
      sample: rows.slice(0, 20).map((r) => r.path),
      error_batches: errorBatches.length > 0 ? errorBatches.slice(0, 5) : undefined,
      duration_ms: Date.now() - startedAt,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});
