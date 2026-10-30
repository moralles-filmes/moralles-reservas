import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { isPreferenceToken } from '../../../supabase/functions/_shared/whatsapp-message-preferences-core';

const viewSchema = z.union([
  z.object({ valid: z.literal(false) }).strict(),
  z.object({ valid: z.literal(true), unitLabel: z.string().min(1).max(120), choice: z.enum(['unknown', 'opt_in', 'opt_out']) }).strict(),
]);
const responseSchema = z.union([
  z.object({ valid: z.literal(false) }).strict(),
  z.object({ valid: z.literal(true), choice: z.literal('opt_out') }).strict(),
]);
type Lifecycle = { token: string; nonce: string };

async function preferenceRequest(token: string, method: 'GET' | 'POST', signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-message-preferences`, {
      method, cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit', signal,
      headers: method === 'GET' ? { 'x-preference-token': token } : { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ token, action: 'opt_out' }) } : {}),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'rate_limited' : 'unavailable');
    return await response.json();
  } catch (error) {
    // Never propagate transport exceptions: they may carry a URL or request data.
    throw new Error(error instanceof Error && error.message === 'rate_limited' ? 'rate_limited' : 'unavailable');
  }
}
export default function PreferenciasMensagens() {
  const { token = '' } = useParams<{ token: string }>();
  const [lifecycle, setLifecycle] = useState<Lifecycle>(() => ({ token, nonce: crypto.randomUUID() }));
  // Replace the child in the same render, before old unit/confirmation can appear.
  if (lifecycle.token !== token) {
    setLifecycle({ token, nonce: crypto.randomUUID() });
    return null;
  }
  return <PreferenceLifecycle key={lifecycle.nonce} lifecycle={lifecycle} />;
}
function PreferenceLifecycle({ lifecycle }: { lifecycle: Lifecycle }) {
  const { token, nonce } = lifecycle;
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ['message-preferences', nonce], enabled: isPreferenceToken(token),
    queryFn: async ({ signal }) => {
      const parsed = viewSchema.safeParse(await preferenceRequest(token, 'GET', signal));
      if (!parsed.success) throw new Error('unavailable');
      return parsed.data;
    }, gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!confirm || !query.data?.valid || query.isError) throw new Error('unavailable');
      const parsed = responseSchema.safeParse(await preferenceRequest(token, 'POST'));
      if (!parsed.success) throw new Error('unavailable');
      return parsed.data;
    }, gcTime: 0, retry: false,
  });
  useEffect(() => () => {
    const key = ['message-preferences', nonce];
    void client.cancelQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: key, exact: true });
  }, [client, nonce]);
  const invalid = !isPreferenceToken(token) || (query.data?.valid === false) || (mutation.data?.valid === false);
  const optedOut = query.data?.valid && query.data.choice === 'opt_out' || mutation.data?.valid === true;
  return <main className="min-h-[100dvh] ambient bg-background text-foreground px-4 py-10 sm:py-16 flex justify-center pb-[max(2.5rem,env(safe-area-inset-bottom))]">
    <Card className="surface rounded-panel w-full max-w-lg h-fit p-6 sm:p-8 space-y-5">
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">Preferências de mensagens</h1>
      {invalid ? <p role="status" className="rounded-block border border-border bg-muted/40 p-4 text-sm leading-relaxed">Link inválido ou expirado</p> : query.isPending ? <p role="status" className="text-sm text-muted-foreground py-4">Consultando suas preferências…</p> : query.isError ? <div role="alert" className="space-y-4 rounded-block border border-destructive/20 bg-destructive/5 p-4"><p className="text-sm leading-relaxed">{query.error.message === 'rate_limited' ? 'Muitas consultas. Aguarde um momento e tente novamente.' : 'Não foi possível consultar suas preferências.'}</p><Button className="min-h-11 rounded-full" onClick={() => void query.refetch()}>Tentar novamente</Button></div> : query.data?.valid && <>
        <h2 className="text-lg font-semibold tracking-tight text-gold-ink break-words">{query.data.unitLabel}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">Esta escolha vale para ofertas desta unidade. As mensagens sobre seu atendimento continuam conforme as permissões aplicáveis.</p>
        {optedOut ? <p role="status" className="rounded-block border border-success/20 bg-success/10 p-4 text-sm leading-relaxed font-medium">{mutation.data?.valid ? 'Sua preferência foi registrada. Você não receberá ofertas desta unidade.' : 'Você escolheu não receber ofertas desta unidade.'}</p> : <>
          <p className="text-sm leading-relaxed">{query.data.choice === 'unknown' ? 'Não há uma escolha registrada para ofertas.' : 'Você autorizou o recebimento de ofertas.'}</p>
          {!confirm ? <Button className="min-h-11 h-auto w-full whitespace-normal rounded-full py-3" onClick={() => setConfirm(true)}>Não receber ofertas desta unidade</Button> : <div className="space-y-4 rounded-block border border-gold/20 bg-gold/5 p-4" role="group" aria-label="Confirmar preferência">
            <p className="text-sm leading-relaxed break-words">Confirmar que você não quer receber ofertas de {query.data.unitLabel}?</p>
            <div className="flex flex-col gap-2 sm:flex-row"><Button autoFocus className="min-h-11 h-auto whitespace-normal rounded-full py-3" disabled={mutation.isPending} onClick={() => { if (!mutation.isPending) mutation.mutate(); }}>{mutation.isPending ? 'Registrando…' : 'Confirmar recusa de ofertas'}</Button><Button className="min-h-11 rounded-full" variant="outline" disabled={mutation.isPending} onClick={() => setConfirm(false)}>Voltar</Button></div>
          </div>}
          {mutation.isError && <p role="alert" className="rounded-block border border-destructive/20 bg-destructive/5 p-4 text-sm leading-relaxed">Não foi possível registrar sua preferência. Tente confirmar novamente.</p>}
        </>}
      </>}
    </Card>
  </main>;
}
