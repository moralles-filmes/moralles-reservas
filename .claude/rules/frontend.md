---
paths:
  - "src/**"
  - "index.html"
  - "vercel.json"
  - "tailwind.config.*"
---

# Frontend (Vite + React)

## Rotas


Estrutura completa em `src/App.tsx`. O que NÃO é descobrível:

- `/r/:slug` aceita `?mode=embed` (sem chrome, pra iframe) e `?action=reservar|waitlist` (auto-abre dialog). Combinável.
- `/acompanhar/:token` é página pública (sem login) de status de reserva/fila; `token` = `reservations.id` OU `waitlist.id` (UUID), resolvido pela RPC `get_public_tracking`. Link enviado ao cliente (fila ao entrar em `process-waitlist-entered`, lembrete D-0 em `process-reservation-reminders`) aponta pra cá — não mais pra `/r/:slug`.
- `/g/:unitSlug/cobranca` é a única rota whitelisted no `BillingGuard` quando org está `blocked/suspended/canceled` — sem isso, cliente bloqueado entra em loop.
- `/platform/*` é exclusivo de `platform_admin`. Edge Functions `manage-ai-providers`, `manage-billing`, `manage-organizations`, `manage-stripe-accounts`, `manage-platform-secrets`, `whatsapp-health`, `manage-whatsapp-implementations` validam `platform_admin` no JWT (`manage-whatsapp-implementations` tem 1 exceção org-scoped: `get_service_status`). `manage-channels` mantém create/credenciais/switch/diagnóstico exclusivos de platform admin e libera somente `list_client|connect|refresh_qr|status|disconnect|restart` para owner/gerente da própria unidade; operador nunca acessa lifecycle.
- **`/platform/automacao/:unitSlug` é redirect permanente para `/platform/unidades/:unitSlug` e preserva query e hash.** O retorno do onboarding Stripe Connect é montado no servidor (`manage-stripe-accounts`) com o endereço antigo e `?stripe=complete`, então remover o redirect ou perder a query quebra esse retorno sem erro visível. [legacy-redirects.tsx](src/pages/platform/legacy-redirects.tsx).

## Portal público e consultas sensíveis

- **`select("*")` como anon em `units`/`organizations` devolve 403** (privilégio por coluna, migration 086): o portal público lê por RPC `SECURITY DEFINER` ou lista explícita de colunas.
- **Componente de painel não entra em página pública** — o `ReservaCard` exibe nome completo, telefone e `notes`. Payload público vem só de `get_public_tracking` (privacy-safe).
- **Query em `audit_log` cobre `.or(unit_id.eq.X, organization_id.eq.Y)`:** reservas/membros logam `unit_id`, clientes logam `organization_id`; filtrar só por unidade esconde mudanças de cliente.

## Storage (`unit-assets`)


Path: `<unit_id>/logo-<ts>.<ext>`. CDN read público; listing bloqueado; write só owner/gerente. Substituir asset NÃO apaga blob antigo — sem cleanup, custo acumula.

**Cleanup duplo obrigatório em qualquer feature que escreva no bucket:**

1. **Diff DB-vs-form no save** — capturar URLs prévias ANTES da mutation, comparar com form depois, apagar paths que sumiram. Helpers em [src/lib/storage.ts](src/lib/storage.ts): `deleteUnitAssetByUrl(url, unitId?)` / `deleteUnitAssetsByUrls`.
2. **Tracking de sessão (`uploadedRef = useRef<Set>()`)** — uploaders chamam `onUploaded({ publicUrl, path })`. No save, paths em `uploadedRef` que não ficaram no estado final são candidatos a remoção. Cobre "Trocar A→B→C".
3. **`storage.remove()` NÃO lança** em RLS denied / file missing — retorna `{ error }`. Sempre destruturar e logar.
4. **SEMPRE filtrar paths via `extractStoragePath()` de `@/lib/utils`** (rejeita URL de outro bucket → null) E confirmar `path.startsWith(<unit_id>/)` (defesa cross-tenant).

