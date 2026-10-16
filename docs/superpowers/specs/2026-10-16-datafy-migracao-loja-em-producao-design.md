# Migração de loja em produção da UazAPI para o WhatsApp oficial (Datafy)

- **Data:** 2026-10-16
- **Status:** aprovada pelo responsável em 2026-10-16. Inclui a criação de cadastro de cliente para quem entra na fila pública (§8).
- **Branch:** `feat/datafy-migracao-uazapi`
- **Primeira loja:** Ren Sushi (único cliente ativo, vitalício; hoje opera na UazAPI)
- **Predecessora:** [conexão self-service Datafy](2026-10-13-datafy-parceiro-conexao-self-service-design.md), cuja decisão nº 3 deixou a migração de loja em produção para uma entrega própria.

## 1. Problema

A conexão oficial self-service só funciona em unidade **sem canal**. Uma loja que já opera na UazAPI recebe 409 (`UNIT_ALREADY_ACTIVE`) ao clicar em **Conectar WhatsApp oficial**. Assim que existe uma liberação, a tela `/g/:slug/whatsapp` passa a mostrar só o cartão oficial e esconde a conexão atual, com QR e reconexão. O bloqueio está em sete pontos:

- quatro chamadas SQL de `assert_datafy_first_configuration`: autorização de mutação, finalizador, intenção de ativação e ativação;
- três verificações em TypeScript: `startConnection`, `assertDatafyBinding` e `begin_switch`.

Destravar a troca de canal não basta. Na API oficial, mensagem iniciada pela loja fora da janela de 24h só é entregue com template aprovado. Hoje:

- o despacho por template nunca foi ligado em produção (flags `whatsapp_template_catalog` e `whatsapp_automation_dispatch` estão OFF);
- "mesa pronta" e "reserva cancelada" não têm template;
- mensagem manual do painel sai como texto livre sem checar a janela;
- os dois templates de marketing exigem opt-in individual, e nenhum fluxo público o coleta.

## 2. Decisões (responsável, 2026-10-16)

| # | Decisão | Consequência |
|---|---|---|
| 1 | **Preparar antes, cortar depois.** | A loja conecta o número na oficial e volta a UazAPI por QR. O canal oficial fica pronto e **parado** até o admin disparar a troca. |
| 2 | **Templates de "mesa pronta" e "reserva cancelada" entram antes do corte.** | O catálogo oficial passa de 7 para 9 modelos. Os dois produtores ganham o caminho do despacho gerenciado. |
| 3 | **O número do Ren Sushi já está no app WhatsApp Business.** | Pré-requisito da coexistência (app 2.24.17 ou superior) atendido. A operação ainda confere a versão no dia. |
| 4 | **A coleta de opt-in de marketing entra nesta entrega.** | O próprio cliente consente no formulário público, por um checkbox individual desmarcado. Nada marca a base em massa: a regra de 2026-10-03 continua valendo. |
| 5 | **Entrega em fases, uma por chat.** | Cada fase fecha com gates, commit e checkpoint no plano. O passo seguinte vai no prompt de handoff. |

## 3. Fatos que moldam o desenho

- **A Meta desconecta todos os aparelhos vinculados ao conectar o número na Cloud API.** A UazAPI é um aparelho vinculado (emula o WhatsApp Web), então cai nesse instante. A Meta permite revincular companheiros suportados (todos, menos WhatsApp para Windows e WearOS), e mensagens de companheiro suportado geram `smb_message_echoes`. Fonte: [Meta — Onboarding WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).
- **A troca atômica já existe.** `activate_whatsapp_channel` desliga as outras linhas e liga a alvo na mesma transação. Ela exige intenção durável quando já há canal ativo, e a linha anterior é preservada. Reverter é outro `begin_switch` para o provider antigo.
- **O finalizador da assinatura pede a ativação sozinho.** `finalize_datafy_channel_subscription` chama `request_whatsapp_channel_activation`, e o webhook ativa ao chegar o eco. Sem mudança, o canal oficial trocaria sozinho no primeiro eco.
- **O canal oficial inativo registra a prova de eco antes de descartar o inbound** (`webhook-whatsapp/index.ts`, prova em ~2830 e descarte em ~2891). Com a UazAPI ativa, não há processamento duplicado.
- **O catálogo de templates exige o canal conectado, não ativo** (`refreshTemplateChannel`). Já a liberação de **despacho** exige o canal ativo.
- **O modelo de consentimento já existe.** É um registro append-only por (unidade, cliente), com link de descadastro e checagem antes do envio. Hoje só owner, gerente ou admin registram, e só com as origens `customer_message`, `signed_form` e `in_person`.
- **A fila pública não cria cadastro de cliente** (`enter_waitlist` grava só nome e telefone). Por isso `fila_feedback_v1` recusa com `customer_not_alive` mesmo com opt-in.

