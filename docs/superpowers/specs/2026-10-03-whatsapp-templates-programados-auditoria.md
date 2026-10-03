# Auditoria e proposta — templates das automações WhatsApp existentes

Data: 2026-10-03. Estado: auditoria concluída; desenho/spec aprovados para preparação do plano, sem implementação de produto.

## Pedido e limites

O usuário confirmou que esta entrega abrange templates e automações existentes. O módulo Marketing fica para outra etapa. As três imagens são referências das telas existentes de lembrete, pesquisa e giftback. O prompt anexado fornece requisitos; a ressalva do usuário prevalece: preservar atendimento, IA, interação, handoff e interpretação das respostas.

Não executar deploy, migrations de produção, submissões à Meta, cobranças ou disparos reais sem a autorização específica descrita no pedido. Não apagar personalizações antigas, trocar provider automaticamente ou criar automações novas por cadastrar modelos.

## Evidência e baseline

- Git inicialmente limpo; HEAD observado pelo router: `32ebcbd`. Nenhuma mudança alheia encontrada.
- `npm run test`: 79 arquivos e 1.949 testes aprovados. A primeira tentativa foi impedida pelo sandbox do esbuild; a execução autorizada fora dessa restrição passou.
- `npm run typecheck`: exit 0 (`tsc -b --noEmit`). Esse gate não comprova tipagem de todas as Edge Functions Deno.
- Nenhuma consulta a banco de produção, homologação de conta, submissão de template, aprovação da Meta ou entrega real foi feita.
- O router delegou uma exploração limitada ao DeepSeek. O agente principal revisou o resultado e conferiu os fluxos no código. Não foram integradas suas sugestões de alterar o fallback de metadados ou permitir fallback de template para texto livre. Não houve auditoria externa de segurança.

## Arquitetura observada

Tenancy: `organizations → units → unit_members`. Contatos pertencem à organização, enquanto reservas, fila, vouchers, settings e canais levam `unit_id`. Os workers usam service role e chave interna; os guards, predicados por tenant e gates de suspensão continuam obrigatórios.

Providers registrados: `zapi`, `waha`, `uazapi`, `official` (Meta direta) e `datafy`. Todos declaram `templateMessages: false` atualmente. Meta direta e Datafy têm implementação de envio de texto; não existe método de envio de template aprovado no registry atual. Isso descreve o código, sem afirmar quais contas estão ativas em produção. Fontes: `supabase/functions/_shared/whatsapp-provider-core.ts` e `whatsapp-providers.ts`.

`whatsapp-send.ts` resolve o canal ativo no backend, preserva o fallback legado exclusivamente para linhas `is_active IS NULL`, carrega credenciais e verifica conexão/frescor antes de chamar `sendOutbound`. O provider padrão da organização não é autoridade sobre o canal em uso. O novo despacho programado precisa reutilizar esses controles.

Datafy já tem descoberta por `/me`, assinatura própria e âncora de identidade `phone_number_id`. `decideDatafyChannelSetup` grava o `waba_id` descoberto como `credentials.business_account_id`, que hoje pode ser nulo; `business_id` não é armazenado por esse núcleo. Contas existentes precisam de nova descoberta verificada quando faltar WABA, sem interromper o atendimento por essa ausência.

`useWhatsappConnection.ts` deliberadamente não expõe provider ou credenciais no snapshot do lojista. A tela de templates precisará de uma resposta específica e autorizada do backend, com modalidade e capacidades seguras; não deve ler diretamente credenciais ou inferir modalidade pelo navegador.

## Inventário e matriz de fluxos

Em todas as linhas, o provider real sai do binding backend; as categorias são propostas, nunca aprovação presumida.

