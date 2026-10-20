import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useForm, type FieldErrors } from "react-hook-form";
import { Megaphone } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { draftInputSchema, isMarketingConflict, marketingErrorMessage, PROGRAMS, RESULT_PROGRAMS, type DraftInput, type MarketingDraft, type MarketingDrafts, type MarketingProgram } from "@/features/marketing/api";
import { isMarketingPeriodValid, useMarketingDrafts, useMarketingMutations, useMarketingResults } from "@/features/marketing/hooks";
import { useWaitlistSettings } from "@/hooks/useWaitlistSettings";
import { useWhatsappDispatchStatus } from "@/hooks/useWhatsappDispatchStatus";
import { storeDispatchStatusLabels } from "@/features/whatsapp/template-dispatch-versions";
import { formatDateBR } from "@/lib/utils";

export default function Marketing() {
  const unit = useCurrentUnit();
  const { unitSlug } = useParams();
  const { isPlatformAdmin } = useAuth();
  if (!unit || unit.unit_slug !== unitSlug) return <Skeleton className="h-32 w-full" />;
  if (!unit.isGerente && !isPlatformAdmin) return <p role="alert">Você não tem acesso ao Marketing desta unidade.</p>;
  // A keyed subtree discards forms and filters when the route changes units.
  return <MarketingUnit key={unit.unit_id} unitId={unit.unit_id} slug={unit.unit_slug} canEdit={unit.isOwner && !isPlatformAdmin} />;
}

function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return <div role="alert" className="space-y-3 rounded-lg border p-4"><p>{marketingErrorMessage(error)}</p><Button variant="outline" onClick={retry}>Tentar novamente</Button></div>;
}

function hasCompatibleRule(program: MarketingProgram, ruleId: string | null, rules: MarketingDrafts["rules"]) {
  return rules.some((rule) => rule.id === ruleId && rule.trigger_type === (program === "birthday_voucher" ? "birthday" : "frequency"));
}

function MarketingUnit({ unitId, slug, canEdit }: { unitId: string; slug: string; canEdit: boolean }) {
  const { section } = useParams();
  const results = section === "resultados";
  return <div className="min-w-0 space-y-5">
    <header><h1 className="flex items-center gap-2 text-2xl font-bold"><Megaphone className="h-5 w-5 text-gold" />Marketing</h1><p className="mt-1 text-sm text-muted-foreground">Planeje programas em rascunho e acompanhe o histórico da unidade.</p></header>
    <nav aria-label="Marketing" className="flex flex-wrap gap-2">
      <Button asChild variant={results ? "outline" : "default"}><Link aria-current={!results ? "page" : undefined} to={`/g/${slug}/marketing/campanhas`}>Campanhas</Link></Button>
      <Button asChild variant={results ? "default" : "outline"}><Link aria-current={results ? "page" : undefined} to={`/g/${slug}/marketing/resultados`}>Resultados</Link></Button>
    </nav>
    <div className="rounded-lg border bg-muted/40 p-4 text-sm space-y-2">
      <p>Esta área salva apenas rascunhos. Regras já ativas continuam seus fluxos existentes independentemente destes planos.</p>
      <p>Consentimento será conferido individualmente para cada destinatário em eventual envio futuro. Custo Meta não apurado.</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2"><Link className="underline" to={`/g/${slug}/giftback/regras`}>Configurações do Giftback</Link><Link className="underline" to={`/g/${slug}/whatsapp`}>Configurações do WhatsApp</Link></div>
    </div>
    {results ? <Results unitId={unitId} /> : <Campaigns unitId={unitId} canEdit={canEdit} />}
  </div>;
}