## 4. Fluxo de ponta a ponta

1. O admin libera a **migração** da unidade. A liberação fica presa ao canal operacional atual.
2. Num horário de pouco movimento, owner ou gerente abre `/g/:slug/whatsapp`. A tela mostra a **conexão atual** (UazAPI) e o cartão de **migração**.
3. A loja conecta pela Datafy. A UazAPI cai e a tela orienta gerar novo QR no cartão da conexão atual. A UazAPI volta em minutos.
4. **Já concluí a conexão** confirma e assina. O canal oficial nasce **inativo**, sem intenção de ativação.
5. A primeira mensagem do app, ou da UazAPI revinculada, prova a coexistência. O canal fica **pronto para corte** e a UazAPI segue atendendo.
6. Na Fase 6, com a loja ainda na UazAPI:
   - o admin liga o catálogo e submete os 9 templates na WABA da loja;
   - acompanha a aprovação;
   - autoriza o custo de marketing.
   - O opt-in já vem sendo coletado desde o deploy da Fase 4.
7. O admin dispara **Ativar / trocar** no canal oficial. A UazAPI é desligada na mesma transação, e logo em seguida o admin libera o despacho.
8. Durante a janela de reversão (7 dias), a linha UazAPI fica inativa e revinculada. Depois, o admin desconecta a instância UazAPI.

## 5. Fase 1 — Mecânica da migração de canal

### 5.1 Liberação de migração

- A coluna `whatsapp_official_connection_grants.replaces_channel_id uuid` é nula na liberação comum.
- Um trigger `BEFORE INSERT` calcula o valor sob lock da unidade e dos canais ordenados, com a mesma regra de binding de `resolveUnitChannelBinding`:
  - se o binding atual é de provider ≠ `datafy`, grava o id dele;
  - caso contrário, grava `NULL`.
- **Valor vindo do chamador é sempre sobrescrito**: o servidor decide, nunca o corpo da requisição.
- Um trigger `BEFORE UPDATE` torna a coluna imutável.
- Liberação comum já existente (sem `replaces_channel_id`) não vira migração. O admin revoga e libera de novo.

### 5.2 Autoridade SQL única

O corpo de `assert_datafy_first_configuration(p_unit_id)` passa a aceitar, além de "sem binding" ou "binding datafy", um terceiro caso. O binding atual é de outro provider **e** existe liberação da unidade que:

- não foi revogada;
- tem `replaces_channel_id = binding.id`;
- tem `consumed_channel_id` nulo ou apontando para um canal `datafy` da mesma unidade.

A assinatura da função não muda. As quatro chamadoras continuam valendo sem reescrita, e a ACL do objeto sobrevive (`create or replace`).

- Se o binding mudar depois da liberação (outro canal ativado), a liberação deixa de valer e a operação recusa com `datafy_migration_not_supported`.
- Limite aceito: a checagem não amarra o canal **alvo**. Outra linha `datafy` da mesma unidade exigiria seu próprio onboarding e liberação, e a ativação já exige assinatura confirmada e prova de eco.

### 5.3 Ativação retida

`finalize_datafy_channel_subscription` só pede intenção e ativa quando a liberação usada **não** é de migração. Com `replaces_channel_id` preenchido, ele:

- consome a liberação;
- conclui o onboarding;
- devolve `finalized`;
- não grava `activation_requested_at`.