NUNCA `DELETE FROM storage.objects` via SQL — SQL bypassa policies e pula triggers internos. Worker `cleanup-orphan-assets` (dom 04:00 UTC) cobre "usuário fechou aba sem salvar" (cleanup `onUnmount` rejeitado: Strict Mode double-mount; `beforeunload` flaky em SPA).

**`units.price_range_min/max`:** UI tem campo único "ticket médio" → grava SÓ `price_range_max`, deixa `price_range_min` NULL. Formatters renderizam "até R$ X" no branch `min == null && max != null`.

## Wizard de reserva pública


Fluxo público (`/r/:slug` e `/w/:slug`) em [src/components/reserva/wizard/useReservaWizard.ts](src/components/reserva/wizard/useReservaWizard.ts) (state machine + Zod por step).

- **E-mail é obrigatório no frontend público** (`z.string().email()` sem `.optional()`) MAS opcional no banco / `create-reservation` / agente WhatsApp. Não promover essa regra pro backend sem coordenar (cliente WhatsApp raramente fornece e-mail).
- **`partitionHalls()`** em [src/components/reserva/wizard/availability-helpers.ts](src/components/reserva/wizard/availability-helpers.ts) é apenas filtro visual — `_shared/availability.ts` segue como fonte de verdade no submit.
- **Mobile usa `ResponsiveDialog` (bottom-sheet `<640px`, Dialog centrado `≥640px`)** — em [src/components/ui/responsive-dialog.tsx](src/components/ui/responsive-dialog.tsx). Inputs `h-12` em mobile (tap target ≥44px); footer respeita `env(safe-area-inset-bottom)`.
- **Copy de bloqueio:** `reason: "blocked"` → "Não estamos aceitando reservas nesta data"; `reason: "closed_special"` → "Esta data o restaurante está fechado". Não confundir bloqueio (`table_blocks`) com fechamento (`special_dates is_closed`) na cópia.

## Dashboard e métricas


Convenções em [src/hooks/useDashboardMetrics.ts](src/hooks/useDashboardMetrics.ts) e [src/hooks/useFluxoClientes.ts](src/hooks/useFluxoClientes.ts) — replicar em hook novo de relatório.

- **Taxa de cancelamento** = `cancelled / (confirmed + cancelled + no_show) * 100`. **Exclui pending.** Retorna `null` se denom=0 (UI renderiza "—").
- **Taxa de no-show** = `no_show / (confirmed + no_show) * 100`. Mesma regra.
- **"Pessoas esperadas hoje"** soma apenas `pending` ou `confirmed`. Canceladas e no-show excluídas.
- **`KpiCard.formatValue`** renderiza "—" para `null`/`undefined`/`NaN`/`Infinity`. Suffix ("%", "⭐") só com número finito.
- **Datas de eventos com timestamp UTC** (waitlist/walk_ins/notifications_sent): use `isoToLocalDate(iso)` pra agrupar por dia local — `.slice(0, 10)` em UTC atribui dia errado em eventos próximos da meia-noite BRT.
- **`getDay()` em timestamp UTC** retorna dia da semana no fuso LOCAL do browser. Pra waitlist/walk-ins parsear via `new Date(isoToLocalDate(iso) + "T12:00:00").getDay()`. Pra reservas, `r.date` (YYYY-MM-DD) já é dia local.
- **Ordenação de timestamps** — sempre `new Date(iso).getTime()` numérico, nunca `localeCompare` (mistura de formatos com/sem Z / milissegundos quebra).

## Painel operacional


