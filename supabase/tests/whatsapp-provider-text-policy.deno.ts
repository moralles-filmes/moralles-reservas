// Explicit Deno proof of the actual registry facade/adapters. No network permission.
import {
  getWhatsAppProvider,
  sendOutbound,
} from "../functions/_shared/whatsapp-providers.ts";
import { resolveChannelCredentials } from "../functions/_shared/whatsapp-channel-credentials.ts";
import type {
  ChannelCredentials,
  SendTextOptions,
  WhatsAppProvider,
} from "../functions/_shared/whatsapp-providers.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertion failed: ${JSON.stringify(actual)} != ${
        JSON.stringify(expected)
      }`,
    );
  }
}
const creds: ChannelCredentials = {
  instance_id: "synthetic-instance",
  token: "synthetic-token",
  client_token: "synthetic-client",
  base_url: "https://synthetic.invalid",
  api_key: "synthetic-api",
  session_name: "test-session",
  instance_token: "synthetic-vault",
  phone_number_id: "123456789",
  access_token: "synthetic-access",
};
const message = { toPhone: "55999990000", text: "Olá\n  raw " }; // DDD55 remains the subscriber DDD.
const expectedBody: Record<WhatsAppProvider, unknown> = {
  zapi: { phone: "5555999990000", message: message.text },
  waha: {
    session: "test-session",
    chatId: "5555999990000@c.us",
    text: message.text,
  },
  official: {
    messaging_product: "whatsapp",
    to: "5555999990000",
    type: "text",
    text: { body: message.text },
  },
  datafy: {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "5555999990000",
    type: "text",
    text: { body: message.text },
  },
  uazapi: { number: "5555999990000", text: message.text },
};
const expectedWire: Record<
  WhatsAppProvider,
  { url: string; headers: Record<string, string> }
> = {
  zapi: {
    url:
      "https://api.z-api.io/instances/synthetic-instance/token/synthetic-token/send-text",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": "synthetic-client",
    },
  },
  waha: {
    url: "https://synthetic.invalid/api/sendText",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": "synthetic-api",
    },
  },
  official: {
    url: "https://graph.facebook.com/v19.0/123456789/messages",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer synthetic-access",
    },
  },
  datafy: {
    url: "https://cloud.datafyapi.com.br/v1/123456789/messages",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer synthetic-access",
    },
  },
  uazapi: {
    url: "https://synthetic.invalid/send/text",
    headers: { "Content-Type": "application/json", token: "synthetic-vault" },
  },
};

for (
  const provider of ["zapi", "waha", "official", "datafy", "uazapi"] as const
) {
  for (const single of [false, true]) {
    for (const outcome of [200, 429, 503, "throw", "timeout"] as const) {
      Deno.test(`${provider}: ${single ? "single" : "legacy"} ${outcome}, actual facade and adapter`, async () => {
        const originalFetch = globalThis.fetch;
        const originalTimer = globalThis.setTimeout;
        const originalLog = console.log;
        const originalError = console.error;
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const timeoutDelays: number[] = [];
        const logs: string[] = [];
        console.log = (...args) => {
          logs.push(args.join(" "));
        };
        console.error = (...args) => {
          logs.push(args.join(" "));
        };
        // Preserve the actual abort/controller path. Only timer wall-clock is
        // accelerated, so legacy retries prove all four real fetch invocations.
        globalThis.setTimeout = Object.assign(
          (...timerArgs: Parameters<typeof setTimeout>) => {
            const [handler, delay, ...args] = timerArgs;
            if (delay === 12_000) timeoutDelays.push(delay);
            return originalTimer(
              handler,
              delay === 12_000 && outcome !== "timeout" ? delay : 0,
              ...args,
            );
          },
          originalTimer,
        );
        globalThis.fetch = async (input, init = {}) => {
          calls.push({ url: String(input), init });
          equal(String(input), expectedWire[provider].url);
          equal([...new Headers(init.headers).entries()], [
            ...new Headers(expectedWire[provider].headers).entries(),
          ]);
          equal(init.method, "POST");
          equal(typeof init.body, "string");
          if (typeof init.body !== "string") {
            throw new Error("missing request body");
          }
          equal(JSON.parse(init.body), expectedBody[provider]);
          if (outcome === "throw") {
            throw new TypeError(`synthetic fetch failure at ${String(input)}`);
          }
          if (outcome === "timeout") {
            if (init.signal?.aborted) {
              throw new DOMException("synthetic", "AbortError");
            }
            return new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("synthetic", "AbortError")),
                { once: true },
              );
            });
          }
          return new Response(
            JSON.stringify({ messages: [{ id: "native-synthetic-id" }] }),
            { status: outcome },
          );
        };
        try {
          const options: SendTextOptions | undefined = single
            ? { retryPolicy: "none" }
            : undefined;
          const result = await sendOutbound(provider, creds, message, options);
          equal(
            calls.length,
            provider === "uazapi" || single || outcome === 200 ? 1 : 4,
          );
          equal(timeoutDelays, [12_000]);
          if (outcome === 200) {
            equal(result, {
              ok: true,
              status: 200,
              providerMessageId: "native-synthetic-id",
            });
          } else {
            equal(result.ok, false);
            if (outcome === "throw") {
              equal(
                result.error,
                provider === "uazapi"
                  ? "uazapi_unavailable"
                  : "provider_transport_error",
              );
            }
            if (outcome === "timeout") {
              equal(
                result.error,
                provider === "uazapi" ? "uazapi_timeout" : "provider_timeout",
              );
            }
            if (typeof outcome === "number") equal(result.status, outcome);
          }
          const logText = logs.join(" ");
          for (
            const secret of [
              "synthetic-token",
              "synthetic-client",
              "synthetic-api",
              "synthetic-vault",
              "synthetic-access",
            ]
          ) {
            equal(logText.includes(secret), false);
          }
        } finally {
          globalThis.fetch = originalFetch;
          globalThis.setTimeout = originalTimer;
          console.log = originalLog;
          console.error = originalError;
        }
      });
    }
  }
}

Deno.test("adapter third argument is internal policy, payload retryPolicy cannot opt out", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimer = globalThis.setTimeout;
  const originalLog = console.log;
  const originalError = console.error;
  let calls = 0;
  globalThis.setTimeout = Object.assign(
    (...timerArgs: Parameters<typeof setTimeout>) => {
      const [handler, delay, ...args] = timerArgs;
      return originalTimer(handler, delay === 12_000 ? delay : 0, ...args);
    },
    originalTimer,
  );
  console.log = () => {};
  console.error = () => {};
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}", { status: 429 });
  };
  try {
    const payload = { ...message, retryPolicy: "none" };
    await getWhatsAppProvider("zapi").sendText(creds, payload);
    equal(calls, 4);
    calls = 0;
    await getWhatsAppProvider("zapi").sendText(creds, message, {
      retryPolicy: "none",
    });
    equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimer;
    console.log = originalLog;
    console.error = originalError;
  }
});

for (
  const outcome of [
    "missing-pointer",
    null,
    "",
    {},
    123,
    "error",
    "vault-current",
  ]
) {
  Deno.test(`actual credential resolver: ${JSON.stringify(outcome)}`, async () => {
    const oldBase = Deno.env.get("UAZAPI_BASE_URL");
    Deno.env.set("UAZAPI_BASE_URL", "https://synthetic.invalid");
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return {
          data: outcome,
          error: outcome === "error" ? { message: "synthetic" } : null,
        };
      },
    };
    try {
      let error: unknown;
      let credentials: ChannelCredentials | undefined;
      try {
        credentials = await resolveChannelCredentials(client, {
          id: "channel-a",
          provider: "uazapi",
          credentials: {
            instance_token: "forged-jsonb",
            base_url: "https://forged.invalid",
          },
          instance_token_secret_id: outcome === "missing-pointer"
            ? null
            : "synthetic-pointer",
        });
      } catch (caught) {
        error = caught;
      }
      if (outcome === "vault-current") {
        equal(credentials, {
          instance_token: "vault-current",
          base_url: "https://synthetic.invalid",
        });
      } else {
        equal(
          error instanceof Error ? error.message : null,
          outcome === "missing-pointer"
            ? "uazapi_instance_token_not_configured"
            : "uazapi_instance_token_unavailable",
        );
      }
      equal(
        calls,
        outcome === "missing-pointer" ? [] : [{
          name: "get_whatsapp_channel_instance_token",
          args: { p_channel_id: "channel-a" },
        }],
      );
    } finally {
      if (oldBase === undefined) Deno.env.delete("UAZAPI_BASE_URL");
      else Deno.env.set("UAZAPI_BASE_URL", oldBase);
    }
  });
}

Deno.test("actual non-Uaz credential resolver preserves shallow byte-equivalent copy without Vault", async () => {
  const source = {
    token: "synthetic-token",
    client_token: "  synthetic-client  ",
  };
  let calls = 0;
  const result = await resolveChannelCredentials({
    rpc: async () => {
      calls++;
      return { data: null, error: null };
    },
  }, { id: "channel-a", provider: "zapi", credentials: source });
  equal(result, source);
  equal(result === source, false);
  equal(calls, 0);
});