Sem intenção, o eco nunca ativa: o webhook já exige intenção para chamar `activate_whatsapp_channel`. O vínculo administrativo (`p_grant_id` nulo) não muda.

### 5.4 Corte e reversão

- **Corte:** o admin usa o **Ativar / trocar** existente no canal oficial (`begin_switch`). A recusa em TypeScript de `begin_switch` passa a aceitar o caso de migração. A autoridade continua no SQL, que é quem recusa ou deixa passar. O diálogo do botão, para canal `datafy` em migração, mostra:
  - o canal substituído;
  - o estado dos templates (adotado, pendentes ou bloqueados);
  - o aviso de que o despacho precisa ser liberado logo após o corte.
- **Reversão:** **Ativar / trocar** no canal UazAPI, também existente. Se a UazAPI estiver desvinculada, o fluxo gera QR para a loja escanear. A assinatura Datafy continua ativa até o admin cancelar.

### 5.5 Teto de conexões

`gatesAllowed` passa `replacementConnectionRecorded: true` quando a liberação é de migração. Sem isso, uma instância UazAPI não encerrada consumiria a vaga do plano e a migração receberia `PROVISIONING_BLOCKED`.

### 5.6 Backend do onboarding

- `startConnection`, `assertDatafyBinding` e `confirm`/`subscribe` aceitam binding de outro provider somente quando a liberação ativa ou usada está presa ao id desse binding. O id vem na consulta de canais, junto com o provider.
- `decideStartStep` ganha a entrada `migrationAllowed`.
- `official_connection_state` passa a devolver `migration: { fromProvider }`, ou `null`. Só o nome do provider é exposto, sem id nem credencial. O campo vale enquanto houver liberação de migração ativa ou consumida por canal `datafy` ainda inativo.
- `deriveOfficialChecklist` ganha `migrationHold`. Com assinatura e eco prontos e o canal ainda inativo, a etapa é `awaiting_cutover`, não `awaiting_echo`.

### 5.7 Tela da loja (`/g/:slug/whatsapp`)

- **Com migração:** a tela mostra **as duas** coisas:
  - o cartão **Conexão atual** (lifecycle do binding, com QR, reconectar e status);
  - o cartão oficial em modo migração, com o aviso antes de conectar: "Ao conectar, o WhatsApp desconecta os aparelhos vinculados, inclusive a automação atual. Logo depois, gere um novo QR Code em Conexão atual e escaneie para a automação voltar. Faça num horário de pouco movimento."
  - Em `awaiting_cutover`, o cartão oficial diz: "Canal oficial pronto. A troca será feita pelo suporte."
- **Sem migração:** o comportamento atual não muda.
- **A copy de `UNIT_ALREADY_ACTIVE` passa a ser:** "Esta unidade já usa outra conexão de WhatsApp. Fale com o suporte para migrar para a API oficial."

### 5.8 Painel da plataforma

- No `DatafyAdminCard`, a ação de liberar vira **Liberar migração para oficial** quando a unidade tem binding de outro provider. O diálogo explica a queda momentânea, a reconexão por QR e que o corte é manual.
- O cartão mostra "Migração: substitui o canal UazAPI ‹id8›" e o checklist com `awaiting_cutover`.

### 5.9 Janela de queda (limite aceito)

- Entre conectar na Datafy e reescanear o QR, que leva minutos, mensagens recebidas não entram no sistema. Elas continuam visíveis no celular.
- O canal oficial inativo só registra o eco.
- A operação combina horário e acompanha a reconexão.

## 6. Fase 2 — Templates "mesa pronta" e "reserva cancelada"

**Dois modelos novos no catálogo**, ambos UTILITY e versão 1, com os corpos de [templates-oficiais-meta-propostas](2026-09-22-templates-oficiais-meta-propostas.md) §3 e §7:

- `fila_mesa_pronta_v1`: variáveis `customer`, `unit`, `queue_code`; kind `waitlist_table_ready`.
- `res_cancelada_v1`: variáveis `customer`, `unit`, `date`, `time`, `people`, `reservation_code`; kind novo `cancellation`.

**No SQL, uma migration nova:**

