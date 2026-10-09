import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTemplateRuntime } from '../_shared/whatsapp-template-runtime.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const worker = createTemplateRuntime(db);
Deno.serve(worker.handle);