| Fluxo atual | Origem e gatilho | Categoria proposta | Alteração recomendada | Regressão necessária |
| --- | --- | --- | --- | --- |
| Confirmação automática | Trigger/outbox → `process-notification-outbox` → `send-confirmation`; cron a cada minuto | UTILITY | Modelo fixo para envio automático; variante com desconto já aplicado preserva informação da transação | Pending/payment, cancelamento, dedupe, TTL, source WhatsApp excluído, e-mail preservado |
| Lembrete `reminder_d1` | `process-reservation-reminders`; `0 13 * * *` UTC = 10h BRT, no próprio dia | UTILITY | Modelo fixo no oficial; editor legado no não oficial | Data local, status, horário já passado, remarcação, flags, opt-out, duplicidade |
| Pesquisa `survey_d1` | `process-satisfaction-surveys`; `0 17 * * *` UTC = 14h BRT, sobre reservas de ontem | UTILITY sujeita à Meta | Modelo sobre a reserva específica; sem promoção ou promessa de benefício | Nota já respondida, no-show/cancelada, cron, categoria alterada, histórico e interceptação atual de 1–5 |
| Voucher de aniversário/frequência | `process-voucher-triggers`; `0 12 * * *` UTC = 9h BRT | MARKETING | Modelo fixo de voucher no oficial, preservando emissão e uso; envio condicionado a consentimento e saída funcional | Voucher persistido antes do envio no worker, suspensão, aniversário, validade, conflito 23505, retry sem novo benefício |
| Entrada na fila | Trigger → `process-waitlist-entered`, evento automático imediato | UTILITY | Equivalente fixo para automação oficial, com acompanhamento existente | Tenant, status, TTL, código da fila e duplicidade |
| Pesquisa pós-fila `waitlist_feedback` | `process-waitlist-feedback`; 14h BRT, entrada `seated` de ontem | MARKETING inicialmente, sujeita à Meta | Equivalente oficial para automação existente; preservar destino e não inventar avaliação | `seated_at`, opt-out, categoria, link, TTL e dedupe |
| Chamada de mesa `waitlist_table_ready` | Clique do operador em `src/pages/operacional/Fila.tsx` | UTILITY possível em etapa própria | Inventariada; preservar nesta entrega por ser ação operacional manual | Fluxo atual continua disponível |
| Cancelamento | `send-cancellation`, após ação efetiva no painel | UTILITY possível em etapa própria | Inventariado; preservar nesta entrega | Papéis, autorização e status continuam iguais |
| Alteração de reserva | `update-reservation` e diálogo da IA | UTILITY possível em etapa própria | Não criar novo disparo automático | Alteração salva e diálogo continuam iguais |
| Voucher após avaliação/comentário | Intercepts de `webhook-whatsapp` → preparo → resposta → commit do voucher | Integração conversacional atual | Preservar; não substituir resposta por template programado | Agradecimento, pedido de comentário, min_rating, histórico e commit pós-envio |
| Mensagem humana | `send-manual-message` | Atendimento atual | Preservar | Handoff, lock, autor e append atômico |
| Resposta da IA | `webhook-whatsapp` → `sendOutbound` | Atendimento atual | Preservar | Prompt, tools, billing/IA, sanitização, debounce, dedupe e eco |
| Reenvio em Entregas | `resend-notification` | Conforme fluxo original | Propagar modalidade/template quando o envio original programado passar ao catálogo | TTL, canal, recurso, versão, pendente/pausado e resultado incerto |
| Billing e e-mail | Workers de billing; Resend em confirmação | Fora deste catálogo de restaurante | Preservar | Sem mudança de billing ou fallback novo |

Os únicos eventos de `reservation_message_templates` são `reminder_d1` e `survey_d1`. `waitlist_message_templates` contém `entered`, `table_ready` e `feedback`. Giftback guarda `giftback_message_template` em `settings`. Os padrões e prévias ficam em `useReservationTemplates.ts`, `useWaitlistTemplates.ts` e `useGiftbackSettings.ts`; os workers possuem padrões próprios.

Mapeamento explícito: `cliente_nome` → nome do cliente; `unidade_nome`/`unidade` → unidade; `party_size` → pessoas; `discount` → percentual; `validade` → expiração; `codigo` → reserva no template de reserva e voucher no giftback; `codigo_fila` → senha da fila. Não compartilhar a chave `codigo` sem finalidade discriminada. `link_acompanhamento` e `link_status` são gerados pelo backend usando as rotas existentes.

## Riscos que mudam decisões

