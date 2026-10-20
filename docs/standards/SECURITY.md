# Segurança

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia ao tocar auth, sessão, permissões, RLS/grants, credenciais, dados pessoais, uploads, IA no produto ou ferramentas de agente.
> Complementa: MULTI_TENANCY.md (isolamento), DATABASE.md (policies e funções), INTEGRATIONS.md (credenciais de provedor).

## 1. Critérios de decisão de engenharia

Quando dois objetivos de engenharia conflitarem, priorize nesta ordem:

1. proteção de dados;
2. integridade e exatidão;
3. isolamento entre tenants;
4. regras de negócio confirmadas;
5. compatibilidade;
6. arquitetura documentada;
7. desempenho medido;
8. convenções;
9. preferência estética.

Desempenho nunca justifica enfraquecer segurança ou integridade.

Esta ordem orienta **decisões técnicas**. Ela não altera a hierarquia de instruções e permissões da ferramenta nem dispensa autorização do usuário para ações de produção.

## 2. Três verificações independentes [N1]

```text
Autenticação       = quem está chamando
Autorização        = o que pode fazer
Resolução de tenant = em nome de qual empresa/unidade
```

Passar em uma não implica passar nas outras. Verifique as três em todo caso de uso que lê dado privado ou altera estado.

## 3. Autenticação e sessão

- **[N1]** No servidor, valide o usuário com o método que confere o token junto ao Supabase Auth (`auth.getUser()` ou `auth.getClaims()`). Não confie em `auth.getSession()` lido de cookie, porque o cookie pode ser forjado.
- **[N1]** Tokens são validados por assinatura, issuer, audience e expiração.
- **[N1]** Logout e revogação removem o acesso. Claims customizadas no JWT (role, `company_id`) ficam desatualizadas até o refresh. Para revogação imediata, confira a membership no banco em vez de confiar só na claim, e documente a janela aceitável.
- **[N2]** Exija reautenticação ou MFA para ações sensíveis: alterar permissões, dados bancários, exportação em massa, exclusão definitiva.
- **[N1]** Proteja contra força bruta e enumeração: rate limit em login, recuperação de senha e convites; mensagens que não revelam se o e-mail existe.
- **[N1]** Configuração do Supabase Auth revisada e registrada em "Particularidades": confirmação de e-mail, proteção contra senha vazada, política de senha, expiração de OTP e de links, URLs de redirect permitidas (lista exata, sem curinga amplo).
- **[N1]** CAPTCHA ou proteção contra bots em cadastro, login e recuperação de senha quando o cadastro é aberto ao público.
- **[N2]** MFA obrigatório para administradores da plataforma e para proprietários de empresa que movimentam dinheiro.

## 4. Autorização [N1]

- Deny-by-default. Permissões são granulares por módulo, submódulo e ação (`financeiro.contas_pagar.baixar`), avaliadas por empresa e filial. Modelo completo, anti-escalada e testes: ACCESS_CONTROL.md.
- A autorização vive no servidor e no banco. O frontend esconde botões só por UX.
- O administrador global da plataforma é uma identidade separada, auditada e nunca reaproveitada como usuário de tenant.
- Service accounts são distintas por workload (worker de mensagens ≠ job de relatório).

### 4.1 Acesso de suporte a dados de cliente [N2]

Quando a plataforma precisa ver dados de uma empresa para dar suporte:

- só administradores da plataforma, com MFA;
- motivo obrigatório e ticket de referência;
- somente leitura por padrão; escrita exige segunda aprovação;
- tempo limitado (ex.: 1 h), revogável;
- registrado no audit log **da empresa**, visível ao proprietário dela;
- executado pelo servidor com a service role e filtro explícito da empresa. Nunca adicionando o administrador como membro nem afrouxando policy.

### 4.2 Audit log de negócio [N1]

Ações sensíveis (dinheiro, permissões, exclusões, exportações, mudanças de status, acesso de suporte) gravam um registro na **mesma transação** da mudança:

```text
audit_log: id, company_id, location_id, actor_type (user | api_key | system | platform),
           actor_id, action (chave de permissão ou evento), entity, entity_id,
           summary (antes/depois resumido, sem segredo), request_id, created_at
```

- Somente inserção: `revoke update, delete` de todos os papéis de aplicação.
- Leitura por quem tem a permissão de auditoria da empresa.
- Retenção definida em "Particularidades"; não entra na limpeza técnica (DATABASE §10).

