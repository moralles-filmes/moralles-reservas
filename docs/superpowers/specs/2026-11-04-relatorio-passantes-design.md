# Relatório de passantes — design

Status: aprovado pelo dono em 2026-11-04 ("pode fazer como achar mais recomendado").
Plano de execução: `.tasks/relatorio-passantes/PLAN.md` (local). Branch `feat/relatorio-passantes`, base `feat/planta-do-salao`.

## Objetivo

Página própria em Relatórios para o fluxo de passantes (`walk_ins`), mais funda que a aba "Passante" do Fluxo de clientes, que continua como está. Junto, a leitura de `reservations`, `waitlist` e `walk_ins` do Fluxo passa a paginar e a recortar o período em horário de Brasília.

## Fora do escopo

Migration, RPC, Edge Function, RLS; exportação; planta do salão; paginação e fuso dos outros módulos (mudança própria, depois do inventário).

## Acesso

Rota `/g/:unitSlug/relatorios/passantes` sob `GestaoGuard`, item "Passantes" no grupo Relatórios do `GestaoLayout`. Leitura direta pelo supabase-js com `.eq("unit_id", unitId)` em toda query; RLS de `walk_ins`, `tables` e `halls` já cobre membros e `platform_admin`.

## Horário de Brasília

Todo recorte e agrupamento usa `America/Sao_Paulo`, nunca o fuso do navegador nem UTC:

- período escolhido = dias civis `from..to` (YYYY-MM-DD) → filtro `arrived_at >= {from}T00:00:00-03:00` e `arrived_at < {to+1}T00:00:00-03:00`;
- dia, hora e dia da semana de um timestamp vêm de `Intl.DateTimeFormat` com `timeZone: "America/Sao_Paulo"` (helpers em `src/lib/brt.ts`).

## Paginação

Helper genérico que repete a query com `.range(from, from + 999)` e `.order("id")` (estável) até vir página com menos de 1000 linhas. Erro de qualquer página sobe; nunca devolve parcial.

## Definições (uma linha de `walk_ins` = um grupo)

| Métrica | Regra |
|---|---|
| Grupos / pessoas | todas as linhas do período (por `arrived_at`) / soma de `party_size` |
| Sentados | `seated_at` não nulo (inclui `left` após sentar, regra da planta) |
| Desistência | `status in ('left','no_show')` e `seated_at` nulo |
| Taxa de desistência | desistências / (sentados + desistências); `null` se denominador 0 |
| Em espera | `status = 'waiting'` e `seated_at` nulo (sem desfecho; fora das taxas) |
| Tempo de espera | `seated_at − arrived_at`, só sentados que esperaram > 60 s; média e mediana |
| Sentou direto | sentados com espera ≤ 60 s; exibido em % dos sentados |
| Tempo na mesa | `released_at − seated_at`, só quem tem os dois e duração > 0; média e mediana |
| Cobertura do tempo na mesa | liberados / sentados ("N de M liberados") |
| Receita estimada | pessoas sentadas × ticket médio da unidade (mesma fonte do Fluxo); 0 sem ticket |
| Sem mesa registrada | sentados com `table_id` nulo |

Tamanho médio do grupo = pessoas ÷ todos os grupos do período (o Fluxo usa só sentados; aqui interessa quem chegou). Salão e mesa contam só sentados; `table_id` nulo ou mesa inexistente vira "Sem mesa"/"Sem salão". Cada grupo pertence ao dia BRT da chegada.

Recortes: por dia (linha), por hora de chegada 0–23, por dia da semana Seg–Dom, mapa hora × dia da semana, por tamanho de grupo (buckets do Fluxo, com tempo na mesa médio por bucket), por salão e por mesa (grupos, pessoas, tempo na mesa médio, giro = grupos sentados ÷ dias do período).

## Comparação

Período anterior = mesmo número de dias imediatamente antes de `from`. KPIs mostram o valor atual e a variação em % (ou em pontos percentuais para taxas); sem base (anterior 0 ou null) não mostra variação.

## Tela

Cabeçalho com breadcrumb e `DateRangePicker`; linha de KPIs (grupos, pessoas, tamanho médio, tempo na mesa, tempo de espera, desistência, receita estimada) com delta; gráficos e tabelas dos recortes; quatro estados (carregando, vazio, erro com retry, dados). Componentes e cores seguem os relatórios existentes.
