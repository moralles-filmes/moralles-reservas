import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

const recognizedErrors = new Set(['unauthorized', 'forbidden', 'configuration_changed', 'not_eligible', 'dependency_unavailable']);

function closedError(code?: unknown): Error {
  return new Error(typeof code === 'string' && recognizedErrors.has(code) ? code : 'dependency_unavailable');
}

export async function requestServicePreference(body: Record<string, unknown>): Promise<unknown> {
  try {
    const { data, error } = await supabase.functions.invoke('manage-whatsapp-templates', { body });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const response = await error.context.json().catch(() => null);
        throw closedError(response?.error);
      }
      throw closedError();
    }
    return data;
  } catch (error) { throw closedError(error instanceof Error ? error.message : undefined); }
}