1. **A guarda atual de identidade rejeitaria eventos exclusivos de template.** `metaPayloadMatchesChannel` exige pelo menos um `metadata.phone_number_id`; o envelope documentado de template contém `entry.id` da WABA. O novo processamento precisa discriminar a família de evento, verificar assinatura e binding de WABA e persistir antes do ACK, mantendo a guarda atual intacta para mensagens/status/eco. Não basta retornar 200 ou relaxar a guarda geral. Lotes mistos precisam validar cada parte contra seu recurso.
2. **Confirmed não prova visita realizada.** `get_reservations_for_survey` filtra reserva `confirmed`, sem nota, contato habilitado e dia alvo. `ReservaStatus` só tem pending/confirmed/cancelled/no_show. Nesta entrega, usar redação vinculada à reserva, sem afirmar comparecimento comprovado. Não adicionar controle de presença ou mudar atendimento implicitamente.
3. **O fluxo atual recompensa certas notas.** O webhook usa `min_rating` na regra `after_rating`. Isso difere da proposta do anexo de nunca condicionar benefício à nota. A ressalva do usuário exige preservar essa interação; o novo template de pesquisa não promete recompensa. Uma alteração da regra de giftback requer trabalho de domínio separado.
4. **A emissão de voucher varia por caminho.** No webhook o commit depende do envio; no worker de aniversário/frequência o INSERT vem antes do envio e permanece mesmo em falha. A frase geral de que voucher só persiste após envio não descreve ambos. A documentação CLAUDE.md/AGENTS.md foi corrigida em conjunto para explicitar essa distinção, sem mudar o código.
5. **`do_not_contact = false` não é evidência de consentimento promocional.** Não existe ledger de opt-in/opt-out específico para essas automações. O worker de aniversário não seleciona esse campo na consulta de clientes observada. O novo despacho não pode inferir consentimento de reserva ou conversa nem de valor default. A supressão deve ser revalidada no momento do envio.
6. **Apenas bloquear edição na UI não protege o catálogo.** Os hooks fazem upsert direto em tabelas/`settings`. O catálogo oficial deve ser imutável para a loja, separado das personalizações e validado também no servidor/banco. A migration 044 cria policies de membro para templates de reserva, sem paralelo explícito platform_admin nesse arquivo; revisar o estado real e os grants antes de alterar acesso.
7. **Dedupe de registro não evita sozinho dois POSTs.** `send-whatsapp` registra depois da chamada ao provider; a unicidade em `notifications_sent` não é claim antes de enviar. O novo envio programado precisa de claim persistente e fencing, com timeout ambíguo sem retry cego. Não substituir os workers por consumidores concorrentes do mesmo evento.
8. **Sucesso HTTP pode representar descarte.** O TTL pode devolver 200 com descarte, e workers hoje contam `sendRes.ok` como despachado. Não marcar template bloqueado como enviado ou consumir a chave de dedupe; interpretar o resultado sem alterar o atendimento.
9. **As propostas anteriores não são prova remota.** `2026-09-22-templates-oficiais-meta-propostas.md` contém rascunhos, URLs e preços de referência; não comprova submissão, aprovação ou tarifa da conta. Há limites Datafy diferentes entre a auditoria antiga e a página atual. Não copiar números históricos para um novo rate limiter.

## Fontes verificadas em 2026-10-03

O navegador de pesquisa não conseguiu abrir Datafy; a consulta HTTPS das páginas públicas `.md` funcionou. Nenhum token de conta foi utilizado.

