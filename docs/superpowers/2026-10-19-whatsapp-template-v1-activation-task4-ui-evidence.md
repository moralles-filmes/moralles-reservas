# Task 4 — controle administrativo do despacho v1

## Escopo implementado

Implementação local do contrato já aprovado em `specs/2026-10-03-whatsapp-templates-programados-design.md`, §§9–10, e Task 1 de `plans/2026-10-19-whatsapp-template-v1-operational-activation.md`. O guard de exclusividade SQL/EF é um gate separado e anterior à operação. Este documento não comprova publicação nem ativação em produção.

- `src/components/whatsapp/TemplateDispatchAdminCard.tsx`: cartão administrativo, montado em Canais ao lado do catálogo. O wrapper exige usuário autenticado, autenticação concluída e `isPlatformAdmin` real; não usa pseudo-membership owner como autoridade.
- `src/hooks/useWhatsappTemplates.ts`: mutation existente de gestão, `release_channel`, com `scope: 'dispatch'`, `enabled` e assertions de geração/revisão. O scope `catalog` e os contratos de leitura canônica permanecem intactos. A EF e a RPC existentes continuam sendo a autoridade.
- Pin de canal, geração, revisão de credenciais, estado de despacho, adoção da unidade e intenção de habilitação. Revalidação local imediatamente antes do único POST; loading, erro e drift fecham o controle. Habilitação exige modalidade Datafy conhecida e binding atual; pausa de grant ativo não depende de saúde, seleção v2, capacidades de envio ou provider Datafy.
- Confirmação consumida antes de `await mutateAsync`, com lock síncrono. Resultado incerto/malformado permanece cercado no QueryClient, inclusive ao remontar o cartão. Somente uma leitura posterior bem-sucedida que comprove o estado solicitado e a adoção esperada reconcilia essa cerca. Não existe retry automático da mutation.
- Avisos: alcance de todos os fatos elegíveis da unidade, inclusive lembretes/pesquisas de recursos existentes; possível cobrança de mensagens; adoção durável; pausa sem retorno automático ao legado; preservação de histórico/envios em andamento. Flag global, escolhas da loja, custos/consentimentos e MARKETING seguem separados. Catálogo/coorte v2 pendente ou pronta não bloqueia esse controle v1.

## Evidências locais

Variáveis sintéticas usadas nos comandos Vite, sem URL/chave de produção:

```powershell
$env:VITE_SUPABASE_URL='https://fixture.supabase.invalid'
$env:VITE_SUPABASE_ANON_KEY='synthetic-anon'
```

```powershell
npx vitest run src/components/whatsapp/TemplateDispatchAdminCard.test.tsx src/components/whatsapp/TemplateCatalogAdminCard.test.tsx src/hooks/useWhatsappTemplates.test.ts --reporter=dot
```

**PASS — 47 testes:** 20 novos casos de despacho, 8 do catálogo administrativo já existente e 19 do decoder/hook. Os novos testes montam o componente/hook reais com respostas sintéticas da API existente. Demonstram papéis, scope/pins e único POST, v2 pending/ready independente, refetch próprio deferred sem falso aviso, drift real dos quatro estados capturados, erro de leitura, sanitização, rede/DTO incertos sem repetição após refetch/remount, reconciliação por leitura posterior e pausa/ciclo posterior conservando adoção. Não são prova de RLS, concorrência SQL ou envio externo.

```powershell
npx eslint src/hooks/useWhatsappTemplates.ts src/components/whatsapp/TemplateDispatchAdminCard.tsx src/components/whatsapp/TemplateDispatchAdminCard.test.tsx src/pages/gestao/Automacao.tsx
```

**PASS**, exit 0.

`npm run typecheck` (**tsc -b --noEmit**): **PASS**, exit 0.

`git diff --check` e checagem explícita de whitespace final nos dois arquivos TSX novos: **PASS**, exit 0.

`npm run build`, com o ambiente sintético acima: **PASS**, exit 0, 3.965 módulos transformados. Avisos: base Browserslist desatualizada e chunks maiores que 500 kB; o build não apresentou erro. Nenhuma atualização de dependência ou refatoração de bundle foi adicionada a esta task.

## Correções durante a implementação

O primeiro teste novo revelou uma fixture incompleta: o projector exige os dois campos de autorização do catálogo explicitamente nulos e usa `official` como código interno da Meta direta. A fixture foi corrigida, mantendo o decoder estrito. O typecheck inicial detectou inferência opcional de campos ao espalhar o objeto Zod; os pins passaram a ser construídos por campos explícitos. Um teste de falha de leitura precisava aguardar a notificação assíncrona do React Query após invalidate, corrigido com `waitFor` sem alterar a expectativa de bloqueio.

## Limites

Nenhum SQL, Edge Function, flag global, autoridade de versão v2, consentimento ou custo foi alterado nesta task. Não houve operação de produção, navegador, provider, segredo, Git write ou envio de mensagem. A cerca de tentativa é da sessão do QueryClient; a idempotência/autoridade durável permanece no backend existente. Reviews independentes de spec e qualidade, integração dos guards e gates da branch/publicação são responsabilidade da coordenação antes da operação autorizada.
