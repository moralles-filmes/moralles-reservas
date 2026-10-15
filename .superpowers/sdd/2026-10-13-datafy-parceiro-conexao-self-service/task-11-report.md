# Task 11 — painel da plataforma e diagnóstico

Implementação na branch `feat/datafy-parceiro-self-service`, base `25c1abcec593e283c3c8af6ef61343223887b13b`. Sem provider remoto, banco de produção, migration, deploy, push ou merge. Plano do controlador preservado fora do commit.

## Implementação

- `DatafyAdminCard`: liberação/revogação e subscribe/cancel/pause/resume com confirmação; cancel/pause explicitam que o número para de enviar e receber. Subscribe explicita custo. Preview do vínculo mostra nome, prefixo, assinatura, pausa e hosts; link exige selecionar o candidato e digitar seu nome exato.
- Sessão keyed por unidade, cleanup síncrono, lock imediato contra clique duplo, respostas antigas sem toast/preview na nova unidade e invalidações limitadas à unidade iniciadora. Falha com código operacional em HTTP 200 não produz toast de sucesso.
- Cada canal deriva o checklist do núcleo `deriveOfficialChecklist` com seus próprios campos; textos compartilhados com Task10. Ingestão efetiva vem do backend. Intenção de ativação, pausa e cancelamento ficam visíveis. Aviso após 24h sem mensagem exige ausência real de prova de eco, e datas inválidas nunca mostram NaN/Invalid Date.
- Seleção administrativa opcional por `channel_id` LOCAL, aprovada pelo controlador: query mantém unidade+provider+id; seleção explícita inexistente/alheia/inválida retorna CHANNEL_NOT_FOUND, sem fallback. Identidade remota continua vindo da linha. Subscribe de um canal histórico não reconcilia onboarding de outro canal. Ações do lojista continuam unit-only. Guard estático ajustado com controles positivos, sem permitir IDs remotos no corpo. Invariante adicionada nos dois arquivos AGENTS/CLAUDE.
- Lista admin amplia somente metadata necessária e calcula ingestão por coluna+capability+flag com `decideIngestionMode`; desconhecido não vira síncrono. Sem chamadas extras ao provider para inventar metadata.
- `whatsapp-health`: binding ativo/legado conectado prevalece, senão canal mais recente inclusive inativo; erro de leitura retorna 503. Expõe is_active, ingestão efetiva e booleano ops_alert_configured. Política HTTPS do alerta é a mesma função pura usada pelo sender, exportada de `ops-alert-sender.ts`; URL não sai no payload. Runtime testável mantém gates baratos antes da leitura falível da flag.
- Organização fornece default_whatsapp_provider ao diálogo de criação; edição Datafy aceita token de canal; toast de rotação diferencia Datafy. Diálogos adicionar/editar usam ResponsiveDialog. Segredo de conta recebe label/placeholder próprios, grupo fora de Pagamentos e remoção com efeito específico.

## RED / GREEN

- Primeira rodada de componentes: 3 falhas de sincronização dos testes (mutação TanStack ainda não iniciada); corrigidas com espera pela chamada antes de resolução/troca de unidade.
- RED comportamental explícito: dois testes adicionais falharam mostrando orientação falsa para canal com eco já comprovado e NaN/Invalid Date. GREEN após exigir ausência de eco e validar datas para apresentação.
- Guard estático anterior recusou o novo seletor LOCAL `body.channel_id`; ajustado à decisão aprovada, mantendo proibição de IDs remotos e verificando filtro unit+provider+id e separação das ações do lojista.
- Primeiro typecheck ampliado detectou opção `exact` não suportada por getByRole no teste; removida. Typecheck posterior passou.
- Rodada focada: **12 arquivos / 196 testes**, verdes; inclui componentes/card, integração de diálogos, segredo da plataforma, rotação, runtime/core de diagnóstico, ações Datafy e guards existentes.

```powershell
npx vitest run src/components/whatsapp/DatafyAdminCard.test.tsx src/pages/gestao/Automacao.datafy.test.tsx src/pages/platform/Automacao.datafy.test.tsx src/hooks/useWhatsAppChannels.datafy.test.tsx src/lib/whatsapp-health-core.test.ts src/lib/whatsapp-health-runtime.test.ts src/lib/datafy-onboarding-actions.test.ts src/lib/ops-alert-core.test.ts src/components/whatsapp/OfficialConnectionCard.test.tsx src/lib/datafy-partner-wiring-guard.test.ts src/lib/datafy-adapter-coupling-guard.test.ts src/lib/datafy-provider-migration-guard.test.ts
npm run typecheck
```

- ESLint focado em todos os TS/TSX alterados: exit 0, sem erros; somente os dois warnings de `any` preexistentes em useAllUnits.ts.
- `git diff --check`, revisão integral do staged e scan de secrets antes do commit. Placeholders e fixtures sintéticas não representam credenciais reais.
- React Best Practices: remoto em TanStack, handlers mutantes, refs para locks e vida da sessão, estado local só de confirmação/form, componente isolado por unidade, labels de inputs, ResponsiveDialog e tokens de tema.

## Limites e rollout

- Não há Deno local: EFs verificadas por ESLint e wiring/runtime importáveis no Vitest, sem alegar deno check. Sem teste contra provider real ou banco remoto.
- Deploy futuro exige frontend e `manage-channels` + `whatsapp-health`; para uniformizar o refactor compartilhado do sender, considerar também `process-whatsapp-channel-health` e `process-whatsapp-templates` (a política de URL é equivalente à anterior).
- Suíte completa, build e reviews finais pertencem ao controlador. Não foram alterados billing, migrations, RLS ou a autoridade de claims SQL.

## Correções finais da revisão integrada

- Matriz de deploy em AGENTS.md e CLAUDE.md inclui `whatsapp-health` como consumidor por valor de `isOpsAlertConfigured` em `ops-alert-sender.ts`. Consumidores de runtime/core continuam explicitamente `process-whatsapp-channel-health` e `manage-channels`, sem referência posicional ambígua.
- Os dois documentos esclarecem que o frontend não reimplementa a derivação do checklist; o card admin reutiliza o núcleo canônico.
- Diagnóstico traduz sync/async/unknown para Síncrona/Assíncrona/Desconhecida (processamento bloqueado), com Não disponível para ausência. Falha de leitura não afirma modo síncrono. Nenhum runtime de alertas foi reestruturado.
- Gate focado: `npx vitest run src/lib/whatsapp-health-core.test.ts src/lib/whatsapp-health-runtime.test.ts src/components/whatsapp/DatafyAdminCard.test.tsx src/pages/gestao/Automacao.datafy.test.tsx` — **4 arquivos / 19 testes verdes**, exit 0.
- `npm run typecheck` (`tsc -b --noEmit`) — exit 0. `npx eslint src/pages/gestao/Automacao.tsx` — exit 0, sem warnings. `git diff --check` — exit 0.
- Revisão limitada aos quatro paths da correção e scan de staged antes do commit; plano do controlador preservado. Suíte completa continua sob responsabilidade do controlador.
