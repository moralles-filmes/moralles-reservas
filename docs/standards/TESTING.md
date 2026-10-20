# Testes e CI

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao escrever ou alterar testes, corrigir bug, configurar CI ou definir quality gates.

## 1. Pirâmide [N1]

| Camada | Cobre |
|---|---|
| Unidade | regras de domínio e casos de uso com portas falsas |
| Integração | adapters contra Supabase local, policies e RPCs |
| Contrato | formato de request/response de provedores, com fixtures reais sanitizadas |
| Isolamento de tenant | matriz de MULTI_TENANCY §7 |
| E2E [N2] | fluxos críticos de ponta a ponta (smoke) |
| Carga [N2] | apenas em ambiente isolado |

## 2. Correção de bug [N1]

1. Reproduza o bug.
2. Encontre a causa raiz, não só o sintoma.
3. Escreva um teste que falha pelo motivo certo.
4. Corrija.
5. Rode o teste e a regressão relacionada.
6. Procure a mesma causa em outros pontos do código.

## 3. Honestidade sobre execução [N1]

Só é "testado" o que foi executado nesta sessão, com o resultado observado. Inspeção visual de código não é teste.

```text
NÃO EXECUTADO
Motivo: …
Impacto: …
Como validar: …
```

Nunca remova, pule (`.skip`) ou enfraqueça um teste para fazer o CI passar. Se um teste está errado, corrija o teste e explique por quê.

## 4. Ambiente de teste [N1]

- Banco: Supabase local (`supabase start` e `supabase db reset`) ou banco efêmero no CI. Nunca produção.
- Usuários de teste reais (JWT) para testar RLS. A service role nos testes só para preparar dados (seed), nunca para a asserção de acesso.
- Provedores: fake adapter por padrão; sandbox do provedor apenas em teste manual ou job separado, sem destinatários reais.
- Nenhum teste dispara mensagem, e-mail, cobrança ou webhook real. O mesmo vale para **preview deployments**: o escopo Preview das variáveis de ambiente usa credenciais de sandbox ou nenhuma, e o adapter fake fica ativo.

## 5. Pipeline de CI

Monte o pipeline **aplicável** ao produto, preservando os controles que já existem. Use os comandos oficiais do AGENTS.md §7.

| Etapa | Nível |
|---|---|
| Instalação com lockfile congelado | N1 |
| Secret scan | N1 |
| Lint | N1 |
| Typecheck (comando oficial do projeto) | N1 |
| Testes de unidade | N1 |
| Testes de integração e de isolamento de tenant/RLS | N1, se há multi-tenancy |
| Validação de migrations: aplicar do zero num banco limpo + Advisors/lint | N1, se há banco |
| Build | N1 |
| Checagem do padrão (`node scripts/check-padrao.mjs`): manifest ↔ padrões nos dois sentidos, corpo dos padrões, `@AGENTS.md`, tenancy-profile, AGENTS aninhados, links | N1 |
| Portabilidade (`node scripts/check-portabilidade.mjs`), com linha de base em projeto legado (GCP_MIGRATION §6) | N1 |
| Tipo das permissões gerado do catálogo e atualizado | N1, se há controle de acesso |
| Testes de contrato de integrações | N2 |
| E2E smoke | N2 |
| Dependency review/SCA | N2 |

Regras do CI:

- **[N1]** Nenhum segredo privilegiado de produção em PR.
- **[N1]** Nenhuma migration de produção disparada por PR.
- **[N1]** Cache de CI sem segredo.
- **[N2]** Ambientes protegidos para deploy.
- **[N2]** Artefato imutável promovido entre ambientes.
- **[N2]** Actions fixadas por SHA.

## 6. Cenários obrigatórios por assunto

Quando o fluxo existir, os testes cobrem:

- **Tenant/permissão:** a matriz de MULTI_TENANCY §7 e a de ACCESS_CONTROL §10 (empresa, filial, submódulo, ação, anti-escalada), incluindo o acesso legítimo.
- **Escrita direta bloqueada:** `update` via PostgREST com JWT de usuário em tabela protegida falha (SECURITY §5).
- **Concorrência:** duas requisições simultâneas contra a mesma invariante (último item do estoque, mesmo saldo). Só uma vence.
- **Idempotência:** a mesma operação repetida não duplica o efeito; mesma chave com payload diferente gera conflito.
- **Integrações:**
  - resposta perdida após execução;
  - evento duplicado;
  - evento fora de ordem;
  - queda entre receber e processar;
  - credencial revogada;
  - tentativa por outra empresa (INTEGRATIONS §17).
- **IA/MCP:** aprovação invalidada por alteração material, troca de tenant por argumento e prompt injection.

## 7. Qualidade dos testes [N1]

- Teste comportamento, não implementação.
- Dados de teste explícitos no próprio teste ou em factories. Nada de dependência de ordem entre testes.
- Um teste instável (flaky) é bug: investigue a causa, não adicione retry cego.

## Particularidades deste projeto

- Comandos: `npm run lint`, `npm run typecheck` (`tsc -b --noEmit`; nunca sem `-b`), `npm test` (Vitest), `npm run build`; Edge Functions: `deno check` (o `tsc -b` não as alcança).
- Banco local: harness em `supabase/tests/local-preflight/` (ver `.claude/rules/banco-de-dados.md`). Não há `supabase test db`/pgTAP: o histórico de migrations não replaya, então o CI não monta banco descartável.
- CI hoje: só `.github/workflows/function-acl-audit.yml` (ACL estática, núcleo do advisor, guardrail de migrations, `eslint supabase/functions`). Lint, typecheck, testes, build e os checks do padrão não rodam no CI.