- [Índice Datafy](https://developers.datafyapi.com.br/llms.txt).
- [Criar template](https://developers.datafyapi.com.br/api-reference/whatsapp/templates/criar-template): POST `/v1/{waba_id}/message_templates`, estado inicial pendente, componentes e exemplos; `POSITIONAL` é o padrão. Categoria retornada precisa ser armazenada.
- [Listar templates](https://developers.datafyapi.com.br/api-reference/whatsapp/templates/listar-templates): GET no mesmo recurso, retorno com status/categoria/componentes; paginação por cursor na URL Datafy, sem seguir `paging.next` da Graph com token Datafy.
- [Enviar template](https://developers.datafyapi.com.br/api-reference/whatsapp/templates/enviar-template): POST `/v1/{phone_number_id}/messages`, `type: template`, nome, idioma e parâmetros correspondentes ao formato aprovado.
- [Eventos de template](https://developers.datafyapi.com.br/api-reference/whatsapp/webhooks/eventos/templates): status, qualidade, categoria e componentes são eventos de gestão, distintos de entrega e mensagem recebida. Eventos antigos ou divergentes exigem sincronização antes de liberar envio.
- [Dados da conta](https://developers.datafyapi.com.br/api-reference/whatsapp/datafy/me): `/me` fica fora de `/v1`; distinguir WABA, número e portfólio.
- [Requisições](https://developers.datafyapi.com.br/api-reference/whatsapp/visao-geral/requisicoes): limites por token, erros e paginação; 429 não autoriza retry mutante sem examinar resultado.
- [Política WhatsApp](https://business.whatsapp.com/policy): autorização do destinatário, saída respeitada e template aprovado para iniciar/retomar conversa fora da janela; autorização de envio e preço são questões separadas.
- [Cobrança Datafy](https://developers.datafyapi.com.br/guias/whatsapp/conceitos/cobranca) descreve mudança em outubro de 2026. A [página geral de preços da Meta](https://business.whatsapp.com/products/platform-pricing) consultada ainda descreve gratuidade de serviço/utilidade em resposta. Divergência registrada, sem decidir tarifa da conta nem alterar billing; não exibir custo zero ou gratuito por suposição. Nenhum mecanismo financeiro será ativado nesta etapa.

## Abordagens avaliadas

1. **Catálogo e despacho exclusivo das automações existentes, recomendado.** Reutiliza canal, cron, settings de ativação, TTL, logs e providers; acrescenta registro remoto, provisionamento durável e envio de template. Preserva o atendimento e as personalizações legadas.
2. **Trocar globalmente todo envio oficial por template.** Rejeitada: alcançaria IA, mensagens humanas e voucher após nota, contrariando a ressalva do usuário.
3. **Submeter o texto personalizado de cada loja.** Rejeitada: não atende ao catálogo fixo de plataforma e introduz aprovação por cada edição, sem resolver a restrição estrutural.

## Desenho recomendado para a próxima spec

- Catálogo global em código, versionado, pt_BR/POSITIONAL, com finalidade, tipos/limites/origens das variáveis, exemplos fictícios e hash canônico. Modelos ativos iniciais limitados aos gatilhos automáticos inventariados; nenhuma automação de remarcação, impedimento ou campanha nova.
- Registro remoto separado por organização e WABA, com unicidade e impedimento de binding da mesma WABA entre organizações diferentes. Telefones autorizados da mesma organização podem compartilhar o registro; unidades não acessam credenciais ou dados alheios.
- Provisionamento/sincronização persistente após conexão/backend verificado. Descoberta de WABA ausente, listagem paginada, comparação de conteúdo e submissão idempotente. Template externo divergente não é editado/apagado automaticamente. Rejeitado não entra em loop de submissão.
- Backend entrega modalidade, catálogo e estado client-safe para a tela. Oficial mostra corpo somente leitura, categoria solicitada/efetiva e motivo de impedimento. Não oficial preserva editor, prévia e restauração; nenhum texto antigo é apagado. Toggles de automação continuam nos ajustes atuais.
- Despacho programado recebe intenção e IDs do recurso, carrega dados/telefone/canal no servidor, escolhe template e valida categoria, integridade, idioma, variáveis, consentimento, supressão, status, TTL e claim antes do POST. Não confiar no telefone ou parâmetros de template arbitrários do navegador. Manter o contrato de envio de texto de IA/humano separado.
- Recibos continuam correlacionados por unidade/provider/canal/message_id; template enviado/lido não abre janela como inbound. Registrar o texto renderizado no histórico com author e event_id atuais, mantendo captura da nota 1–5. A gestão de templates usa handler próprio autenticado por assinatura/binding, sem chamar IA ou resolver cliente.
- Voucher programado oficial usa MARKETING. Acrescentar evidência de consentimento e saída funcional antes de liberar esse envio; desconhecido recusa apenas o envio promocional. Preferir link seguro de preferências com confirmação explícita de ação para preservar o parser de atendimento. Não adicionar comando SAIR ao diálogo sem explicitar esse ponto na revisão da spec. A emissão do benefício mantém o comportamento atual de cada caminho.
- Flags independentes começam desligadas. Sem modelo aprovado/compatível, registrar impedimento e mostrar alerta; nunca trocar de provider ou usar texto livre como fallback oficial dessa automação. Não fazer replay retroativo na ativação. Rollout usa canal piloto autorizado, migration antes das EFs e a matriz de redeploy atualizada nos dois arquivos de regras.

## Próxima etapa e dependências

Esta auditoria não é uma spec de implementação aprovada. A skill `superpowers:brainstorming`, exigida por AGENTS.md/CLAUDE.md, demanda revisão do desenho antes da escrita da spec e aprovação da spec escrita antes de `writing-plans`. Depois seguem plano revisado, implementação por tarefas, reviews e gates SaaS proporcionais ao risco.

Dependências externas: acesso autorizado a conta/número de homologação, autorização para submissão, configuração de eventos de templates na Datafy, aprovação efetiva por WABA, confirmação de regras de cobrança da conta, prova de consentimento dos contatos e autorização específica para migration/deploy de produção.

Checkpoint: auditoria e baseline concluídos; usuário aprovou desenho/spec e pediu [plano](../plans/2026-10-03-whatsapp-templates-programados.md) e prompt para outro chat implementar; código de produto intacto. A próxima execução deve partir desses documentos e da autorização do usuário, sem repetir a exploração completa.