- alarga as listas fixas de IDs, os CHECKs de kind e os `CASE` kind→template:
  - `enqueue_whatsapp_automation`;
  - `whatsapp_automation_post_core`;
  - `change_whatsapp_automation_pins`;
  - `guard_whatsapp_template_scope`;
  - `confirm_whatsapp_template_post`;
  - `revalidate_whatsapp_template_job`;
  - `prepare_whatsapp_template_provision`;
  - CHECK de `logical_id`;
  - CHECK de `kind` e `kind`↔recurso;
  - pin tuple;
- aceita reserva `cancelled` **somente** para o kind `cancellation`;
- recusa a mesa pronta quando a entrada saiu de `notified`/`waiting` ou foi sentada.

**TTL:** `cancellation` ganha prazo de 24h, porque o ledger exige `expires_at`. Depois do horário da reserva, a checagem de "reserva no passado" descarta o envio. O comentário e o teste que hoje fixam `cancellation` como sem prazo são atualizados com essa razão.

**Gêmeo TS↔SQL:** um teste novo compara o catálogo em TypeScript com as listas de IDs das migrations, no padrão do gêmeo de touchpoints. Hoje nada impede as duas fontes de divergirem.

**Ordem de deploy:**

- SQL antes de EF: semear o catálogo novo contra o CHECK velho falha a conta inteira.
- O `snapshotSchema` do frontend deixa de exigir tamanho exato do catálogo e aceita catálogo maior. Sem isso, o desencontro entre frontend e EF quebra as telas de Comunicação.

## 7. Fase 3 — Produtores, telas e janela de 24h

**`send-cancellation`:**

- Unidade adotada vai pelo despacho gerenciado (`send-scheduled-whatsapp`, kind `cancellation`); unidade não adotada segue no texto livre.
- O controle de acesso continua o mesmo: JWT de membro e `hasUnitAccess`.
- A reserva voltar a `confirmed` cancela o envio.

**Mesa pronta:**

- A tela Operacional → Fila, para unidade adotada, chama uma ação servidor que monta os parâmetros e usa o relógio do servidor como `fact_at`.
- `resend-notification` passa `table_ready` pelo `dispatch_existing`.
- `useResendWaitlistEntered` deixa de contornar o caminho gerenciado.
- A unidade não adotada continua com o texto editável.

**Comunicação:**

- Em `fila/Comunicacao.tsx`, "mesa pronta" mostra o status do template oficial quando o modo é oficial.
- `reservas/Comunicacao.tsx` ganha a linha de cancelamento.
- Os testes de superfície que fixavam "table_ready manual" são atualizados.

**Janela de 24h:**

- `send-manual-message` recusa com 409 `OUTSIDE_SERVICE_WINDOW` quando o canal ativo usa payload Meta (`isMetaShapedProvider`) e a última mensagem do cliente na conversa tem mais de 24h.
- O painel de Conversas mostra o aviso e desabilita o envio nesse caso.
- Providers não oficiais não mudam.

## 8. Fase 4 — Opt-in de marketing

- **Formulários:** checkbox **desmarcado** no wizard de reserva (`/r/:slug` e widget `/w/:slug`) e na fila pública: "Quero receber ofertas e benefícios do ‹unidade› pelo WhatsApp. Posso cancelar quando quiser pelo link enviado em cada oferta."
  - Sem o checkbox marcado, nada é gravado.
- **Registro da reserva:** `create-reservation`, com service role, grava o evento `opt_in`/`promotional` com:
  - `source_code='public_form'`;
  - `evidence_reference='reservation:<id>;form:v1'`;
  - `actor_id` nulo.
  - A gravação passa por uma RPC nova `record_public_promotional_opt_in(unit, customer, reference)`, executável só por `service_role`. Ela aceita somente `opt_in` promocional e unidade pública, e mantém os guards de cliente vivo e organização.
- **Fila pública:**
  - A entrada passa a ir por uma Edge Function pública nova, que chama `enter_waitlist`, resolve o cliente por `resolveOrCreateCustomer` e grava o opt-in pela mesma RPC.
  - **Mudança de produto:** quem entra na fila pública passa a ganhar cadastro de cliente, como já acontece na reserva. É isso que permite o feedback da fila.
  - A Edge Function herda as guardas do `enter_waitlist` anônimo (unidade e org públicas) e tem rate limit por IP.