- **Mutation que faz "external action + status UPDATE" trata cada lado separadamente.** Se external suceder mas UPDATE falhar, NÃO relançar throw — proteções DB-side (ex.: UNIQUE PARTIAL em `notifications_sent`) bloqueiam o 2º envio silenciosamente. Padrão: retornar `{ externalOk, dbOk }`, `toast.warning` quando `dbOk=false`, invalidar pra forçar reconciliação. Pattern em [src/hooks/useWaitlist.ts](src/hooks/useWaitlist.ts) `useNotifyWaitlist`.
- **Desabilitar 1 botão entre N que compartilham mutation usa `mutation.variables`**, não state extra. Checar `mutation.isPending && mutation.variables?.id === entry.id`. Desabilitar mutation globalmente trava a lista. Pattern em [src/pages/operacional/Fila.tsx](src/pages/operacional/Fila.tsx) / [Passantes.tsx](src/pages/operacional/Passantes.tsx).
- **Painéis em tablet usam `refetchInterval` visibility-aware:** `() => document.hidden ? false : 30_000`. Tab background não consome request idle.
- **Empty state em lista filtrada checa as listas DERIVADAS**, não o total bruto. `reservas?.length > 0` com todas `cancelled` passa o guard mas as listas derivadas estão vazias → render em branco. Pattern em [src/pages/operacional/ReservasDia.tsx](src/pages/operacional/ReservasDia.tsx).

## Padrões de código

