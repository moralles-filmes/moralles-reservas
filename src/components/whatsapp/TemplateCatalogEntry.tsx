import type { OfficialTemplateView } from '@/hooks/useWhatsappTemplates';
import { storeTemplateStatus } from '@/features/whatsapp/template-status';

/** Fixed catalog copy is read-only; remote approval never establishes dispatch authority. */
export function TemplateCatalogEntry({ template }: { template: OfficialTemplateView }) {
  const status = storeTemplateStatus(template);
  return <li className="space-y-2 rounded border p-3">
    <div className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-3">
      <div><span className="font-medium">{template.name}</span><span className="ml-2 text-muted-foreground">Versão {template.version}</span></div>
      <span>{status}</span>
    </div>
    <p className="whitespace-pre-wrap break-words">{template.body}</p>
    {template.footer && <p className="whitespace-pre-wrap break-words text-muted-foreground">{template.footer}</p>}
    {template.localStatus === 'usable' && status !== 'Aprovado pela Meta' && <p className="text-muted-foreground">A aprovação da Meta só é utilizável após conferir conteúdo, categoria, qualidade e sincronização atual.</p>}
    {template.version === 2 && <p className="text-muted-foreground">A versão 2 não está habilitada para envio automático. A aprovação pela Meta não ativa automações.</p>}
  </li>;
}
