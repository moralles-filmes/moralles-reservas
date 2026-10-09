import { useState } from "react";
import { useParams } from "react-router-dom";
import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { z } from "zod";
import { useAuth } from "@/hooks/useAuth";
import { useWhatsappTemplates, useConsentContactLookup, useIndividualConsent, templateErrorMessage, type ConsentPurpose, type ExistingConsentContact } from "@/hooks/useWhatsappTemplates";
import { TemplateStatus } from "@/components/whatsapp/OfficialAutomationTemplate";
import { canonicalBrPhone, isValidBrPhone } from "@/lib/phone";
import { formatPhone } from "@/lib/utils";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import {
  useGiftbackSettings,
  useUpdateGiftbackSettings,
  renderGiftbackTemplate,
  DEFAULT_GIFTBACK_TEMPLATE,
  type GiftbackSettings,
} from "@/hooks/useGiftbackSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Gift, RotateCcw } from "lucide-react";

const VARIABLE_CHIPS = [
  { var: "{{discount}}", desc: "Percentual do desconto" },
  { var: "{{codigo}}", desc: "Código do voucher (ex: ABC12345)" },
  { var: "{{validade}}", desc: "Data de validade (DD/MM/AAAA)" },
  { var: "{{unidade}}", desc: "Nome da unidade" },
];