function Campaigns({ unitId, canEdit }: { unitId: string; canEdit: boolean }) {
  const query = useMarketingDrafts(unitId);
  const waitlistSettings = useWaitlistSettings(unitId);
  const dispatchStatus = useWhatsappDispatchStatus(unitId);
  const mutations = useMarketingMutations(unitId);
  const [selection, setSelection] = useState<{ program: MarketingProgram; draft?: MarketingDraft } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<MarketingDraft | null>(null);
  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (query.isError) return <Failure error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return null;
  const data = query.data;
  return <div className="space-y-5">
    {!canEdit && <p className="text-sm text-muted-foreground">Consulta de rascunhos. Somente o proprietário da unidade pode editar.</p>}
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">{(Object.keys(PROGRAMS) as MarketingProgram[]).map((program) => {
      const rules = data.rules.filter((rule) => rule.trigger_type === (program === "birthday_voucher" ? "birthday" : "frequency"));
      const activeRules = rules.filter((rule) => rule.active);
      const dispatchEntry = dispatchStatus.data?.entries.find((entry) => entry.kind === (program === "waitlist_feedback" ? "waitlist_feedback" : "voucher_issued"));
      return <Card key={program} className="min-w-0"><CardHeader><CardTitle className="text-base">{PROGRAMS[program].title}</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p>{PROGRAMS[program].description}</p><p className="text-muted-foreground">{program === "waitlist_feedback" ? waitlistSettings.isSuccess ? `Pesquisa pós-fila atual: ${waitlistSettings.data.waitlist_feedback_enabled ? "habilitada" : "desabilitada"}.` : "Configuração da pesquisa pós-fila: indisponível." : rules.length ? `${activeRules.length} regra(s) Giftback ativa(s); ${rules.length - activeRules.length} inativa(s).` : "Sem regra Giftback compatível. Configure uma regra para vinculá-la."}</p>
        <p className="text-muted-foreground">Aviso oficial existente: {dispatchStatus.isSuccess && dispatchEntry ? storeDispatchStatusLabels[dispatchEntry.readiness] : "estado indisponível"}. Esta leitura não libera o rascunho.</p>
        {canEdit && <Button variant="outline" className="min-h-11 w-full whitespace-normal" onClick={() => setSelection({ program })}>Planejar rascunho</Button>}
      </CardContent></Card>;
    })}</div>
    {selection && canEdit && <DraftForm key={selection.draft?.id ?? selection.program} program={selection.program} draft={selection.draft} rules={data.rules} pending={mutations.save.isPending} onCancel={() => setSelection(null)} onSave={async (input) => {
      try { await mutations.save.mutateAsync({ input, draft: selection.draft }); toast.success("Rascunho salvo."); setSelection(null); }
      catch (error) { if (isMarketingConflict(error)) { await query.refetch(); setSelection(null); } toast.error(marketingErrorMessage(error)); }
    }} />}
    <h2 className="text-lg font-semibold">Rascunhos da unidade</h2>
    {!data.drafts.length ? <Card><CardContent className="py-10 text-center text-muted-foreground">Nenhum rascunho criado nesta unidade.</CardContent></Card> : <div className="space-y-3">{data.drafts.map((draft) => <Card key={draft.id}><CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1"><h3 className="font-semibold break-words">{draft.title}</h3><p className="text-sm">{PROGRAMS[draft.program].title} · {draft.status === "archived" ? "Arquivado" : "Rascunho"}</p><p className="text-sm text-muted-foreground">{draft.program === "waitlist_feedback" ? "Pesquisa após a fila" : hasCompatibleRule(draft.program, draft.voucher_rule_id, data.rules) ? data.rules.find((rule) => rule.id === draft.voucher_rule_id)?.name : "Regra removida ou alterada — selecione outra regra para este rascunho"}</p><p className="text-sm text-muted-foreground">Período pretendido: {draft.start_date ? formatDateBR(draft.start_date) : "sem início definido"} até {draft.end_date ? formatDateBR(draft.end_date) : "sem fim definido"}.</p><p className="text-sm text-muted-foreground">Proposta diária: {draft.proposed_daily_contacts ?? "—"} contatos · {draft.proposed_daily_messages ?? "—"} mensagens.</p><p className="text-sm text-muted-foreground">Ainda sem execução por este módulo</p></div>
      {canEdit && draft.status === "draft" && <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setSelection({ program: draft.program, draft })}>Editar rascunho</Button><Button variant="ghost" onClick={() => setArchiveTarget(draft)}>Arquivar</Button></div>}
    </CardContent></Card>)}</div>}
    {archiveTarget && canEdit && <Card role="region" aria-label="Confirmar arquivamento"><CardContent className="space-y-3 py-4"><p>Arquivar o rascunho “{archiveTarget.title}”?</p><p className="text-sm text-muted-foreground">As regras e os fluxos existentes continuam como estão.</p><div className="flex flex-wrap gap-2"><Button disabled={mutations.archive.isPending} onClick={async () => {
      try { await mutations.archive.mutateAsync(archiveTarget); toast.success("Rascunho arquivado."); setArchiveTarget(null); setSelection(null); } catch (error) { toast.error(marketingErrorMessage(error)); }
    }}>Confirmar arquivamento</Button><Button variant="outline" disabled={mutations.archive.isPending} onClick={() => setArchiveTarget(null)}>Cancelar</Button></div></CardContent></Card>}
  </div>;
}