- Componentes **PascalCase**, hooks **camelCase** com prefixo `use`. Path alias `@/` → `src/`. Hooks de dados aceitam `unitId` como 1º parâmetro (`useCurrentUnit()` resolve). Forms via React Hook Form + Zod. Toast via Sonner. CSS via `cn()` de `@/lib/utils` (nunca template literal Tailwind). Datas `YYYY-MM-DD` no DB / `formatDateBR()` na exibição. Telefones só dígitos / `formatPhone()` na exibição.
- **Layouts admin (Gestão/Operacional/Plataforma/Admin legado) renderizam o casco via `AdminShell`** ([src/components/layouts/AdminShell.tsx](src/components/layouts/AdminShell.tsx)) — ele provê o toggle hambúrguer (colapso no desktop persistido em `localStorage` chave `admin-sidebar-collapsed` + gaveta mobile com backdrop `<lg`). Painel/layout novo passa o conteúdo da sidebar na prop `sidebar` em vez de montar `<aside>` de largura fixa próprio; reintroduzir `<aside>` fixo perde a responsividade mobile e o toggle.
- **Calendário `mode="range"` NUNCA recebe um intervalo completo como rascunho de seleção.** O `addToRange` do react-day-picker v8 trata `{from, to}` preenchidos como "ajustar uma ponta" e devolve outro intervalo completo, então o PRIMEIRO clique de uma seleção nova já satisfaz `from && to` e aplica o filtro — por um intervalo que ainda herda a ponta do filtro anterior (clique em cima da ponta inicial é pior: devolve `undefined` e limpa tudo). Decisão em [date-range-draft-core.ts](src/lib/date-range-draft-core.ts) (`nextRangeDraft`/`isCompleteRange`), com controle positivo nos dois níveis: o núcleo testa contra o `addToRange` real e o teste de componente reprova se a ligação voltar a consumir a saída crua do picker. Picker de intervalo novo usa o núcleo em vez de ler `onSelect` direto.
- **Campo que aceita texto COLADO de mensagem não pode ler `e.target.value` nem usar `maxLength`: um `<input type="text">` descarta as quebras de linha da colagem e aplica o `maxLength` ANTES do `onChange` rodar.** Descartar o `\n` não insere espaço no lugar, então o dado colado se funde com a palavra seguinte (`"Código: #8GY6EG9X\n\nAcompanhe"` → `"...#8GY6EG9XAcompanhe"`) e toda regra que dependa da fronteira se perde (o lookup público devolve "Reserva não encontrada" para código certo). O texto íntegro só existe em `e.clipboardData.getData("text")` no `onPaste`: registre-o num ref, consuma e limpe no `onChange`, e **use-o apenas quando ele contiver o marcador que motivou o desvio** — usá-lo sempre apaga o que já estava no campo e deixa o ref de um paste vazio comer a tecla seguinte. Limite de tamanho mora na função de extração, nunca no DOM. [ReservaCodeLookup.tsx](src/components/reserva/ReservaCodeLookup.tsx), decisão pura em [reservation-code.ts](src/lib/reservation-code.ts).
- Queries/mutations via **TanStack React Query** — nunca `useState + useEffect` pra dados remotos.
- **`invalidateQueries` é prefix-match — cuidado com ordem da key.** Se query é `["customers", orgId, unitId, search]` e mutation invalida `["customers", unitId]`, **não casa** (posição 1 é orgId). Invalidate broad (`["customers"]`) ou montar key na mesma ordem.
- **Listas TanStack tratam `isError` separado de `!data.length`** — 4 branches: `isLoading`, `isError` (com `refetch()`), `empty`, `list`. Erro silenciado como "lista vazia" esconde falha real.
- **Batch que lê tabela inteira precisa `.range(from, to)` em loop** até `chunk.length < PAGE`. Sem `.range`, PostgREST trunca silenciosamente em `db-max-rows` default (1000).
- **`refetchOnWindowFocus: false`** é default global em [src/App.tsx](src/App.tsx) — evita resetar form state ao trocar de aba. Painéis operacionais usam `refetchInterval`, não reativam windowFocus.
- **`AuthContext` só ativa `loading=true` quando `user_id muda`** ([src/contexts/AuthContext.tsx](src/contexts/AuthContext.tsx)). Supabase dispara `SIGNED_IN` em refoco após token refresh — ativar loading desmonta árvore e descarta state local.
- **Auto-logout de órfão:** user autenticado sem `unit_members` E sem `platform_admins` → `AuthContext` desloga + redireciona `/admin/login`. Detecção via Realtime nas duas tabelas. NÃO adicionar de volta tela estática "Sem acesso a nenhuma unidade" — trava em sessão zumbi.
- **Nome da unit vive em `units.name`** — fonte canônica. Owner/gerente escreve via policy `unit_owner_gerente_update_units`. Após escrever, chamar `refreshMemberships()` do `useAuth()`. Setting `restaurant_name` é legado (EFs leem com fallback pra compat); UI não escreve mais nele.
- **Slug da unit (`units.slug`) é editável** e invalida URLs antigas (QR impresso → 404). Mutation faz `refreshMemberships`, invalida `["all-units"|"public-unit"|"unit-public-content"|"organizations"]`, renavega `/g/<antigo>` → `/g/<novo>`. Trata colisão `23505`.
- **Input do usuário em `.or()`/`.ilike()` PostgREST passa por `sanitizeSearchTerm()`** de `@/lib/utils` (remove `, ( ) % _ \ " ' \` *`, limita 80 chars). Sem isso, `O'Brien` quebra a query.
- **URLs em `<a href>` de portal público passam por `isSafeHttpUrl()`** (bloqueia `javascript:`/`data:`/`vbscript:`). Hoje só `menu_banners.link_url`: triplo guard frontend save + render + CHECK constraint. Campo novo "link salvo por membro" segue o mesmo.

## Tema visual


Dois mundos: `:root` warm (laranja+bege, portais públicos+login) e `.theme-admin` navy SaaS (painéis Gestão/Operacional/Plataforma). `.theme-admin` sobrescreve TODAS as CSS vars no escopo. Nunca hardcode cores — tokens Tailwind sempre.

- **`index.html` precisa manter `viewport-fit=cover` no meta viewport.** Sem ele, todo `env(safe-area-inset-*)` (footers de `Dialog`/`ResponsiveDialog`, gaveta do `AdminShell`) avalia 0 no iOS — safe-area morre em silêncio. [index.html](index.html).
- **Pares de inputs em form usam `grid grid-cols-1 sm:grid-cols-2`, nunca `grid-cols-2` cru.** O `sm:` (640px) casa com a largura em que o Dialog deixa de ser fullscreen — abaixo disso empilha. Grid de KPI/tiles (`grid-cols-2 lg:grid-cols-4`) é proposital e fica.
