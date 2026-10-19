# Proposta — textos mais humanos para os nove modelos oficiais

**Estado:** aprovada pelo responsável em 2026-10-17 somente para implementação local; emenda de seleção manual por conta existente aprovada explicitamente em 2026-10-19, também só local. Essas aprovações não cobrem `db push`, deploy, submissão à Meta, ativação de despacho nem envio a clientes.

## Objetivo e limites

Dar aos nove avisos `pt_BR` uma voz mais natural, com linhas em branco entre blocos e no máximo um emoji contextual por mensagem. A informação operacional vem primeiro. Nome da loja, número de pessoas, códigos, links, finalidade, gatilhos, ordem dos parâmetros, consentimento e regras de envio continuam com a mesma autoridade da versão 1. O aviso de cancelamento permanece sóbrio, sem emoji.

Os modelos já enviados à Ren Sushi são imutáveis na versão 1: alterar BODY, FOOTER, exemplos ou categoria muda os hashes protegidos pela allowlist SQL. A proposta usa nomes técnicos `*_v2` e versão lógica 2, sem editar ou repetir POST de `*_v1`. A política automática ainda desligada deve continuar presa ao digest aprovado da versão 1 até existir migration, testes, revisão, autorização de rollout e liberação administrativa próprios para a versão 2. A função SQL atual de digest exige nove linhas em toda a allowlist; a migration v2 deve separar coortes e preservar exatamente o digest v1 antes de inserir outras nove linhas. A projeção de catálogo também deve identificar a versão verdadeira e não publicar v2 como v1 por mera inclusão no objeto TS. Aprovação de texto pelo responsável não autoriza envio a clientes, ativação de despacho, mudança de categoria nem chamada à Meta.

O GET remoto da Ren Sushi mostrou `INCORRECT_CATEGORY` em `fila_entrada_v1` e `fila_mesa_pronta_v1`, ambos solicitados como `UTILITY`. A captura do painel traz só aviso genérico; novo GET às 15h35 BRT mostrou ambos `IN_APPEAL`. Aguardar a análise oficial da categoria com exemplos fictícios; se a Meta mantiver a recusa, rever esses dois textos e a categoria com decisão de custo específica antes do POST v2. Não classificar os dois como `MARKETING` por tentativa nem criar fallback de texto livre. Os outros sete modelos têm status `PENDING`; a versão 2 não presume aprovação.

**Evidência posterior (19/10/2026, 10h35 BRT):** a leitura do alvo encontrou os nove v1 `APPROVED`/`usable`, hashes iguais, categorias efetivas iguais às solicitadas e sem sync pendente. Essa aprovação é exclusiva da v1. O despacho permanece OFF.

**Seleção local por conta:** para atender também a Ren Sushi, coexistência inclui um caminho administrativo explícito de seleção/liberação v2 para conta existente, preso à conta/binding, geração, revisão e digest aprovados, com grant v2 próprio e auditoria. Os registros, IDs remotos e jobs v1 permanecem imutáveis. A política de conexões futuras não promove contas existentes; o piloto manual pode ser autorizado com essa política OFF, por grant independente. A seleção manual só habilita a preparação/submissão dos nove v2, sem despacho ou envio, e recusa trabalho v1 incerto ainda não reconciliado. A implementação local desse caminho concretiza a ausência de backfill automático; sua operação em produção exige autorização própria de alcance/custo.

## Redações propostas

As variáveis mantêm a posição da versão 1. As quebras duplas abaixo são parte do BODY. Os links reais são preenchidos pelo servidor; os exemplos de submissão usam apenas valores fictícios. Rodapé de modelos MARKETING e link de preferências permanecem os da versão 1.

### `res_confirmacao_v2` — UTILITY

```text
Olá, {{1}}! Sua reserva na unidade {{2}} está confirmada. 🍽️

Dia {{3}}, às {{4}}. Pessoas na reserva: {{5}}.
Código da reserva: {{6}}.

Confira os detalhes: {{7}}

Se precisar alterar algo, responda por aqui.
```

### `res_confirmacao_desconto_v2` — UTILITY