## 5. Bloqueie os caminhos que contornam o caso de uso [N1]

Se uma alteração exige um caso de uso (porque confere permissão, saldo, auditoria ou outbox), **o banco precisa impedir a alteração direta**. Um adapter no frontend não impede ninguém de chamar a API de dados do Supabase com o próprio JWT.

Para tabelas como lançamentos financeiros, estoque, permissões e status de pedido:

```sql
-- o cliente lê pela RLS, mas não escreve direto
revoke insert, update, delete on public.financial_entries from anon, authenticated;
-- mutação só via função/endpoint de servidor que aplica o caso de uso
```

- Revise grants, policies, views e funções expostas.
- Funções novas são executáveis por `PUBLIC` por padrão no Postgres: revogue e conceda explicitamente.
- Teste a tentativa direta: com o JWT de um usuário comum, chame `update` via PostgREST na tabela protegida. **Precisa falhar.**

## 6. Credenciais e chaves [N1]

Classifique cada credencial antes de decidir onde ela pode ficar:

| Tipo | Pode ir ao browser? | Observação |
|---|---|---|
| Publishable/anon key do Supabase | Sim | A proteção vem de RLS e grants |
| Secret key / service role | **Não** | Ignora RLS (`BYPASSRLS`) |
| Token de provedor (Meta, Z-API, gateway, e-mail) | **Não** | Fica no servidor ou no secret store |
| Sessão do usuário | Conforme o mecanismo | Cookies `httpOnly`, `secure`, `sameSite` adequados |

- Nunca em Git, `.env.example` com valor, logs, traces, mensagens de erro, URLs com query string, prompts de IA, resultados de tool MCP ou documentação.
- Segredos da aplicação ficam nas variáveis de ambiente da plataforma (Vercel, Supabase secrets), separados por ambiente.
- **[N2]** Segredos por tenant (token de cada cliente num provedor) ficam no Supabase Vault ou com criptografia em envelope. A tabela guarda só a referência.
- **[N3]** Use GCP Secret Manager/KMS.
- Cada credencial é usada só nos endpoints autorizados para sua função. Servidor de autorização e API podem ter hosts diferentes legitimamente; o que se impede é o envio a destino não autorizado.
- Prepare rotação e revogação sem deploy de código.

### Service role / secret key

- Use apenas em fluxo sistêmico de servidor: webhook, job, tarefa administrativa.
- Para ação de usuário, prefira o cliente com o JWT do próprio usuário, para que a RLS se aplique.
- Antes de usar, resolva o tenant e verifique a permissão. Toda query filtra `company_id` explicitamente, porque a RLS não está protegendo.
- Prefira funções limitadas a acesso amplo. Audite o uso.
- Escreva testes de isolamento específicos para esses caminhos.

## 7. Segurança aplicacional [N1]

Avalie conforme o contexto de cada mudança:

- **Mass assignment:** nunca espalhe o body num insert/update. Use whitelist de campos; `company_id`, `role`, `status`, `price`, `total` e `owner` são definidos pelo servidor.
- **IDOR/BOLA:** todo id recebido é verificado contra o tenant e a permissão.
- **XSS:** nada de HTML não sanitizado; cuidado com `dangerouslySetInnerHTML`.
- **CSRF:** em mutações autenticadas por cookie, garanta a proteção do framework ou valide a origem.
- **Injection:** SQL só parametrizado; nada de shell ou eval com input.
- **SSRF e open redirect:** ver INTEGRATIONS §6; redirects só para destinos internos validados.
- **Path traversal**, upload malicioso, replay, race conditions, cache poisoning, comprometimento de dependência e vazamento de segredo.

**[N2]** Faça threat model escrito para módulos financeiros, de mensagens e para integrações críticas.

## 8. Storage e uploads [N1]

- Bucket privado por padrão; path começa por `company_id/` e as policies de storage verificam membership.
- Valide o MIME real (extensão não prova nada), aplique limite de tamanho e use nome gerado pelo servidor. Impeça path traversal.
- Use signed URL de curta duração. Nenhum arquivo sensível público para ganhar desempenho.
- Deleção é auditada e há retenção definida.
- **[N2]** Antivírus quando o risco justificar (uploads de terceiros abertos a outros usuários).

## 8.1 Camada web [N1]

