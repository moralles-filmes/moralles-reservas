import { describe, expect, it, vi } from 'vitest';
import { createPreferencesHandler } from '../../supabase/functions/_shared/whatsapp-message-preferences-handler.ts';

const token='A'.repeat(43), origin='https://preferences.example';
function setup() {
  const lookup=vi.fn(async () => ({valid:true as const,unitLabel:'Restaurante',choice:'unknown' as const}));
  const optOut=vi.fn(async () => true), rateGate=vi.fn(async () => true);
  const handler=createPreferencesHandler({allowedOrigins:[origin],lookup,optOut,rateGate});
  return {handler,lookup,optOut,rateGate};
}
function post(body: unknown, headers: Record<string,string>={}) { return new Request(origin,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)}); }
describe('real preference HTTP requests', () => {
  it('GET conveys token only via header and returns the minimal DTO without mutation', async () => {
    const {handler,lookup,optOut}=setup();
    const result=await handler(new Request(origin,{headers:{'x-preference-token':token}}));
    expect(result.status).toBe(200); expect(await result.json()).toEqual({valid:true,unitLabel:'Restaurante',choice:'unknown'});
    expect(lookup).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/)); expect(optOut).not.toHaveBeenCalled();
    expect(result.headers.get('referrer-policy')).toBe('no-referrer'); expect(result.headers.get('cache-control')).toBe('no-store');
    expect((await handler(new Request(origin+'?token='+token))).status).toBe(400);
  });
  it('only explicit opt_out with exact keys and origin mutates', async () => {
    const {handler,optOut}=setup();
    for (const body of [{token,action:'opt_in'},{token,action:'opt_out',unit_id:'foreign'}, {token},null]) expect((await handler(post(body))).status).toBe(400);
    expect((await handler(post({token,action:'opt_out'},{origin:'https://foreign.example'}))).status).toBe(403);
    expect((await handler(post({token,action:'opt_out'},{'content-type':'text/plain'}))).status).toBe(415);
    expect(optOut).not.toHaveBeenCalled();
    expect((await handler(post({token,action:'opt_out'}))).status).toBe(200);
    expect((await handler(post({token,action:'opt_out'}))).status).toBe(200);
    expect(optOut).toHaveBeenCalledTimes(2);
  });
  it('preflight is tokenless and other methods are closed', async () => {
    const {handler,lookup,optOut,rateGate}=setup();
    expect((await handler(new Request(origin,{method:'OPTIONS',headers:{origin}}))).status).toBe(204);
    expect(lookup).not.toHaveBeenCalled(); expect(optOut).not.toHaveBeenCalled(); expect(rateGate).not.toHaveBeenCalled();
    expect((await handler(new Request(origin,{method:'DELETE'}))).status).toBe(405);
  });
  it('bounds actual streamed bytes even without Content-Length', async () => {
    const {handler,optOut}=setup();
    const body=new ReadableStream({start(controller){ controller.enqueue(new TextEncoder().encode('x'.repeat(2050)));controller.close(); }});
    const request=new Request(origin,{method:'POST',headers:{origin,'content-type':'application/json'},body,duplex:'half'} as RequestInit);
    expect((await handler(request)).status).toBe(413); expect(optOut).not.toHaveBeenCalled();
  });
  it('invalid expired revoked scopes have identical DTO and errors never echo secrets', async () => {
    const {handler,lookup,optOut}=setup(); lookup.mockResolvedValue(null);
    expect(await (await handler(new Request(origin,{headers:{'x-preference-token':token}}))).json()).toEqual({valid:false});
    optOut.mockResolvedValue(false); expect(await (await handler(post({token,action:'opt_out'}))).json()).toEqual({valid:false});
    lookup.mockRejectedValue(new Error(token)); const response=await handler(new Request(origin,{headers:{'x-preference-token':token}}));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(token);
  });
  it('rate denial or failure is closed before capability access and hashes technical context', async () => {
    const {handler,rateGate,lookup}=setup();rateGate.mockResolvedValue(false);
    expect((await handler(new Request(origin,{headers:{'x-preference-token':token,'x-forwarded-for':'127.0.0.1'}}))).status).toBe(429);
    expect(rateGate).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/));expect(lookup).not.toHaveBeenCalled();
    rateGate.mockRejectedValue(new Error(token));expect((await handler(new Request(origin))).status).toBe(503);
  });
});
