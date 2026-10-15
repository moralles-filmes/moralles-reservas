# Reorganização do painel da plataforma (`/platform`) — design

Data: 2026-10-15 · Aprovado em conversa pelo Yuri (formato "A — menu por assunto").

## Objetivo

Hoje o painel do super-admin mistura assuntos: as chaves globais (Datafy, Stripe, Asaas) ficam em "Automação" junto da lista de unidades; a configuração de WhatsApp/IA de cada loja só é alcançável por esse item de nome vago; Planos e Implantações ficam escondidos atrás de botões em Cobranças; três listas de empresas/unidades não se ligam. O objetivo é que cada coisa tenha um lugar óbvio, com o menu agrupado por assunto e as chaves numa página só delas.

Quem usa: só o platform admin. Tarefas frequentes (todas): configurar loja, acompanhar cobranças, cadastrar empresa, instâncias/custos WhatsApp.

## Restrições

- Reorganização pura de frontend: nenhuma Edge Function, migration, RLS ou permissão muda. Tudo continua atrás do `PlatformGuard`.
- Endereços antigos continuam válidos. `manage-stripe-accounts` monta o retorno do onboarding Stripe Connect em `/platform/automacao/<slug>?stripe=complete`, e `create-billing-checkout`/`manage-whatsapp-implementations` devolvem para `/platform/billing/<orgId>`. Por isso: rotas `/platform/billing/*` não mudam, e `/platform/automacao/:slug` vira redirect que preserva query string e hash.

## Menu

```
CLIENTES        Empresas                 /platform/empresas
                Unidades (WhatsApp e IA) /platform/unidades
FINANCEIRO      Cobranças                /platform/billing  (+ /platform/billing/:orgId)
                Planos                   /platform/billing/planos
                Implantações WhatsApp    /platform/billing/implementacoes
WHATSAPP        Instâncias e custos      /platform/instancias-whatsapp
CONFIGURAÇÕES   Integrações e chaves     /platform/integracoes
                Admins da plataforma     (desativado, como hoje)
```

Estado ativo: casa por prefixo de segmento; "Cobranças" exclui `/platform/billing/planos` e `/platform/billing/implementacoes` (cada um acende sozinho), mas acende no detalhe `/platform/billing/:orgId`.

## Rotas

- Novas: `/platform/unidades`, `/platform/unidades/:unitSlug` (a página existente `src/pages/gestao/Automacao.tsx`), `/platform/integracoes`.
- Redirects: `/platform` → `/platform/empresas`; `/platform/automacao` → `/platform/unidades`; `/platform/automacao/:unitSlug` → `/platform/unidades/:unitSlug` preservando `search` e `hash`.

## Páginas

1. **Integrações e chaves** (nova, conteúdo saído de `platform/Automacao.tsx`): um cartão por fornecedor — Datafy, Stripe (com a URL do webhook), Asaas, "Outras chaves" (só se houver chave não mapeada). Mesmos campos, máscara, salvar/remover e confirmações. Texto do Stripe passa a apontar "Unidades › Configurar › Pagamentos". Nota de criptografia vai para o cabeçalho. Lista trata erro com "Tentar novamente".
2. **Unidades** (nova, tabela saída de `platform/Automacao.tsx`): Empresa, Unidade, Slug, Configurar → `/platform/unidades/:slug`. Filtro `?empresa=<orgId>` com aviso "Unidades de X · Ver todas". Quatro ramos: carregando, erro, vazio, lista.
3. **Configuração da loja** (`gestao/Automacao.tsx`): título passa a ser o nome da unidade, subtítulo "WhatsApp e IA · <empresa>"; "Voltar" → `/platform/unidades`.
4. **Empresas**: menu da linha ganha "Ver cobrança" (`/platform/billing/:orgId`) e "Unidades (WhatsApp e IA)" (`/platform/unidades?empresa=:orgId`).
5. **Cobranças**: saem os botões de topo "Implantações de WhatsApp" e "Gerenciar planos". **Planos**: sai o botão voltar. Detalhe da empresa mantém o voltar.
6. `platform/Automacao.tsx` é removida. Texto em `gestao/relatorios/Comunicacao.tsx` passa a citar `/platform/unidades`. `CLAUDE.md`/`AGENTS.md` atualizados juntos.

## Fora do escopo

Ficha da empresa, mudanças dentro das telas financeiras, mover arquivos de pasta, tela de admins.

## Testes

- Redirect `/platform/automacao/:slug?stripe=complete#x` chega em `/platform/unidades/:slug?stripe=complete#x` (controle positivo: sem `search` o teste falha).
- Estado ativo do menu por endereço (Cobranças no detalhe sim, em Planos/Implantações não).
- Todo `to` do menu corresponde a uma `Route` declarada em `App.tsx`.
- Integrações mantém o comportamento do token Datafy (teste atual transferido).
- Filtro por empresa em Unidades.
- `npm run typecheck`, `npm run lint`, `npm test`.