- Cabeçalhos: `Content-Security-Policy` (comece em report-only e aperte), `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `frame-ancestors` (ou `X-Frame-Options`) e `Permissions-Policy`. Na Vercel, em `vercel.json` ou no middleware.
- CORS das Edge Functions e route handlers: lista exata de origens por ambiente; nunca `*` em endpoint autenticado por cookie.
- Source maps de produção não públicos.
- O saas-shield-br (`vercel-deploy-guard`, `edge-function-guard`) verifica estes itens antes do deploy.

## 9. IA nas funcionalidades do produto

- **[N1]** O modelo de IA é uma integração: fica atrás de uma porta, com adapter, timeout, erro normalizado e versão do modelo fixada em configuração.
- **[N1]** O prompt não leva segredos nem dados de outro tenant. Minimize dados pessoais ao estritamente necessário.
- **[N1]** A saída do modelo não é confiável. Valide com schema antes de usar e nunca a trate como autorização.
- **[N1]** IA com ferramentas ou efeitos externos segue INTEGRATIONS §16, incluindo aprovação vinculada à operação.
- **[N1]** Fallback automático entre provedores de IA só em geração sem efeito externo. Cada provedor da cadeia é operador de dados (§10) e precisa estar no inventário; registre qual modelo respondeu.
- **[N2]** Teto de custo e de chamadas por tenant, com alerta.
- **[N2]** Prompts versionados no código e avaliação de regressão (conjunto de casos com resultado esperado) antes de trocar modelo ou prompt de funcionalidade em produção.

## 10. LGPD

- **[N1]** Mantenha um inventário de dados pessoais: quais tabelas e colunas guardam nome, telefone, e-mail, CPF e endereço, de quem (clientes do SaaS ou clientes finais deles) e para quê.
- **[N1]** Toda finalidade tem base legal identificada. Mensagens de marketing por WhatsApp/e-mail exigem consentimento registrado e opt-out funcional, verificado no momento do envio.
- **[N1]** Minimização: não colete nem guarde o que não é usado. Payloads de webhook, logs e exports têm retenção definida.
- **[N1]** Logs pseudonimizam: id em vez de nome, telefone mascarado.
- **[N2]** Existe processo para atender o titular (acesso, correção, exclusão/anonimização) que alcança banco, Storage, logs retidos e provedores.
- **[N2]** Os operadores (Supabase, Vercel, Meta, Z-API, provedores de IA) e a região onde os dados ficam estão documentados.
- **[N2]** Num incidente de segurança, o runbook prevê avaliar a comunicação à ANPD e aos titulares, conforme o art. 48 da LGPD.

## 11. Supply chain [N1/N2]

- **[N1]** Instalação com lockfile congelado e secret scan no CI.
- **[N2]** SCA/dependency review; GitHub Actions fixadas por SHA; imagem base versionada.
- **[N3]** SBOM.

## 12. Ferramentas de agentes de desenvolvimento

As restrições sobre SQL, shell e filesystem arbitrários (INTEGRATIONS §16) valem para as **tools que o produto expõe** a modelos e usuários. O uso de terminal e arquivos pelo Claude Code ou Codex durante o desenvolvimento é governado por OPERATIONS §7 e por `.claude/settings.json`.

## Particularidades deste projeto

- Tenant, papéis e super-admin: AGENTS.md §7–§8 e `.claude/tenancy-profile.yml` (arquétipo B). Guard de EF: `hasUnitAccess` em `supabase/functions/_shared/authz.ts`.
- Service role só em Edge Function, depois de autenticar o caller e validar o recurso contra o `unit_id`; tabelas de credenciais, filas e ledgers têm RLS sem policy e dependem desse filtro.
- Segredos: Edge secrets + Vault (`internal_api_key`, `project_url`); Stripe/Asaas/Datafy-conta em `platform_secrets`; chave de IA por unidade em `ai_provider_credentials` (BYOK). Rotação: `docs/RUNBOOK-ROTACAO-CREDENCIAIS.md`.
- Leitura anônima só por RPCs `SECURITY DEFINER` gateadas por `units.is_public`; a ACL de funções é conferida pelo CI `acl-estatico` contra `scripts/function-acl-allowlist.json`.
- Dados pessoais: clientes finais (nome, telefone, e-mail), conversas de WhatsApp, dados de cobrança. Anonimização por `public.anonymize_customer`. Região dos dados: `sa-east-1`.
