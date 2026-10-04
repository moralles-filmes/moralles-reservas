import { parseDatafyAccount } from './datafy-client.ts';
import type { ChannelCredentials, WhatsAppProviderAdapter } from './whatsapp-provider-core.ts';

export interface TemplateChannel {
  id: string;
  unit_id: string;
  provider: string;
  template_credential_revision: number;
  credentials: ChannelCredentials;
}
export interface VerifiedTemplateBindingInput {
  channelId: string;
  unitId: string;
  provider: string;
  credentialRevision: number;
  phoneNumberId: string;
  wabaId: string;
}
export interface TemplateAccountRef { accountId: string; generation: number; }
export interface TemplateAccountDependencies {
  loadChannel(channelId: string): Promise<TemplateChannel | null>;
  getProvider(provider: string): Pick<WhatsAppProviderAdapter, 'cloudApiRequest'> & {
    capabilities: Pick<WhatsAppProviderAdapter['capabilities'], 'templateManagement'>;
  };
  bind(input: VerifiedTemplateBindingInput): Promise<TemplateAccountRef>;
}

/** Caller authorizes channel access first; SQL revalidates unit/provider/revision and WABA ownership. */
export function createTemplateAccountService(deps: TemplateAccountDependencies) {
  return {
    async ensureTemplateAccount(channelId: string): Promise<TemplateAccountRef> {
      const channel = await deps.loadChannel(channelId);
      if (!channel) throw new Error('template_account_unavailable');
      const adapter = deps.getProvider(channel.provider);
      if (!adapter.capabilities.templateManagement || !adapter.cloudApiRequest) {
        throw new Error('template_account_unsupported');
      }
      // The currently supported management adapter exposes Datafy's fixed-origin /me contract.
      const response = await adapter.cloudApiRequest(channel.credentials, { method: 'GET', path: 'me' });
      const discovery = response.status >= 200 && response.status < 300 ? parseDatafyAccount(response.body) : null;
      if (!discovery?.wabaId || !/^\d{1,64}$/.test(discovery.wabaId)
        || discovery.phoneNumberId !== channel.credentials.phone_number_id) {
        throw new Error('template_account_unavailable');
      }
      return deps.bind({ channelId: channel.id, unitId: channel.unit_id, provider: channel.provider,
        credentialRevision: channel.template_credential_revision,
        phoneNumberId: discovery.phoneNumberId!, wabaId: discovery.wabaId });
    },
  };
}
