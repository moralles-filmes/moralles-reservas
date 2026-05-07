// Endpoint legacy global Z-API. Substituído pelo path multi-tenant
// /functions/v1/webhook-whatsapp?channel=<id>, que valida secret per-canal
// e suporta BYOK por unidade. Logs do projeto não mostram tráfego ativo
// para este endpoint, então respondemos 410 Gone com a URL nova.
//
// Mantemos a função deployada para servir essa resposta (em vez de 404
// genérico do gateway) e capturar logs caso algum cliente esquecido ainda
// aponte para cá.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { jsonLog } from "../_shared/security.ts";

serve((req) => {
  jsonLog("warn", {
    evt: "webhook_zapi_deprecated_hit",
    method: req.method,
    url: req.url,
  });

  return new Response(
    JSON.stringify({
      error: "deprecated",
      message:
        "webhook-zapi foi removido. Use /functions/v1/webhook-whatsapp?channel=<channel_id>&secret=<webhook_secret> (configurado por canal em Plataforma → Automação).",
    }),
    {
      status: 410,
      headers: { "Content-Type": "application/json" },
    }
  );
});