- **Cadastro do cliente (Clientes):** mostra o status de ofertas por unidade (`consent_snapshot`) para owner e gerente.
  - O registro manual continua na tela de Giftback, com as três origens atuais.
- **Precedência:** `do_not_contact=true` continua acima de tudo, e o link de preferência continua sendo o descadastro.

**Limite aceito:** formulário não prova a titularidade do telefone. Mitigação:

- link de descadastro em toda oferta;
- `do_not_contact`;
- limite de frequência promocional (padrão 7 dias).

**Fora de escopo:** opt-in pelo agente de IA e intercept de "SAIR". A equipe segue registrando manualmente com a origem `customer_message`.

## 9. Fase 5 — Gates integrados e rollout

**Gates:**

- review da branch inteira;
- `npm run typecheck`, `npm test`, lint e build;
- pré-voo local (harnesses novos das Fases 1, 2 e 4);
- os seis gates `saas-shield-br`;
- `acl-estatico`;
- auditoria de ACL no banco pelo procedimento autorizado.

**Rollout, com autorização explícita:**

1. Pré-voos somente leitura.
2. `supabase db push` em ordem.
3. EFs pela matriz do runbook. O núcleo de templates mexe nas EFs de despacho, `manage-whatsapp-templates`, `process-whatsapp-templates`, `send-cancellation`, `send-whatsapp`, `resend-notification` e na EF nova da fila.
4. Merge e frontend.

**A Fase 1 pode ir a produção antes**, com autorização separada: ela não muda nenhuma loja sem liberação de migração e permite à loja conectar e começar a prova de coexistência enquanto as Fases 2–4 são construídas.

## 10. Fase 6 — Operação do Ren Sushi

**Pré-corte:**

- conferir a versão do app;
- liberar a migração;
- acompanhar a conexão e o novo QR da UazAPI;
- confirmar a assinatura e a prova de eco;
- ligar `whatsapp_template_catalog`;
- liberar o catálogo no canal e sincronizar os 9 templates;
- acompanhar a aprovação e a categoria efetiva;
- autorizar o custo de marketing.

**Corte:**

- **Ativar / trocar** no canal oficial;
- ligar `whatsapp_automation_dispatch` e liberar o despacho no canal;
- testar uma confirmação, uma mesa pronta, uma mensagem manual e uma resposta da IA;
- conferir o painel de Entregas.

**Pós-corte:**

- monitorar por 7 dias;
- na janela de reversão, a UazAPI fica revinculada e inativa;
- desconectar a instância UazAPI.

Cada passo pago ou destrutivo exige confirmação nominal do canal com o responsável.

## 11. Riscos e limites aceitos

- **Queda de minutos ao conectar** (§5.9).
- **Clientes antigos sem opt-in deixam de receber ofertas após o corte.** Hoje recebem por texto livre sem consentimento registrado; depois do corte, só recebe quem consentir.
- **A Meta pode reclassificar um template UTILITY como MARKETING.** O código já bloqueia esse caso; a operação decide por um modelo novo.
- **Custo:** a Datafy cobra R$ 49,90/mês proporcional durante a preparação; a Meta cobra por template, pago pela loja.
- **Mensagem manual fora da janela de 24h passa a ser recusada no oficial.** Antes saía e falhava em silêncio.
- **Não há exactly-once distribuído entre provider e banco.** Os limites já documentados continuam valendo.

## 12. Invariantes novos (par CLAUDE.md/AGENTS.md)

- Liberação de migração é presa pelo servidor ao binding do momento da liberação. Binding diferente invalida a liberação.
- Liberação de migração nunca pede intenção nem ativa sozinha. O corte é o `begin_switch` explícito do admin.
- `cancellation` e `waitlist_table_ready` de unidade adotada vão pelo despacho gerenciado.
- O catálogo TS e as listas SQL têm teste gêmeo.
- Opt-in público só por checkbox individual, via RPC service-role com origem `public_form`.
- `send-manual-message` respeita a janela de 24h em provider de payload Meta.