function DraftForm({ program, draft, rules, pending, onSave, onCancel }: { program: MarketingProgram; draft?: MarketingDraft; rules: MarketingDrafts["rules"]; pending: boolean; onSave: (input: DraftInput) => Promise<void>; onCancel: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<DraftInput>({ resolver: (values) => { const parsed = draftInputSchema.safeParse(values); if (parsed.success) return { values: parsed.data, errors: {} }; const errors: FieldErrors<DraftInput> = {}; for (const issue of parsed.error.issues) { const field = issue.path[0] as keyof DraftInput; errors[field] = { type: "validate", message: issue.message }; } return { values: {}, errors }; }, defaultValues: {
    program, voucher_rule_id: draft && hasCompatibleRule(program, draft.voucher_rule_id, rules) ? draft.voucher_rule_id : null, title: draft?.title ?? PROGRAMS[program].title, start_date: draft?.start_date ?? null, end_date: draft?.end_date ?? null, proposed_daily_contacts: draft?.proposed_daily_contacts ?? null, proposed_daily_messages: draft?.proposed_daily_messages ?? null,
  } });
  const compatible = rules.filter((rule) => rule.trigger_type === (program === "birthday_voucher" ? "birthday" : "frequency"));
  return <Card><CardHeader><CardTitle>{draft ? "Editar rascunho" : "Novo rascunho"}</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={handleSubmit(onSave)}>
    <fieldset disabled={pending} className="space-y-4">
      {draft && program !== "waitlist_feedback" && !hasCompatibleRule(program, draft.voucher_rule_id, rules) && <p role="status" className="text-sm text-muted-foreground">Regra removida ou alterada — selecione outra regra para este rascunho</p>}
      <div className="space-y-1"><Label htmlFor="draft-title">Nome do rascunho</Label><Input id="draft-title" className="h-12" {...register("title")} /></div>
      {program !== "waitlist_feedback" && <div className="space-y-1"><Label htmlFor="draft-rule">Regra Giftback</Label><select id="draft-rule" className="h-12 w-full min-w-0 rounded-md border bg-background px-3 text-sm" {...register("voucher_rule_id", { setValueAs: (value) => value || null })}><option value="">Escolha uma regra</option>{compatible.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} ({rule.active ? "ativa" : "inativa"})</option>)}</select></div>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="draft-start">Início pretendido (opcional)</Label><Input id="draft-start" type="date" className="h-12" {...register("start_date", { setValueAs: (value) => value || null })} /></div><div className="space-y-1"><Label htmlFor="draft-end">Fim pretendido (opcional)</Label><Input id="draft-end" type="date" className="h-12" {...register("end_date", { setValueAs: (value) => value || null })} /></div></div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{(["proposed_daily_contacts", "proposed_daily_messages"] as const).map((key) => <div className="space-y-1" key={key}><Label htmlFor={key}>{key === "proposed_daily_contacts" ? "Contatos propostos por dia" : "Mensagens propostas por dia"} (opcional)</Label><Input id={key} type="number" min={1} max={100000} className="h-12" {...register(key, { setValueAs: (value) => value == null || value === "" ? null : Number(value) })} /></div>)}</div>
      <p className="text-sm text-muted-foreground">Datas e volumes são apenas planejamento. Estes limites propostos não controlam envios nem autorizam gastos.</p>
      {Object.keys(errors).length > 0 && <p role="alert" className="text-sm text-destructive">Revise os campos. Informe um nome, uma regra compatível, datas válidas e volumes inteiros entre 1 e 100.000.</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={program !== "waitlist_feedback" && !compatible.length}>{pending ? "Salvando…" : "Salvar rascunho"}</Button><Button type="button" variant="outline" onClick={onCancel}>Cancelar</Button></div>
    </fieldset>
  </form></CardContent></Card>;
}

function Results({ unitId }: { unitId: string }) {
  const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const datePart = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const today = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [program, setProgram] = useState<keyof typeof RESULT_PROGRAMS | "all">("all");
  const [rule, setRule] = useState("all");
  const query = useMarketingResults(unitId, from, to);
  const data = query.data;
  const giftback = data?.giftback.filter((row) => (program === "all" || row.program === program) && (rule === "all" || (rule === "unlinked" ? row.rule_id === null : row.rule_id === rule))) ?? [];
  const managed = data?.managed.filter((row) => (program === "all" || row.program === program) && (row.program === "waitlist_feedback" || rule === "all" || (rule === "unlinked" ? row.rule_id === null : row.rule_id === rule))) ?? [];
  const availableRules = Array.from(new Map([
    ...(data?.giftback ?? []).filter((row) => row.rule_id).map((row) => [row.rule_id!, row.rule_name] as const),
    ...(data?.managed ?? []).filter((row) => row.program === "giftback_rule" && row.rule_id).map((row) => [row.rule_id!, row.rule_name] as const),
  ]).entries());
  const channels = [
    { kind: "official", title: "WhatsApp oficial gerenciado", description: "Modelos oficiais por Meta Cloud API ou Datafy." },
    { kind: "text", title: "Outros canais gerenciados", description: "Mensagens de texto por provedores não oficiais; série separada dos modelos oficiais." },
    { kind: "unbound", title: "Canal ainda não definido", description: "Intenções anteriores à definição do canal; não representam envio." },
  ] as const;
  return <div className="space-y-5">
    <h2 className="text-lg font-semibold">Histórico dos programas existentes</h2><p className="text-sm text-muted-foreground">Estes resultados não são atribuídos aos rascunhos. A classificação histórica por aniversário ou frequência não é verificável, pois o gatilho de uma regra pode mudar. O Giftback é agrupado pela regra vinculada ao voucher. Período civil de Brasília; a coorte considera a emissão no período e o uso conhecido até a consulta.</p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"><div><Label htmlFor="results-from">De</Label><Input id="results-from" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setRule("all"); }} /></div><div><Label htmlFor="results-to">Até</Label><Input id="results-to" type="date" value={to} onChange={(event) => { setTo(event.target.value); setRule("all"); }} /></div><div><Label htmlFor="results-program">Programa</Label><select id="results-program" className="h-10 w-full rounded-md border bg-background px-2 text-sm" value={program} onChange={(event) => { setProgram(event.target.value as keyof typeof RESULT_PROGRAMS | "all"); setRule("all"); }}><option value="all">Todos os programas</option>{Object.entries(RESULT_PROGRAMS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></div><div><Label htmlFor="results-rule">Regra Giftback</Label><select id="results-rule" className="h-10 w-full rounded-md border bg-background px-2 text-sm" value={rule} disabled={program === "waitlist_feedback"} onChange={(event) => setRule(event.target.value)}><option value="all">Todas as regras</option><option value="unlinked">Sem regra vinculada</option>{availableRules.map(([ruleId, ruleName]) => <option key={ruleId} value={ruleId}>{ruleName ?? "Regra removida"}</option>)}</select></div></div>
    {!isMarketingPeriodValid(from, to) ? <p role="alert">Escolha um período válido de até 366 dias.</p> : query.isLoading ? <Skeleton className="h-48 w-full" /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : data && <>
      <p className="text-xs text-muted-foreground">Fontes: vouchers do Giftback, intenções e recibos gerenciados por canal, histórico legado. Consulta atualizada em {new Date(query.dataUpdatedAt).toLocaleString("pt-BR")}.</p>
      {data.unknown_giftback_source && <p role="status" className="rounded-lg border p-3 text-sm">Há vouchers sem regra vinculada. Sua origem não pode ser atribuída a um programa com segurança.</p>}
      {program !== "waitlist_feedback" && <><h3 className="font-semibold">Giftback por regra</h3><p className="text-sm text-muted-foreground">Nomes de regras refletem o cadastro atual; não comprovam o gatilho histórico.</p>
      {!giftback.length ? <p className="text-sm text-muted-foreground">Nenhum resultado Giftback para os filtros escolhidos.</p> : giftback.map((row) => <Card key={`${row.program}-${row.rule_id}`}><CardHeader><CardTitle className="text-base break-words">{RESULT_PROGRAMS[row.program]} · {row.rule_name ?? "Sem regra vinculada"}</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric title="Emitidos no período" value={row.issued} /><Metric title="Resgatados da coorte" value={row.redeemed_cohort} /><Metric title="Taxa de resgate da coorte" value={row.issued ? `${(row.redeemed_cohort / row.issued * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : null} /><Metric title="Resgates no período" value={row.redeemed_in_period} /></dl></CardContent></Card>)}
      </>}<p className="text-sm text-muted-foreground">O período gerenciado considera a data do fato que originou a intenção. Aceite pelo provedor não significa entrega. Entregas e leituras exigem recibos correlacionados. Dados recentes podem mudar com recibos e resgates posteriores.</p>
      {!data.managed_available ? <p role="status" className="rounded-lg border p-4">Métricas gerenciadas indisponíveis para este período. Histórico retido a partir de {formatDateBR(data.retention_start.slice(0, 10))}; selecione um período coberto.</p> : !managed.length ? <p className="text-sm text-muted-foreground">Nenhuma intenção gerenciada para os filtros escolhidos.</p> : channels.map((channel) => {
        const rows = managed.filter((row) => row.channel_kind === channel.kind);
        return rows.length ? <section key={channel.kind} className="space-y-3"><h3 className="font-semibold">{channel.title}</h3><p className="text-sm text-muted-foreground">{channel.description}</p>{rows.map((row, index) => <Card key={`${row.program}-${row.rule_id}-${index}`}><CardHeader><CardTitle className="text-base break-words">{RESULT_PROGRAMS[row.program]}{row.program === "giftback_rule" ? ` · ${row.rule_name ?? "Sem regra vinculada"}` : ""}</CardTitle></CardHeader><CardContent><dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric title="Intenções únicas" value={row.intentions} /><Metric title="Aceitos pelo provedor" value={row.accepted} /><Metric title="Entregues" value={row.delivered} /><Metric title="Lidos" value={row.read} /><Metric title="Resultado incerto" value={row.uncertain} /><Metric title="Pendentes" value={row.pending} /><Metric title="Falhas" value={row.failed} /></dl></CardContent></Card>)}</section> : null;
      })}
      {(program === "all" || program === "waitlist_feedback") && <Card><CardHeader><CardTitle className="text-base">Histórico legado · pesquisa após a fila</CardTitle></CardHeader><CardContent className="space-y-3">{data.legacy_available ? <dl><Metric title="Pesquisas aceitas pelo provedor" value={data.legacy.waitlist_feedback_sent} /></dl> : <p role="status">Histórico legado indisponível neste período: fora da retenção, não é possível separá-lo dos registros gerenciados com segurança.</p>}<p className="text-sm text-muted-foreground">O período legado considera a data registrada de envio, diferente da data do fato usada no gerenciado; as séries não são comparáveis dia a dia. Fonte: notificações registradas, incluindo falha posterior com recibo correlacionado. Sem comprovação equivalente de entrega ou leitura; série separada, não somada ao gerenciado.</p></CardContent></Card>}
      <p className="text-sm text-muted-foreground">Custo Meta não apurado. Gasto real, receita incremental e retorno sobre investimento indisponíveis.</p>
    </>}
  </div>;
}

function Metric({ title, value }: { title: string; value: string | number | null }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{title}</dt><dd className="mt-1 text-xl font-semibold">{value === null ? "—" : typeof value === "number" ? value.toLocaleString("pt-BR") : value}</dd></div>;
}
