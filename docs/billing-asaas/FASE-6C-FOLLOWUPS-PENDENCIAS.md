# Fase 6c — follow-ups dos follow-ups: o que o review encontrou e não entrou

**Data:** 07/08/2026
**Origem:** review whole-branch de `fase-6c/followups-do-review`.
**Spec:** [../superpowers/specs/2026-08-07-fase-6c-followups-design.md](../superpowers/specs/2026-08-07-fase-6c-followups-design.md).

O review não achou bloqueante. Achou nove pontos não-bloqueantes; **seis entraram
na branch** e três estão registrados aqui, com o motivo de não terem entrado.

Este documento existe pela mesma razão que a frente de origem: descartar com um
porquê escrito vale mais que corrigir por zelo — e mais ainda que descartar em
silêncio.

---

## O que entrou (para o leitor não procurar aqui)

| # | Achado | Onde |
|---|---|---|
| 1 | Discriminador do `23505` era aproximação, não equivalência | EF + `CYCLE-3` no harness |
| 3 | Guarda de unidade recusava mover instância já `ENDED`, com copy falsa | EF + guardrail |
| 5 | Mensagem do 409 dizia "registrar" num caminho que move | EF |
| 6 | "Tente de novo" vs "Tente novamente" nos 503 vizinhos | EF |
| 7 | `AWAITING_PROVISION` rotulado "ativa" — defeito duplicado, não extraído | `conflictLifecycleLabel` + testes |
| 8 | `conflicts` vazio deixava o 409 sem banner E sem toast | `UpdateInstanceDialog` |

O achado 1 era o único defeito real de correção: *"existe linha com esta
`cycle_start`?"* não é o mesmo que *"o `23505` veio do `instance_start_idx`"*.
Com um ciclo `CLOSED` começando em X e um `OPEN` começando em Y, confirmar X
encontrava a linha de X e concluía "reexecução" — gravando a projeção
divergente, que é exatamente o dano que o ramo existe para impedir. O
discriminador passou a ser o **ciclo OPEN**, e o caso `CYCLE-3` mede os dois
lados no mesmo estado: a aproximação diz "reexecução", o exato diz
"divergência".

---

## 1. O 409 `OPEN_CYCLE_DATE_MISMATCH` não tem porta de reparo self-service

**O achado.** A mensagem manda "confira os ciclos desta instância", mas o painel
não oferece nenhuma forma de corrigir a `cycle_start` de um ciclo `OPEN`.
`correct_cycle_cost` toca só **custo**, e só em `PENDING_REVIEW`. A única entrada
real do estado — a falha parcial da projeção — deixa o administrador sem saída
pelo painel.

**Por que não entra agora.** A porta que faltaria é *"editar a data de um ciclo
aberto"*, e isso não é um botão: é uma política. O ciclo é histórico imutável do
que o fornecedor cobrou, e a 088 o declara assim. Abrir a edição da janela sem
decidir antes **quem** pode, **com que evidência** e **o que acontece com o
`provider_due_on` derivado** trocaria um beco por uma porta que reescreve fato
financeiro — que é a classe de problema que a 6c inteira existe para fechar.

**Não é regressão.** Antes deste lote o mesmo estado era alcançado e a projeção
era gravada divergente **em silêncio**. Hoje ela é recusada e nomeada. O beco é
novo; o dano que ele substitui era pior e invisível.

**Quando resolver.** Junto com a política de correção de ciclo — provavelmente a
mesma decisão que hoje falta para reabrir ciclo `CLOSED` (registrada na
[FASE-6C-PENDENCIAS](FASE-6C-PENDENCIAS.md)). Enquanto não existir, o reparo é
manual e auditado, como qualquer correção de ciclo fechado.

---

## 2. Move cross-tenant por API direta devolve o erro errado primeiro

**O achado.** Se a unidade de destino é de **outra organização** E já tem
instância, o `update_instance` responde 409 `UNIT_ALREADY_HAS_INSTANCE`. Só
depois de o chamador reconhecer o conflito é que a trigger de tenant dispara e
ele recebe o 23514 real — *"unidade ou canal pertence a outra organização"*.

**Por que não entra.** Corrigir a ordem exigiria uma consulta a mais (a
organização da unidade de destino) **em todo** move, para melhorar a mensagem de
um caso que a UI não produz: `UpdateInstanceDialog` filtra as unidades pela
organização da instância. O caminho é de chamada direta à Edge Function, que é
exclusiva de `platform_admin`.

**O que NÃO está errado.** A operação continua sendo recusada nas duas ordens. O
que muda é qual das duas recusas o chamador lê primeiro — não *se* ele é
recusado. Nenhum estado inválido é alcançável por esta porta.

---

## 3. `update_instance` devolve 404 para instância inexistente só quando o patch traz `unit_id`

**O achado.** A leitura nova (`loadInstanceState`) roda apenas no ramo do
`unit_id` não-nulo. Um patch sem `unit_id` sobre instância inexistente continua
caindo no 500 genérico do `.single()`, como sempre caiu.

**Por que não entra.** É assimetria de **mensagem de erro** sobre um recurso que
não existe, num painel de `platform_admin`. Uniformizar significa uma leitura a
mais em todo `update_instance` — custo real de latência para melhorar o código
HTTP de um caso que não corrompe nada e não é alcançável pela UI (que só oferece
o diálogo a partir de uma instância da lista).

**A assimetria é herdada, não criada.** O caminho sem `unit_id` se comporta
exatamente como antes deste lote.
