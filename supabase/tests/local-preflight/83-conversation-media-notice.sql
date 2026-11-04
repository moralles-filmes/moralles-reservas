-- 83: pré-voo das RPCs record_conversation_media e claim_conversation_media_notices.
-- Roda como `postgres` depois do 83a e da migration 20261105120000 (README §83).
-- Tudo dentro de uma transação desfeita no fim. Cada caso usa uma conversa nova.
-- `now()` é fixo na transação; as chegadas são relativas a ele e as RPCs usam
-- clock_timestamp(), então as margens (segundos) são folgadas de propósito.
\set ON_ERROR_STOP on
begin;

create function pg_temp.conv(p_msgs jsonb default '[]', p_lock timestamptz default null)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.conversations (id, messages, ai_lock_until) values (v, p_msgs, p_lock);
  return v;
end $$;

-- mensagem do cliente (texto) chegada há p_ago segundos
create function pg_temp.txt(p_ago int, p_content text default 'oi', p_extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('role','user','content',p_content,
    'timestamp', (now() - make_interval(secs => p_ago))::text,
    'received_at', (now() - make_interval(secs => p_ago))::text) || p_extra
$$;

create function pg_temp.media(p_ev text, p_kind text default 'image')
returns jsonb language sql as $$
  select jsonb_build_object('role','user','content','[imagem]','timestamp', now()::text,
    'event_id', p_ev, 'media_kind', p_kind)
$$;

create function pg_temp.msgs(p_id uuid) returns jsonb language sql as $$
  select messages from public.conversations where id = p_id
$$;

create function pg_temp.ok(p_case text, p_cond boolean, p_detail text default '')
returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then
    raise exception 'FALHOU %: %', p_case, p_detail;
  end if;
end $$;

do $$
declare
  c uuid; r jsonb; m jsonb; k text[]; svc text := 'service_role';
begin
  -- 8301: sem texto
  c := pg_temp.conv();
  r := public.record_conversation_media(c, pg_temp.media('e1'), true, 60, 11);
  m := pg_temp.msgs(c);
  perform pg_temp.ok('8301', r = '{"decision":"notice_now","variant":false}'::jsonb, r::text);
  perform pg_temp.ok('8301b', jsonb_array_length(m) = 1 and m->0->>'media_kind' = 'image'
    and m->0->>'media_notice' = 'claimed', m::text);

  -- 8302: texto sem resposta de 3 s e lock livre
  c := pg_temp.conv(jsonb_build_array(pg_temp.txt(3)));
  r := public.record_conversation_media(c, pg_temp.media('e2'), true, 60, 11);
  perform pg_temp.ok('8302', r->>'decision' = 'deferred' and (r->>'variant')::boolean, r::text);
  perform pg_temp.ok('8302b', pg_temp.msgs(c)->1->>'media_notice' = 'deferred', pg_temp.msgs(c)::text);

  -- 8303: texto de 40 s, lock no futuro
  c := pg_temp.conv(jsonb_build_array(pg_temp.txt(40)), now() + interval '30 seconds');
  r := public.record_conversation_media(c, pg_temp.media('e3'), true, 60, 11);
  perform pg_temp.ok('8303', r->>'decision' = 'deferred', r::text);

  -- 8304: texto de 40 s, lock livre
  c := pg_temp.conv(jsonb_build_array(pg_temp.txt(40)));
  r := public.record_conversation_media(c, pg_temp.media('e4'), true, 60, 11);
  perform pg_temp.ok('8304', r->>'decision' = 'notice_now' and (r->>'variant')::boolean, r::text);

  -- 8305: texto respondido há 5 s
  c := pg_temp.conv(jsonb_build_array(
    pg_temp.txt(20),
    jsonb_build_object('role','assistant','content','ola','timestamp',(now() - interval '5 seconds')::text)));
  r := public.record_conversation_media(c, pg_temp.media('e5'), true, 60, 11);
  perform pg_temp.ok('8305', r->>'decision' = 'notice_now' and (r->>'variant')::boolean, r::text);

  -- 8306: aviso proibido
  c := pg_temp.conv();
  r := public.record_conversation_media(c, pg_temp.media('e6'), false, 60, 11);
  perform pg_temp.ok('8306', r->>'decision' = 'suppressed'
    and pg_temp.msgs(c)->0->>'media_notice' = 'none', r::text);

  -- 8307: mesmo event_id duas vezes
  c := pg_temp.conv();
  perform public.record_conversation_media(c, pg_temp.media('dup'), true, 60, 11);
  r := public.record_conversation_media(c, pg_temp.media('dup'), true, 60, 11);
  perform pg_temp.ok('8307', r->>'decision' = 'duplicate' and jsonb_array_length(pg_temp.msgs(c)) = 1, r::text);

  -- 8308: texto literal [imagem] sem media_kind conta como texto
  c := pg_temp.conv(jsonb_build_array(pg_temp.txt(3, '[imagem]')));
  r := public.record_conversation_media(c, pg_temp.media('e8'), true, 60, 11);
  perform pg_temp.ok('8308', r->>'decision' = 'deferred' and (r->>'variant')::boolean, r::text);

  -- 8309: legado sem received_at usa timestamp, sem erro de cast
  c := pg_temp.conv(jsonb_build_array(jsonb_build_object('role','user','content','oi',
    'timestamp', (now() - interval '3 seconds')::text)));
  r := public.record_conversation_media(c, pg_temp.media('e9'), true, 60, 11);
  perform pg_temp.ok('8309', r->>'decision' = 'deferred', r::text);

  -- 8310: claim devolve {image,audio} na ordem e {} na segunda chamada
  c := pg_temp.conv(jsonb_build_array(pg_temp.txt(3)));
  perform public.record_conversation_media(c, pg_temp.media('i1', 'image'), true, 60, 11);
  perform public.record_conversation_media(c, pg_temp.media('a1', 'audio'), true, 60, 11);
  k := public.claim_conversation_media_notices(c, now() - interval '120 seconds');
  perform pg_temp.ok('8310', k = array['image','audio'], k::text);
  k := public.claim_conversation_media_notices(c, now() - interval '120 seconds');
  perform pg_temp.ok('8310b', k = '{}'::text[], k::text);
  perform pg_temp.ok('8310c', not (pg_temp.msgs(c)::text like '%deferred%'), pg_temp.msgs(c)::text);

  -- 8311: p_since = now() - 120 s ignora adiada de 10 min atrás
  c := pg_temp.conv(jsonb_build_array(
    jsonb_build_object('role','user','content','[imagem]','media_kind','image','media_notice','deferred',
      'timestamp', (now() - interval '10 minutes')::text,
      'received_at', (now() - interval '10 minutes')::text)));
  k := public.claim_conversation_media_notices(c, now() - interval '120 seconds');
  perform pg_temp.ok('8311', k = '{}'::text[] and pg_temp.msgs(c)->0->>'media_notice' = 'deferred', k::text);

  -- 8312: ACL, SECURITY DEFINER e search_path vazio
  perform pg_temp.ok('8312a', not has_function_privilege('anon',
    'public.record_conversation_media(uuid,jsonb,boolean,integer,integer)', 'execute'));
  perform pg_temp.ok('8312b', not has_function_privilege('authenticated',
    'public.record_conversation_media(uuid,jsonb,boolean,integer,integer)', 'execute'));
  perform pg_temp.ok('8312c', has_function_privilege(svc,
    'public.record_conversation_media(uuid,jsonb,boolean,integer,integer)', 'execute'));
  perform pg_temp.ok('8312d', not has_function_privilege('anon',
    'public.claim_conversation_media_notices(uuid,timestamptz)', 'execute'));
  perform pg_temp.ok('8312e', not has_function_privilege('authenticated',
    'public.claim_conversation_media_notices(uuid,timestamptz)', 'execute'));
  perform pg_temp.ok('8312f', has_function_privilege(svc,
    'public.claim_conversation_media_notices(uuid,timestamptz)', 'execute'));
  perform pg_temp.ok('8312g', (select bool_and(prosecdef) from pg_proc
      where oid in ('public.record_conversation_media(uuid,jsonb,boolean,integer,integer)'::regprocedure,
                    'public.claim_conversation_media_notices(uuid,timestamptz)'::regprocedure)));
  perform pg_temp.ok('8312h', (select bool_and(proconfig @> array['search_path=""']) from pg_proc
      where oid in ('public.record_conversation_media(uuid,jsonb,boolean,integer,integer)'::regprocedure,
                    'public.claim_conversation_media_notices(uuid,timestamptz)'::regprocedure)));
end $$;

select 'GREEN83' as marcador;
rollback;
