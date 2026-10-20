# Desempenho e cache

> Padrão SaaS v3.2 — documento normativo. Não edite o corpo por projeto; adaptações vão em "Particularidades deste projeto", no final.
> Leia em tarefas de lentidão, otimização, cache, bundle, carregamento de módulo ou query lenta.

## 1. Ciclo obrigatório [N1]

```text
INVESTIGAR → MEDIR (antes) → DIAGNOSTICAR → PRIORIZAR → IMPLEMENTAR → TESTAR → MEDIR (depois) → REVISAR SEGURANÇA → DOCUMENTAR
```

- Sem medição antes e depois, o relatório diz `NÃO MEDIDO`, não "melhorou".
- Nenhuma otimização entra sem evidência do gargalo.

## 2. O que não conta como otimização [N1]

- trocar spinner ou mostrar skeleton vazio;
- esconder informação;
- remover validação;
- buscar menos dados de forma incorreta;
- servir dado desatualizado sem política;
- aumentar timeout;
- desligar refetch globalmente;
- cachear resposta privada em cache compartilhado;
- melhorar só a nota do Lighthouse sem melhorar o fluxo real.

## 3. O que medir [N1]

Meça o fluxo real do usuário:

- tempo do clique até o módulo **utilizável**: dados essenciais corretos e ações disponíveis;
- latência da API e número de queries por requisição;
- bytes transferidos;
- renderizações, CPU e memória;
- espera por conexão, locks e filas;
- erros.

Reporte p50/p75/p95 com amostra adequada, separando cache frio de quente e primeiro acesso de navegação interna.

## 4. Frontend [N1]

- Divida o código por rota; carregue sob demanda bibliotecas pesadas (editor, gráfico, PDF).
- Em Next.js, prefira Server Components para dados e marcação estática, reduzindo o JavaScript enviado ao cliente.
- Store e provider por módulo, não globais. Módulo fechado não carrega estado.
- Paginação ou virtualização em listas longas.
- Cancele requisições obsoletas e controle race conditions em buscas (a última resposta vence pela ordem do pedido, não pela ordem de chegada).
- Imagens e fontes otimizadas (`next/image`, `next/font` ou equivalente).
- Acessibilidade é preservada em toda otimização.

## 5. Backend e banco [N1]

- Elimine N+1: busque em lote ou com join, com projeção explícita.
- Faça agregação no banco, não no Node.
- Para índices, planos e pooler, siga DATABASE §6.
- Mova trabalho lento para assíncrono (ARCHITECTURE §7) em vez de aumentar timeout.

## 6. Cache [N1]

Antes de criar um cache, documente:

- o dado e o dono;
- a chave (começa por `company_id`; inclui filial, usuário ou permissão quando o conteúdo varia);
- TTL e invalidação;
- consistência exigida;
- limite de memória;
- comportamento em falha;
- como a autorização é garantida no cache hit.

Regras:

- Nunca cacheie token ou segredo.
- Logout e troca de empresa invalidam os dados privados pertinentes.
- Saldo, estoque, permissões e disponibilidade seguem a consistência que o negócio exige. Por padrão, não são cacheados.
- Não use dado desatualizado indefinidamente para esconder lentidão.
- Evite stampede: coalescência de requisições ou lock na recomputação.
- **[N2]** Meça o hit rate. Cache que não acerta é só complexidade.

**Em Next.js:** a semântica de cache muda entre versões. Confira a da versão instalada. Página ou dado autenticado, por usuário ou por tenant, nunca vai para cache compartilhado sem chave de tenant/usuário.

## 7. Carga [N2]

Teste de carga só em ambiente isolado, nunca em produção, com dados sintéticos e provedores em modo fake ou sandbox.

## Particularidades deste projeto

- Fluxos críticos: portal público de reserva e fila de espera, painel operacional de reservas, webhook de WhatsApp com o agente de IA. Metas ainda não definidas (NÃO MEDIDO).
- Cache: TanStack Query no frontend (padrões em `.claude/rules/frontend.md`). Conferir que toda chave de query começa pela unidade ativa é item do plano (ACCESS_CONTROL §7).
