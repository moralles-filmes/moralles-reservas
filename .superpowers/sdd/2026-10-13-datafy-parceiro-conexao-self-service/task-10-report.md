# Task 10 — portal do lojista

Implementação na branch `feat/datafy-parceiro-self-service`, base informada `a335569b3ecf30184d5068a1266ebf72a5d55fe5`. Sem provider remoto, deploy, push ou merge. Task11 e plano preservados para o controlador.

## Implementação

- `useOfficialConnection.ts`: query `["official-connection", unitId]`, polling visibility-aware com `useSyncExternalStore`: 5 s em connecting/awaiting_echo, 30 s nas demais etapas, desligado com aba oculta. Leitura via TanStack; start/confirm comuns, sem mutation cache.
- `official-connection-api.ts`: transporte separado do hook/componente conforme o papel frontend-react. State projeta somente campos client-safe. Start consome a URL dentro da função e navega diretamente o popup depois de validar HTTPS/origem exata compartilhada/ausência de userinfo; retorna somente confirm ou undefined. Non-2xx extrai JSON de FunctionsHttpError e usa mapa fechado de códigos, nunca erro remoto arbitrário.
- `OfficialConnectionCard.tsx`: popup aberto sincronamente no clique, antes de start; erro fecha popup; next confirm fecha janela vazia e confirma. Lock compartilhado cobre start, postMessage e confirmação manual. Classificação de mensagem e tipos de checklist importados do core; aviso de ausência do app não vira barreira para confirmação manual. Prérequisitos, checklist persistido, instrução de eco depois da conexão, cartão Meta, templates pendentes e manutenção do app exibidos em PT-BR.
- Sessão keyed por unidade: cleanup síncrono invalida resposta antiga e fecha janela antes da próxima unidade reutilizar o nome; sem setState/toast/confirmação tardios após desmontagem. Não há URL em estado React, DOM, storage, logs, query key ou caches TanStack.
- `Whatsapp.tsx`: owner/gerente consultam state oficial; loading/erro/vazio não expõem fallback QR antes de conhecer a liberação. Grant ativo, progresso já consumido e conexão revogada mantêm card oficial; ausência de grant sem progresso preserva lifecycle legado. Operador continua redirecionado e não consulta conexões.
- `CLAUDE.md` e `AGENTS.md`: invariante permanente da capability e isolamento de sessão documentada nos dois; diff sem divergência semântica.

## TDD e validação

1. RED inicial: `npx vitest run src/components/whatsapp/OfficialConnectionCard.test.tsx` falhou por import do componente ainda inexistente. Quatro testes iniciais cobriam abertura antes de resolução, mensagem, ausência de app e next confirm/erro.
2. GREEN inicial: 4 testes de card passaram. A execução apontou warning de act em confirmação manual, corrigido com act assíncrono no teste.
3. Primeiro typecheck encontrou TS2339 no spy window.open.mock do teste; trocado por vi.mocked(window.open). Typecheck posterior passou.
4. Ampliação: hook real com Supabase mockado, integração de página com hooks reais e card. Primeira rodada conjunta: 4 arquivos/29 testes GREEN; rodada seguinte: 4 arquivos/40 testes GREEN.
5. Revisão encontrou risco da janela nomeada durante troca de unidade; cleanup passou para useLayoutEffect e fecha popup antes de liberar a nova sessão. Acrescentados casos de URL insegura, non-2xx, cache/DTO, visibilidade real, resposta antiga, popup bloqueado, loading/vazio e fluxo completo do clique na página.
6. GREEN final: comando abaixo passou, exit 0, **5 arquivos / 125 testes**, 9.62 s. São 25 testes novos (hook 11, card 6, página 8), mais 16 de lifecycle legado e 84 do core compartilhado.

```powershell
npx vitest run src/components/whatsapp/OfficialConnectionCard.test.tsx src/hooks/useOfficialConnection.test.tsx src/pages/gestao/Whatsapp.official.test.tsx src/hooks/useWhatsappConnection.test.ts src/lib/datafy-onboarding-core.test.ts
```

7. `npm run typecheck` (`tsc -b --noEmit`) final: exit 0.
8. Lint focado final: exit 0, zero erros e warnings. Primeiro lint apontou dependência de useCallback; função confirm foi extraída e a dependência ficou explícita.

```powershell
npx eslint src/hooks/useOfficialConnection.ts src/hooks/useOfficialConnection.test.tsx src/features/whatsapp/official-connection-api.ts src/components/whatsapp/OfficialConnectionCard.tsx src/components/whatsapp/OfficialConnectionCard.test.tsx src/pages/gestao/Whatsapp.tsx src/pages/gestao/Whatsapp.official.test.tsx
```

## Evidências e limites

- Evento de origem errada não confirma; dois eventos válidos enquanto confirm está pendente resultam numa chamada; botão manual compartilha a trava. Coexistence false mostra aviso e só confirmação manual prossegue.
- Start resolve URL somente no adapter; teste de integração verifica navegação do popup e ausência da URL/token sintético no DOM, query cache e mutation cache. URLs javascript, HTTP, origem externa e userinfo recusadas. DTO extra não chega ao cache.
- Troca de unidade invalida callback de atividade da sessão anterior e impede next confirm antigo; teste de hook verifica que resposta velha fecha janela sem navegar. Polling real para e retoma com visibilitychange.
- Gates de banco/ACL/RLS/identidade/claim não foram modificados: continuam responsabilidade do backend já entregue. Browser real/Embedded Signup/Datafy/Meta não foram acessados; mocks exercitam a fronteira Supabase e jsdom, não o provider nem comportamento real do popup cross-origin.
- A suíte completa foi explicitamente reservada ao controlador após Task11; baseline informado 112 arquivos/3238 testes já verde na base. Não se afirma browser E2E, build ou Deno check.
- Checklist React aplicado: hooks no topo, listener com cleanup, estado remoto em TanStack, lock transitório em ref, ação no handler, keys estáveis, estados loading/erro/vazio/conteúdo, botões com alvo mínimo 44px e layout empilhado no mobile. Sem novo modal.

## Revisão de entrega

Revisão própria de 100% do staged e do par CLAUDE/AGENTS realizada. Somente os dez paths explícitos da Task10 estão no stage; mudança do controlador no plano permanece fora. `git diff --check` e `git diff --cached --check` passaram. Scan de todas as linhas adicionadas staged por prefixos de credenciais, Bearer/Basic/service_role e nomes de token/senha/secret/URL encontrou somente documentação, variáveis, validação de HTTPS e fixtures sintéticas óbvias, sem segredo real. Stage precisou escalation porque `.git` é read-only no sandbox; relatório solicitado foi incluído com `git add -f <path-explícito>` porque `.superpowers` é ignorado, seguindo o relatório da Task9 já versionado.
