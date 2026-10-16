// Temporary read-only Phase 5 gateway probe; remove after the hosted check.
import { requireInternalAuth } from "../_shared/security.ts";
import { probeHeaders } from "./core.ts";

const responseHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Allow": "GET",
};

Deno.serve((req) => {
  if (!requireInternalAuth(req)) {
    return new Response(null, { status: 401, headers: responseHeaders });
  }
  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: responseHeaders });
  }
  return new Response(JSON.stringify(probeHeaders(req.headers)), {
    status: 200,
    headers: responseHeaders,
  });
});