export default function Ajustes() {
  const unit = useCurrentUnit();
  const { unitSlug } = useParams();
  if (!unit || unit.unit_slug !== unitSlug) return <p role="status">Carregando unidade…</p>;
  return <AjustesDaUnidade key={unit.unit_id} unit={unit} />;
}
function AjustesDaUnidade({ unit }: { unit: NonNullable<ReturnType<typeof useCurrentUnit>> }) {
  const unitId = unit.unit_id;
  const { isPlatformAdmin } = useAuth();
  const controls = useWhatsappTemplates(unitId, unit.role, isPlatformAdmin);
  const settingsQuery = useGiftbackSettings(unitId);
  const { data, isLoading } = settingsQuery;

  const update = useUpdateGiftbackSettings(unitId);
  const [draft, setDraft] = useState<Partial<GiftbackSettings>>({});
  const whatsapp = draft.giftback_whatsapp_enabled ?? data?.giftback_whatsapp_enabled ?? true;
  const email = draft.giftback_email_enabled ?? data?.giftback_email_enabled ?? false;
  const template = draft.giftback_message_template ?? data?.giftback_message_template ?? '';
  const setWhatsapp = (value: boolean) => setDraft(prev => ({ ...prev, giftback_whatsapp_enabled: value }));
  const setEmail = (value: boolean) => setDraft(prev => ({ ...prev, giftback_email_enabled: value }));
  const setTemplate = (value: string | ((previous: string) => string)) => setDraft(prev => ({ ...prev, giftback_message_template: typeof value === 'function' ? value(template) : value }));
  const official = controls.query.data?.mode === 'official';
  const textMode = controls.query.data?.mode === 'unofficial' && !controls.query.isError;
  const canSave = controls.canManage && !controls.query.isError && !controls.query.isFetching && (official || textMode) && !settingsQuery.isError;

  const dirty =
    !!data &&
    (whatsapp !== data.giftback_whatsapp_enabled ||
      email !== data.giftback_email_enabled ||
      (textMode && template !== data.giftback_message_template));

  const save = () => {
    if (!canSave || !dirty || update.isPending) return;
    update.mutate({
      giftback_whatsapp_enabled: whatsapp,
      giftback_email_enabled: email,
      ...(textMode ? { giftback_message_template: template } : {}),
    });
  };

  const preview = renderGiftbackTemplate(template || DEFAULT_GIFTBACK_TEMPLATE, {
    discount: 15,
    codigo: "ABC12345",
    validade: "30/06/2026",
    unidade: unit?.unit_name ?? "Restaurante",
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (settingsQuery.isError) return <div role="alert"><p>Não foi possível carregar os ajustes.</p><Button className="min-h-11" onClick={() => void settingsQuery.refetch()}>Tentar novamente</Button></div>;

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5 text-gold" />
          <h1 className="text-2xl font-bold">Ajustes do Giftback</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Configure por onde o cliente recebe o voucher e como a mensagem é apresentada.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Canais de envio</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="giftback-whatsapp" className="inline-flex min-h-11 min-w-11 items-center text-sm font-medium">WhatsApp</Label>
              <p className="text-xs text-muted-foreground">
                Envia o código do voucher pela conversa do WhatsApp ativa.
              </p>
            </div>
            <Switch id="giftback-whatsapp" checked={whatsapp} onCheckedChange={setWhatsapp} disabled={!canSave} />
          </div>
          <div className="flex items-center justify-between rounded-md border p-3 opacity-60">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">E-mail</Label>
              <p className="text-xs text-muted-foreground">
                Envio por e-mail (Resend) chega em uma fase futura.
              </p>
            </div>
            <Switch aria-label="E-mail" checked={email} onCheckedChange={setEmail} disabled />
          </div>
        </CardContent>
      </Card>

      <TemplateStatus controls={controls} logicalIds={['mkt_voucher_programado_v1']} />
      {official && <p className="text-sm text-muted-foreground">O modelo oficial é usado nos vouchers programados. A mensagem personalizada de voucher após avaliação é preservada.</p>}
      {textMode && <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Template da mensagem</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTemplate(DEFAULT_GIFTBACK_TEMPLATE)}
            className="gap-1.5 min-h-11"
            disabled={!canSave}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restaurar padrão
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            aria-label="Mensagem"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={8}
            disabled={!canSave}
            className="font-mono text-sm"
          />
          <div>
            <p className="text-xs font-medium mb-1.5">Variáveis disponíveis:</p>
            <div className="flex flex-wrap gap-1.5">
              {VARIABLE_CHIPS.map((chip) => (
                <button
                  key={chip.var}
                  type="button"
                  onClick={() => setTemplate((t) => `${t}${chip.var}`)}
                  className="min-h-11 text-xs font-mono px-2 py-1 bg-muted hover:bg-muted/70 rounded border"
                  disabled={!canSave}
                  title={chip.desc}
                >
                  {chip.var}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-md bg-success/10 border border-success/20 p-3 text-sm whitespace-pre-wrap">
            <p className="text-[11px] uppercase tracking-wider text-success font-medium mb-1.5">
              Pré-visualização
            </p>
            {preview}
          </div>
        </CardContent>
      </Card>}

      <div className="flex justify-end">
        <Button className="min-h-11" onClick={save} disabled={!canSave || !dirty || update.isPending}>
          {update.isPending ? "Salvando…" : official ? "Salvar configuração" : "Salvar alterações"}
        </Button>
      </div>
      <IndividualConsent unitId={unitId} organizationId={unit.organization_id} canManage={controls.canManage} />
    </div>
  );
}

function IndividualConsent({ unitId, organizationId, canManage }: { unitId: string; organizationId: string; canManage: boolean }) {
  const [phone, setPhone] = useState('');
  const [lookup, setLookup] = useState<{ nonce: string; phone: string } | null>(null);
  const [invalidPhone, setInvalidPhone] = useState(false);
  const [selected, setSelected] = useState<ExistingConsentContact | null>(null);
  const [purpose, setPurpose] = useState<ConsentPurpose>('promotional');
  const query = useConsentContactLookup(unitId, organizationId, lookup, canManage);
  if (!canManage) return null;
  return <Card className="p-4 space-y-4">
    <h2 className="text-lg font-semibold">Consentimento individual</h2>
    <p className="text-sm text-muted-foreground">Registre a escolha expressa de um contato já cadastrado. Informe apenas a referência da evidência; não cole conversas, senhas ou links de preferência.</p>
    <form className="space-y-2" onSubmit={event => {
      event.preventDefault(); const canonical = canonicalBrPhone(phone);
      setSelected(null); setInvalidPhone(!isValidBrPhone(canonical));
      setLookup(isValidBrPhone(canonical) ? { nonce: crypto.randomUUID(), phone: canonical } : null);
    }}>
      <Label htmlFor="consent-phone">Telefone do contato com DDD</Label>
      <div className="flex flex-col sm:flex-row gap-2"><Input id="consent-phone" type="tel" className="min-h-11" value={phone} onChange={event => setPhone(event.target.value)} aria-invalid={invalidPhone} /><Button className="min-h-11" type="submit" disabled={query.isFetching}>Buscar contato</Button></div>
      {invalidPhone && <p role="alert">Confira o telefone com DDD.</p>}
    </form>
    {lookup && query.isPending && <p role="status">Buscando contato…</p>}
    {lookup && query.isError && <div role="alert"><p>Não foi possível buscar o contato.</p><Button className="min-h-11" onClick={() => void query.refetch()}>Repetir busca</Button></div>}
    {lookup && query.isSuccess && query.data === null && <p role="status">Contato não encontrado.</p>}
    {lookup && query.isSuccess && query.data && !selected && <Button className="min-h-11 h-auto whitespace-normal" variant="outline" onClick={() => setSelected(query.data)}>Selecionar {query.data.name} · {formatPhone(query.data.phone)}</Button>}
    {selected && <>
      <p className="text-sm">Contato selecionado: <strong>{selected.name}</strong> · {formatPhone(selected.phone)}</p>
      <Label htmlFor="consent-purpose">Finalidade</Label>
      <select id="consent-purpose" className="w-full min-h-11 border rounded-md bg-background px-3" value={purpose} onChange={event => setPurpose(event.target.value as ConsentPurpose)}><option value="promotional">Ofertas e promoções</option><option value="operational">Mensagens operacionais</option></select>
      <ConsentEvidence key={`${selected.id}:${purpose}`} unitId={unitId} customerId={selected.id} purpose={purpose} canManage={canManage} />
    </>}
  </Card>;
}
const evidenceSchema = z.object({
  decision: z.enum(['opt_in', 'opt_out'], { error: 'Escolha a decisão do contato.' }),
  source_code: z.enum(['customer_message', 'signed_form', 'in_person'], { error: 'Escolha a origem da evidência.' }),
  observed_at: z.string().min(1, 'Informe a data da escolha.').refine(value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now(), 'Informe uma data válida, que não esteja no futuro.'),
  evidence_reference: z.string().trim().min(1, 'Informe uma referência da evidência.').max(512, 'Use até 512 caracteres.').refine(value => !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) && !value.includes('/preferencias/mensagens/'), 'Use uma referência curta, sem conversa ou link de preferência.'),
  confirmed: z.boolean().refine(Boolean, 'Confirme que esta é a escolha expressa do contato.'),
});
type EvidenceFields = z.infer<typeof evidenceSchema>;
// The installed resolver expects Zod 3's error.errors; this schema uses Zod 4.
// All six fields are flat, so keep their safeParse errors inside this form.
const evidenceResolver: Resolver<EvidenceFields> = async values => {
  const result = evidenceSchema.safeParse(values);
  if (result.success) return { values: result.data, errors: {} };
  const errors: FieldErrors<EvidenceFields> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof EvidenceFields;
    if (Object.prototype.hasOwnProperty.call(evidenceSchema.shape, field) && !errors[field]) {
      errors[field] = { type: issue.code, message: issue.message };
    }
  }
  return { values: {}, errors };
};
function ConsentEvidence({ unitId, customerId, purpose, canManage }: { unitId: string; customerId: string; purpose: ConsentPurpose; canManage: boolean }) {
  const { query, record } = useIndividualConsent(unitId, customerId, purpose, canManage);
  const { register, handleSubmit, formState: { errors }, resetField } = useForm<EvidenceFields>({ resolver: evidenceResolver, defaultValues: { observed_at: '', evidence_reference: '', confirmed: false } });
  const submit = handleSubmit(values => {
    if (record.isPending || !canManage || query.isError || query.isPending) return;
    record.mutate({ decision: values.decision, source_code: values.source_code, observed_at: new Date(values.observed_at).toISOString(), evidence_reference: values.evidence_reference }, { onSuccess: () => resetField('confirmed') });
  });
  return <div className="space-y-4">
    {query.isPending ? <p role="status">Consultando escolha atual…</p> : query.isError ? <div role="alert"><p>Estado atual indisponível.</p><Button className="min-h-11" onClick={() => void query.refetch()}>Consultar novamente</Button></div> : <p role="status">Escolha atual: {query.data.status === 'unknown' ? 'nenhuma escolha registrada' : query.data.status === 'opt_in' ? 'autorizou esta finalidade' : 'recusou esta finalidade'}.</p>}
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2"><Label htmlFor="consent-decision">Decisão do contato</Label><select id="consent-decision" className="w-full min-h-11 border rounded-md bg-background px-3" {...register('decision')} aria-invalid={!!errors.decision}><option value="">Selecione</option><option value="opt_in">Autorizou</option><option value="opt_out">Recusou</option></select>{errors.decision && <p role="alert">{errors.decision.message}</p>}</div>
        <div className="space-y-2"><Label htmlFor="consent-source">Origem da evidência</Label><select id="consent-source" className="w-full min-h-11 border rounded-md bg-background px-3" {...register('source_code')} aria-invalid={!!errors.source_code}><option value="">Selecione</option><option value="customer_message">Mensagem do cliente</option><option value="signed_form">Formulário assinado</option><option value="in_person">Presencial</option></select>{errors.source_code && <p role="alert">{errors.source_code.message}</p>}</div>
      </div>
      <div className="space-y-2"><Label htmlFor="consent-date">Data e hora da escolha</Label><Input id="consent-date" className="min-h-11" type="datetime-local" {...register('observed_at')} aria-invalid={!!errors.observed_at} />{errors.observed_at && <p role="alert">{errors.observed_at.message}</p>}</div>
      <div className="space-y-2"><Label htmlFor="consent-reference">Referência da evidência</Label><Input id="consent-reference" className="min-h-11" {...register('evidence_reference')} aria-invalid={!!errors.evidence_reference} />{errors.evidence_reference && <p role="alert">{errors.evidence_reference.message}</p>}</div>
      <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" {...register('confirmed')} />Confirmo a escolha expressa deste contato para esta finalidade.</label>
      {errors.confirmed && <p role="alert">{errors.confirmed.message}</p>}
      <Button className="min-h-11" type="submit" disabled={record.isPending || query.isPending || query.isError || query.isFetching}>{record.isPending ? 'Registrando…' : 'Registrar escolha'}</Button>
      {record.isError && <p role="alert">{templateErrorMessage(record.error)}</p>}
      {record.isSuccess && <p role="status">Registro recebido. A escolha atual é a exibida após a consulta.</p>}
    </form>
  </div>;
}