```text
Olá, {{1}}! Sua reserva na unidade {{2}} está confirmada. 🍽️

Dia {{3}}, às {{4}}. Pessoas na reserva: {{5}}.
Código da reserva: {{6}}.
O desconto de {{7}}% já está aplicado a esta reserva.

Confira os detalhes: {{8}}

Se precisar alterar algo, responda por aqui.
```

### `res_lembrete_dia_v2` — UTILITY

```text
Olá, {{1}}! Passando para lembrar: sua reserva na unidade {{2}} é hoje, às {{3}}. 🕒

Pessoas na reserva: {{4}}. Código: {{5}}.
Detalhes: {{6}}

Precisa ajustar algo? Responda por aqui.
```

### `res_pesquisa_reserva_v2` — UTILITY sujeita à Meta

```text
Olá, {{1}}! Queremos saber como foi o atendimento da sua reserva {{2}} na unidade {{3}}, em {{4}}. 💬

De 1 a 5, qual nota você daria? Responda apenas com o número.

Sua opinião nos ajuda a melhorar. Obrigado!
```

### `fila_entrada_v2` — UTILITY sujeita à revisão de categoria

```text
Olá, {{1}}! Sua entrada na fila de espera da unidade {{2}} foi registrada. ⏳

Senha da fila: {{3}}. Pessoas no seu grupo: {{4}}.
Acompanhe a fila: {{5}}

Avisaremos por aqui quando sua mesa estiver pronta.
```

### `fila_feedback_v2` — MARKETING

```text
Olá, {{1}}! Como foi sua experiência na fila da unidade {{2}} em {{3}}? 💬

Se quiser compartilhar sua opinião, acesse: {{4}}

Preferências de mensagens: {{5}}

Obrigado por nos ajudar a melhorar.
```

### `mkt_voucher_programado_v2` — MARKETING

```text
Olá, {{1}}! A unidade {{2}} disponibilizou um voucher para sua próxima visita. 🎁

Desconto: {{3}}%. Código: {{4}}. Válido até {{5}}.
Apresente o código ao pagar e consulte as condições com a unidade.

Preferências de mensagens: {{6}}
```

### `fila_mesa_pronta_v2` — UTILITY sujeita à revisão de categoria

```text
Olá, {{1}}! Sua mesa na unidade {{2}} está pronta. 🍽️

Senha da fila: {{3}}.

Por favor, dirija-se à recepção.
```

### `res_cancelada_v2` — UTILITY

```text
Olá, {{1}}. Sua reserva na unidade {{2}} foi cancelada.

Data: {{3}}, às {{4}}. Pessoas na reserva: {{5}}.
Código da reserva: {{6}}.

Se foi um engano ou quiser remarcar, responda por aqui.
```

## Critérios para implementação futura

1. Revisar as nove prévias renderizadas com exemplos fictícios: singular/plural, quebras em tela pequena, links clicáveis, URL sem pontuação anexada, emojis preservados e BODY/FOOTER dentro dos limites vigentes da Meta/Datafy. A [orientação oficial do WhatsApp](https://whatsappbusiness.com/wp-content/uploads/2026/04/Best-Practices-for-Marketing-Messages-on-WhatsApp-.pdf) recomenda emojis seletivos e textos concisos; não promete aprovação.
2. Introduzir catálogo/nomes versão 2 e migration de CHECKs, allowlist, hashes de conteúdo e JSON completo com exemplos. Fazer SQL antes dos bundles; não mutar a versão 1 já submetida. Resolver seleção de v1/v2 por finalidade sem duplicar intenção nem reenviar mensagens. Testar jobs existentes, homônimos, WABA compartilhada, concorrência, RLS/ACL e rollback.
3. Atualizar EFs consumidoras conforme grafo de imports, UI e documentação. Só mudar a política automática para o novo digest após testes, reviews independentes, CI, autorização de deploy e pré-voo do alvo. Ren Sushi e contas antigas não recebem backfill automático.
4. Submissão de `*_v2` à Meta exige novo alcance/custo confirmado por conta/canal; envio a clientes exige aprovação remota, categoria efetiva, consentimento e despacho autorizado separadamente. Rejeição ou resultado incerto não gera retry cego.
