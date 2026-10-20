import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';
import { qualityBlocksTemplate, storeTemplateStatus } from '@/features/whatsapp/template-status';
import { storeTemplateTitle } from '@/features/whatsapp/template-dispatch-versions';

/** Fixed catalog copy is read-only; remote approval never establishes dispatch authority. */
export function TemplateCatalogEntry({ template, audience = 'admin' }: { template: OfficialTemplateView; audience?: 'admin' | 'store' }) {
  const status = storeTemplateStatus(template);
  return <li className="space-y-2 rounded border p-3">
    <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-3">
      <div><span className="font-medium">{audience === 'admin' ? template.name : storeTemplateTitle(template.logicalId)}</span>{audience === 'admin' && <span className="ml-2 text-muted-foreground">Versão {template.version}</span>}</div>
      <span>{status}</span>
    </div>
    <p className="whitespace-pre-wrap break-words">{template.body}</p>
    {template.footer && <p className="whitespace-pre-wrap break-words text-muted-foreground">{template.footer}</p>}
    {template.remoteStatus === 'APPROVED' && qualityBlocksTemplate(template) && <p className="text-muted-foreground">Estado na Meta: aprovado. A qualidade atual exige revisão antes do envio.</p>}
    {template.localStatus === 'usable' && status !== 'Aprovado pela Meta' && <p className="text-muted-foreground">A aprovação da Meta só é utilizável após conferir conteúdo, categoria, qualidade e sincronização atual.</p>}
    <p className="text-muted-foreground">A aprovação pela Meta não ativa automações. Liberação, ajustes e condições da mensagem são conferidos antes do envio.</p>
  </li>;
}
