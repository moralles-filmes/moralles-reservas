# Templates das automações WhatsApp existentes — especificação

Data: 2026-10-03. Desenho aprovado pelo usuário; esta spec escrita aguarda revisão antes do plano. Referência: [auditoria](2026-10-03-whatsapp-templates-programados-auditoria.md).

## 1. Resultado esperado e limites

As automações existentes passam a usar um catálogo fixo de plataforma quando o canal usa API oficial. A loja acompanha a aprovação e configura a ativação das automações, sem reescrever o modelo. Nos providers não oficiais, o editor, os textos salvos, as variáveis e a restauração do padrão permanecem disponíveis.

O atendimento continua como está: prompt e ferramentas da IA, respostas de texto, mensagens humanas, handoff, locks de conversa, eco do aparelho, captura de notas/comentários e voucher após avaliação não passam pelo catálogo novo. Alterar janela de atendimento, classificação de intenção, regra de nota ou concessão de benefícios não faz parte desta entrega. A integração existente deve continuar aplicando suas guardas.

Incluídos: confirmação automática de reserva, lembrete no próprio dia, pesquisa de reserva no dia seguinte, entrada automática na fila, pesquisa pós-fila e voucher programado de aniversário/frequência. O reenvio dos tipos já permitidos deve respeitar a modalidade do envio automático original. Cancelamento, chamada manual de mesa e mensagens avulsas continuam nos caminhos existentes. O código legado que permite cancelamento no outbox não ganha produtor novo.

Não criar módulo Marketing, campanhas, públicos, segmentos, calendário de campanhas, atribuição de vendas, carteira, tarifa financeira automática ou cobrança SaaS. A categoria MARKETING de um voucher existente não implica criar esse módulo.

Implementar e testar localmente. Submissão real, número de homologação, migration/deploy e ativação em produção dependem de autorização específica. Nenhum envio à base é teste permitido.

## 2. Fronteiras de código

| Componente | Responsabilidade | Contrato |
| --- | --- | --- |
| Núcleo de catálogo em `_shared/` | Definições imutáveis, variáveis, validação, prévia e hash | Funções puras; sem DB, fetch, serve ou segredo |
| Serviço de contas/templates | Binding verificado de WABA, provisionamento e sincronização | Nunca recebe credencial pelo frontend de loja |
| Registry de providers | Métodos de listar, criar e enviar template | Capability corresponde à existência dos métodos em ambas as direções |
| Despacho de automações | Resolve recursos, canal, elegibilidade e claim; escolhe texto ou template | Intenção estruturada; nenhum texto oficial arbitrário |
| Worker de templates | Processa tarefas de provisionamento e eventos de gestão | Autenticação interna, jobs persistentes e fencing |
| Worker de automações | Retentativas conhecidas, reconciliação local e expiração | Não substitui produtores/cron existentes por produtores concorrentes |
| API de gestão | Estado client-safe, preferências e ações autorizadas | Tenant derivado do recurso; owner/gerente e paralelo platform_admin |
| Preferências públicas | Descadastramento por token opaco | GET apenas apresenta; POST confirmado altera somente a preferência autorizada |

`sendText`/`sendOutbound` conservam seus contratos conversacionais. A nova ação de template não é uma interpretação automática de todo texto oficial. Reutilizar seleção de canal, resolução de credenciais, gate de serviço e conexão/frescor de `whatsapp-send.ts`, extraindo infraestrutura comum sem alterar a decisão dos consumidores existentes.

Datafy utiliza seu cliente HTTP atual, token em header e URLs na origem fixa. Meta direta utiliza seu adapter e credenciais atuais. Não mudar versão da Graph como efeito colateral. A validação técnica atual da Meta direta e seus grants é requisito para habilitar sua capability; enquanto não comprovada, a modalidade oficial é exibida como indisponível para o novo catálogo. Não anunciar paridade nem transformar Meta direta em conexão não oficial por ausência dessa capability.

## 3. Catálogo inicial

Idioma `pt_BR`, formato `POSITIONAL`, versão lógica 1. Categoria solicitada e efetiva são campos diferentes. Toda definição contém finalidade, gatilhos permitidos, componentes, variáveis em ordem, exemplos fictícios, estado `active|superseded|retired` e hash canônico.

As redações abaixo são propostas para submissão, sem aprovação presumida. Usam BODY e, nos promocionais, FOOTER. Nesta versão os links ficam no corpo, gerados pelo servidor: isso preserva o acesso aos detalhes sem depender de combinações de botões dinâmicos cuja documentação Meta não pôde ser conferida nesta sessão (HTTP 429). Acrescentar botão altera conteúdo e exige nova versão/revisão. Não usar URLs de demonstração em produção.

### 3.1 Confirmação — `res_confirmacao_v1`, UTILITY

> Olá, {{1}}. Sua reserva em {{2}} está confirmada para {{3}}, às {{4}}, para {{5}} pessoa(s).
> Código da reserva: {{6}}.
> Detalhes da reserva: {{7}}.
> Para solicitar uma alteração, responda a esta mensagem.

Parâmetros: cliente, unidade, data, hora, pessoas, código da reserva e link de acompanhamento. Exemplo fictício: Marina; Restaurante Exemplo; 20/10/2026; 20:30; 4; RES123; link de exemplo com UUID fictício. Só reserva efetivamente confirmed e pagamento compatível. Preservar a exclusão de source WhatsApp e a intenção de notificação manual já existente.

### 3.2 Confirmação com desconto aplicado — `res_confirmacao_desconto_v1`, UTILITY

> Olá, {{1}}. Sua reserva em {{2}} está confirmada para {{3}}, às {{4}}, para {{5}} pessoa(s).
> Código da reserva: {{6}}. Desconto já aplicado à reserva: {{7}}%.
> Detalhes da reserva: {{8}}.
> Para solicitar uma alteração, responda a esta mensagem.

Parâmetros iguais à confirmação, com percentual antes do link. Exemplo adicional: 15. Escolher somente quando `applied_discount_percent > 0`. Trata de condição já aplicada à transação; se a categoria efetiva não for UTILITY, bloquear esse modelo e informar reclassificação, sem omitir o desconto ou trocar para texto livre.

### 3.3 Lembrete — `res_lembrete_dia_v1`, UTILITY

> Olá, {{1}}. Este é o lembrete da sua reserva de hoje em {{2}}, às {{3}}, para {{4}} pessoa(s).
> Código da reserva: {{5}}.
> Detalhes da reserva: {{6}}.
> Para solicitar uma alteração, responda a esta mensagem.

Parâmetros: cliente, unidade, hora, pessoas, código da reserva, acompanhamento. Exemplo: Marina; Restaurante Exemplo; 20:30; 4; RES123; link fictício. Somente na data local da reserva, confirmed, antes do início, sem bloqueio de contato ou envio lógico já aceito. Não criar recuperação retrospectiva de lembretes perdidos nem alterar horário do cron.

### 3.4 Pesquisa — `res_pesquisa_reserva_v1`, UTILITY sujeita à Meta

> Olá, {{1}}. Sobre sua reserva {{2}} em {{3}}, marcada para {{4}}: de 1 a 5, como você avalia o atendimento?
> Responda apenas com o número, sendo 1 muito insatisfeito e 5 muito satisfeito.
> Obrigado pela sua avaliação.

Parâmetros: cliente, código da reserva, unidade, data da reserva. Exemplo: Marina; RES123; Restaurante Exemplo; 19/10/2026. A redação não afirma comparecimento comprovado: confirmed é o único sinal disponível no fluxo atual. Não criar status de visita. Excluir cancelled/no_show, nota existente e duplicidade. Não prometer desconto ou recompensa; manter inalterada a lógica conversacional existente de avaliação/giftback. Se reclassificada MARKETING, bloquear nesta versão até revisão específica; nunca presumir autorização promocional.

### 3.5 Entrada na fila — `fila_entrada_v1`, UTILITY

> Olá, {{1}}. Sua entrada na fila de espera de {{2}} foi registrada.
> Senha da fila: {{3}}. Quantidade de pessoas: {{4}}.
> Acompanhamento: {{5}}.
> Avisaremos quando sua mesa estiver pronta.

Parâmetros: nome informado na fila, unidade, senha da fila, pessoas, acompanhamento. Exemplo: Marina; Restaurante Exemplo; 12; 4; link fictício. Usar o recurso da fila, sem exigir customer inexistente nem converter senha em código de reserva. Preservar a chamada manual de mesa fora deste catálogo.

### 3.6 Pesquisa pós-fila — `fila_feedback_v1`, MARKETING

> Olá, {{1}}. A {{2}} gostaria de saber sua opinião sobre o atendimento referente à sua passagem pela fila em {{3}}.
> Acesse: {{4}}.
> Preferências de mensagens: {{5}}.
> Obrigado por compartilhar sua experiência.

Parâmetros: nome na fila, unidade, dia local de `seated_at`, destino existente do feedback, preferências. Exemplo: Marina; Restaurante Exemplo; 19/10/2026; URL fictícia da unidade; URL fictícia de preferências. FOOTER fixo: “Para não receber ofertas, use o link de preferências.” Manter a finalidade/destino existentes; não inventar formulário ou conversão. Exigir customer identificável da própria organização com consentimento promocional; ausência bloqueia envio promocional, sem criar cadastro por nome.

### 3.7 Voucher programado — `mkt_voucher_programado_v1`, MARKETING

> Olá, {{1}}. A {{2}} disponibilizou {{3}}% de desconto para sua próxima visita.
> Código do voucher: {{4}}. Válido até {{5}}.
> Apresente o código ao pagar e consulte as condições do benefício com a unidade.
> Preferências de mensagens: {{6}}.
> Você pode atualizar sua escolha pelo link.

Parâmetros: cliente, unidade, percentual, código do voucher, validade, preferências. Exemplo: Marina; Restaurante Exemplo; 15; VCH12345; 30/10/2026; link fictício. Mesmo FOOTER do modelo anterior. O benefício vem exclusivamente do voucher já emitido pela regra existente; texto neutro não pressupõe aniversário, visita concluída ou outro fato que a elegibilidade atual não prova. Não alterar cálculo de frequência, min_rating, validade ou uso.

### 3.8 Esquema de variáveis e renderização

| Valor | Fonte autoritativa | Validação da plataforma | Ausência |
| --- | --- | --- | --- |
| Cliente | customers ou nome do recurso de fila | String aparada 1–100 caracteres; impedir caracteres de controle e quebra de estrutura | Saudação fixa “cliente”; sem fabricar identidade |
| Unidade | units.name do recurso | String 1–120; controles recusados | Bloquear e informar cadastro incompleto |
| Data/hora | Reserva ou seated_at; timezone da unidade | Formato DD/MM/AAAA e HH:MM; data válida; time normalizado antes de compor instante | Bloquear; não usar relógio ou data alternativa |
| Pessoas | party_size do recurso | Inteiro positivo válido no domínio; representação até 6 dígitos | Bloquear |
| Código da reserva | reservation_code | String do banco 1–32 | Bloquear |
| Senha da fila | waitlist.code | Valor do banco formatado pelo núcleo da fila | Bloquear |
| Código do voucher | vouchers.code | String do voucher ativo 1–64 | Bloquear |
| Percentual | Reserva/voucher | Número finito > 0 e ≤ 100, formatação decimal determinística | Bloquear variante com desconto |
| Validade | vouchers.expires_at | Instante válido, futuro e formato local conforme regra atual de giftback | Bloquear envio vencido; não estender benefício |
| Links | Backend, origens autorizadas e rotas existentes/nova preferência | HTTPS, até 512 caracteres, token/UUID do recurso, sem query pessoal ou redirecionamento aberto | Bloquear modelo que exige link |

Os limites desta tabela são escolhas da plataforma, não alegações de limites Meta. Validar também o componente final conforme documentação vigente antes de habilitar capability. Não truncar nome/código/link silenciosamente para fazer caber; bloquear parâmetro que ultrapasse o limite, salvo a saudação alternativa explicitamente descrita.

O mesmo núcleo puro produz os parâmetros do provider e a prévia/histórico. Exemplos de submissão são fixtures fictícias, com origem pública configurada e identificadores que não correspondem a recursos reais. O hash ignora metadados de análise e exemplos; inclui nome, idioma, categoria solicitada, formato e componentes fixos normalizados. O conteúdo remoto é comparado estruturalmente com a definição normalizada; diferenças desconhecidas não são descartadas para forçar igualdade.

## 4. Dados aditivos e segurança

Os nomes abaixo descrevem os contratos; a implementação pode ajustá-los às convenções do projeto sem mudar escopo ou invariantes. Catálogo em código; não criar tabela com corpo editável pela loja.

| Entidade | Chaves e estado | Acesso |
| --- | --- | --- |
| Conta de templates | organization_id, waba_id, binding_generation, verified_at; UNIQUE(waba_id), independente de transporte Meta/Datafy | Service role; projeção segura por EF |
| Binding de canal/conta | channel_id, unit_id, account_id, provider, generation, adopted_at | Service role; valida organização de unit, conta e canal no mesmo vínculo |
| Registro remoto | account_id, logical_id, version, language, remote_id, technical_name, desired_hash, observed_hash, requested/effective_category, remote_status, quality, rejection_code, sync_required, sync_epoch, last_synced_at | Service role; UNIQUE(account,logical,version,language) e UNIQUE(account,name,language) |
| Tarefa de catálogo | account_id, operação, alvo/revisão, status, attempts, due_at, claim_token, claimed_until, erro sanitizado | Service role; chave natural idempotente por conta/operação/alvo |
| Evento de template | account_id, field, remote_id/name/language, event_time, digest, valores permitidos, status de processamento | Service role; UNIQUE(account,digest), sem payload arbitrário ou token |
| Envio lógico de automação | unit_id, organização validada, kind, recurso, source_event_key, canal/provider/generation, versão, estado, due_at, expires_at, claim/fence, provider_message_id, reconcile_required | Service role; unicidade independente de versão de template |
| Consentimento/preferência | unit_id, customer_id, finalidade operacional/promocional, decisão, origem, evidência, ator, observed_at, versão | Leitura por membros autorizados; escrita por EF/RPC com papel e tenant verificados; histórico append-only |
| Token de preferência | unit_id, customer_id, propósito promocional, hash, expiry, revoked_at | Service role; token não dá acesso ao cadastro de cliente |

Todas as tabelas expostas têm RLS, e as internas sensíveis usam FORCE RLS sem policies para anon/authenticated. Não conceder leitura direta de contas/jobs/tokens ao frontend. Se consentimentos forem expostos por RPC, preferir projeção mínima; toda policy/RPC unit-scoped inclui paralelo platform_admin e usa helpers qualificados de app_private conforme as regras existentes.

RPCs de claim/finalização são service-role-only, com revoke explícito de PUBLIC/anon/authenticated e assinatura completa. Funções de trigger também revogam execução pública. Claims e expiração de posse usam o relógio do SQL, não Date.now. A EF deriva organização a partir da unidade e do recurso, não de organization_id fornecido no corpo.

Uma WABA não pode ser vinculada a organizações diferentes, inclusive quando um canal usa Datafy e outro Meta direta. A conta/registro remoto é independente do transporte; a decisão é transacional com constraint/lock, inclusive sob criações concorrentes. Canais da mesma organização podem compartilhar registro remoto, mas cada despacho valida o número/canal que pertence à unidade. Não usar credencial de outra unidade para enviar. O worker de sincronização pode escolher credencial de canal autorizado da mesma conta verificada, mantendo a procedência e sem expor o segredo.

Retenção: eventos sanitizados e jobs terminais novos são purgados após 90 dias; preferências e evidências são mantidas enquanto necessárias para comprovar a decisão, e seguem a anonimização do cliente. Jobs não terminais não entram na purga. Não alterar retenção das tabelas existentes. Logs contêm IDs técnicos, códigos fechados e telefone sanitizado, nunca credenciais, corpo cru ou token de preferências.

## 5. Provisionamento e sincronização

O backend confirma conexão, vínculo e dados remotos antes de criar tarefa. Datafy redescobre `/me` se WABA estiver ausente ou binding tiver mudado. Não substituir automaticamente credencial/secret ou canal para satisfazer o catálogo. A integração administrativa existente conserva seu modelo de conexão; não criar um onboarding pago.

O worker lista todas as páginas usando cursores na origem do adapter. Nome+idioma+componentes+formato devem corresponder à versão esperada; nunca seguir URL Graph retornada pela Datafy. Reutilizar correspondência exata da própria conta. Nome ocupado por conteúdo diferente produz conflito, sem editar/deletar template externo. Submeter apenas modelos ausentes do catálogo ativo.

Timeout após criação pode representar sucesso remoto: primeiro listar pelo nome+idioma e reconciliar conteúdo; não repetir POST cegamente. Rejeição fica terminal até ação autorizada e nova versão/correção explícita. Uma nova versão não desativa versão funcional anterior antes de aprovação e rollout.

Estados locais: awaiting_connection, queued, submitting, pending, usable, rejected, paused, disabled, conflict, sync_error e unsupported. Estado remoto é preservado separadamente; unknown nunca é approved. usable exige simultaneamente aprovação, hash/idioma compatíveis, categoria efetiva permitida e sincronização válida. Qualidade UNKNOWN é exibida como desconhecida; RED bloqueia novo envio promocional e exige sincronização. Não inventar denúncias ou leitura do cliente.

Uma sincronização reserva `sync_epoch`; somente resultado com essa geração ainda atual pode publicar o snapshot. Evento recebido durante o GET invalida o snapshot anterior. Uma sincronização com erro não libera modelo anteriormente bloqueado. Checagem remota e POST não são atomicamente controláveis pelo SaaS: rejeição do provider após uma mudança externa é falha real e não autoriza retry cego.

Quando houver canal conectado mas não ativo, pode preparar catálogo, sem enviar mensagens. Quando canal, token ou binding mudar, invalidar tarefas antigas e exigir nova verificação. Provisionamento após conexão só roda com a flag de catálogo habilitada; habilitar não faz replay de envios passados.

## 6. Eventos de templates e preservação do webhook

Aceitar as famílias documentadas message_template_status_update, message_template_quality_update, template_category_update e message_template_components_update. Validar a assinatura do provider sobre corpo bruto e as guardas de timestamp/replay atuais antes de persistir ou processar.

Mensagens, recibos de entrega e eco continuam exigindo metadata.phone_number_id do canal. Evento de gestão exige `entry.id` igual à WABA descoberta e vinculada à organização do canal da URL. IDs remoto/nome/idioma devem ser conferidos nessa conta. Mudança de categoria usa campos documentados, sem adivinhar que previous/new/correct_category são intercambiáveis.

Validar todas as entradas/changes, inclusive lote misto, antes de qualquer efeito. A ausência de número num evento exclusivo de WABA não afrouxa a guarda de mensagens. Um lote com recurso de outro tenant é recusado sem aplicar suas partes válidas. Preservar o corpo original durante validação; dividir em memória apenas depois da assinatura.

Antes do ACK, persistir transacionalmente eventos sanitizados e pedido de reconciliação idempotente. Falha de persistência é 503. Evento nunca chama IA, não abre janela de atendimento, não resolve cliente e não adiciona mensagem inbound à conversa. Status PAUSED/DISABLED/REJECTED reduz disponibilidade imediatamente; aprovação/evento antigo nunca libera por si só. Categoria/componentes desconhecidos marcam sync_required e impedem novo POST até GET válido. Se a Datafy não entregar esses eventos na configuração da conta, o catálogo permanece dependente de sincronização e essa lacuna impede rollout paritário.

Sincronização de recuperação a cada 5 minutos para contas habilitadas com canal autorizado e catálogo em uso, coalescida por conta; GET remoto adicional antes do POST oficial quando o snapshot tiver mais de 60 segundos, ou imediatamente se sync_required. Falha nessa checagem recusa apenas a automação oficial. Esses intervalos são política local e podem ser revistos por configuração administrativa sem afirmar serem limites do provider.

## 7. Produção do envio e idempotência

Os crons/trigger existentes continuam produzindo intenções no mesmo horário. Em canal que nunca aderiu (`adopted_at IS NULL`), flag desligada preserva o caminho legado. Na primeira ativação autorizada, gravar adopted_at e usar apenas o novo serviço; a desativação posterior pausa automações oficiais, sem retornar automaticamente a texto livre. Intenção que já tenha registro no ledger consulta esse registro mesmo após desligar a flag, para não repetir o envio pelo legado. A leitura de flag com erro é erro operacional, nunca seleção silenciosa do legado.

Chaves lógicas: reserva `(unit,kind,reservation_id)`; fila `(unit,kind,waitlist_id)`; voucher `(unit,kind,voucher_id)`. Usar a chave do outbox/trigger como procedência quando existir. Mudança de template/canal não cria segundo envio do mesmo fato. Migração considera notifications_sent aceitos para não reenviar evento concluído. Envio oficial bloqueado antes do POST não vira sent/failed em notifications_sent; impedimento fica no ledger novo.

Cada job fixa canal/provider/binding_generation. Claim atômico por SQL atribui UUID/fence e prazo. O timeout de rede fica abaixo do prazo de posse; não permitir takeover de job em fase de POST com resultado desconhecido. Worker que perde o fence não pode finalizar nem postar. Timeout/queda após início do POST vira uncertain e exige evidência/reconciliação, sem promessa de exatamente uma vez. Uma resposta tardia pode registrar evidência de aceite para o mesmo fence em posting/uncertain, sem autorizar novo POST; essa finalização não transfere posse.

Antes do POST, revalidar posse, serviço, canal ativo e conectado, recurso da unidade, telefone canônico do recurso, elegibilidade, consentimento/opt-out, template aprovado/íntegro, parâmetros, TTL e versão autorizada. O endereço E164 usa o helper atual. Não confiar em `isOfficial`, phone ou parâmetros oficiais livres do body do cliente.

Releitura de reserva atual evita enviar hora/data antiga após remarcação. Pending, cancelled e no_show não recebem confirmação/lembrete/pesquisa; pagamento pendente não recebe confirmação. Lembrete usa “hoje” apenas no dia local e antes do início. Pesquisa mantém a seleção D+1, nota vazia e TTL atual. Não inventar comparecimento. Entrada da fila exige estado waiting; feedback exige seated e data de seated_at compatível.

Usar units.timezone como IANA na validação de data/hora oficial, sem mudar os crons BRT já configurados nem reescrever availability. Valor ausente usa o padrão documentado America/Sao_Paulo; IANA inválido bloqueia essa automação e aponta ajuste. Uma unidade em fuso incompatível com o horário atual de cron não ganha scheduler novo nesta entrega. Não enviar “hoje” na data errada para acomodar o cron.

Voucher do worker permanece emitido antes de enviar. Bloqueio de template/consentimento não apaga nem recria voucher. Frequência/aniversário mantêm as decisões atuais de suspensão. Voucher enviado precisa ser ativo, do destinatário e da unidade, com expiração futura; TTL não estende validade. Voucher após nota/comentário continua no webhook original com commit pós-envio.

Job com canal trocado vira needs_review. Não enviar por novo canal automaticamente. Owner/gerente pode solicitar revalidação explícita de job não aceito e ainda válido; accepted/uncertain não são retomados sem prova. Rollback tampouco deve mandar o mesmo job por outra modalidade.

Estados de envio: queued, blocked, claimed, posting, accepted, uncertain, retry_wait, expired, needs_review, failed e reconciled. blocked identifica impedimento corrigível, sem consumir o envio lógico. accepted significa aceito pelo provider; delivered/read/failed continuam nos callbacks existentes. Reconciled descreve apenas reparo local ou evidência remota, nunca prova de entrega sem callback.

Retentativa de rejeição transitória explícita pode reutilizar a mesma intenção com no máximo cinco tentativas totais e intervalos de 1, 4, 16 e 64 minutos entre elas; respeitar indicação documentada do provider se exigir espera maior, sem inventar header de Retry-After. Antes de criar, enviar ou retentar, respeitar suspensão e vencimento. Erro de auth, template recusado ou estado uncertain não entra nesse retry automático. Jobs do outbox não mantêm uma segunda escada de envio simultânea: delegado ao ledger, o outbox aguarda resultado/expiração.

Execução em lotes máximos de 20, inicialmente sequencial por canal, com limite administrativo configurável abaixo das capacidades comprovadas. Isso é pacing local, não garantia de limite Meta/Datafy. Deadline do worker limita seleção de próximo job, sem abandonar um POST e devolvê-lo a pending.

Ao aceitar, persistir provider_message_id e dados de correlação, atualizar notifications_sent segundo o contrato existente e fazer append por conversation-log com author automation e event_id estável. Se o provider aceitou e a persistência local falhou, registrar reconciliação necessária e reparar o banco, sem repetir POST. Um callback recebido antes do registro final deve ser conciliado pela correlação completa, nunca só por message_id.

## 8. Consentimento, preferências e categoria promocional

Não interpretar telefone, reserva, conversa recente ou do_not_contact=false como opt-in promocional. do_not_contact=true e cliente anonimizado/deleted bloqueiam o envio proativo. Evidência de consentimento registra finalidade, unidade, contato, origem, data, ator e referência comprobatória sem copiar conversa inteira.

Leitura operacional respeita as guardas existentes; não presumir que atualizar a plataforma concedeu permissão. A ativação do piloto exige revisão das autorizações operacionais dos contatos. Para promoções novas pelo despacho atualizado, estado desconhecido/ilegível é bloqueio. A captura inicial é administrativa e por contato: owner/gerente registra autorização obtida legitimamente, sem checkbox em massa que marque toda a base. Platform_admin conserva o paralelo auditável.

Preferência promocional tem escopo `(unit,customer)`; customers continua pertencendo à organização e não ganha cadastro duplicado. Opt-out suspende somente ofertas da unidade, sem impedir resposta de atendimento ou revogar mensagens operacionais solicitadas. do_not_contact global existente continua mais restritivo quando estiver true.

Links de preferência contêm token aleatório de pelo menos 256 bits, armazenado apenas como hash, validade de 90 dias e revogação. GET mostra unidade e opção de não receber ofertas, sem exibir nome/telefone/email. POST validado e confirmado grava a recusa idempotente; GET de robô não muda decisão. Token só autoriza recusar a finalidade promocional daquela unidade, não criar opt-in, consultar cadastro ou gerir reserva. Nova tentativa ainda permitida pode gerar outro token sem restaurar consentimento.

Footer proposto usa link de preferências em vez de “responda SAIR”, para preservar o parser existente. Não anunciar um comando que não é implementado. Pedidos de saída feitos no atendimento continuam sendo respeitados pela equipe nos controles atuais; a interface deve permitir registrar a recusa específica. Acrescentar intercept de SAIR exigiria mudança explícita do limite de escopo.

Frequência promocional do despacho atualizado: no máximo um envio aceito ou uncertain por contato/unidade em sete dias, configurável apenas por platform_admin. É política do produto e não garantia contra bloqueios. A reserva do slot é concorrente no SQL; uncertain conserva o slot. Comunicação operacional não utiliza esse limite. Não alterar emissão do voucher por limite de mensagens.

Na API não oficial, preservar conteúdo customizado e aplicar supressão/consentimento/frequência aos fluxos promocionais que adotarem o novo despacho, sem reclassificar todo texto de IA. Mostrar aviso de conexão não oficial e risco de instabilidade/restrição; nenhuma evasão, rotação automática de números ou fallback após rejeição Meta.

## 9. Interface e autorização

As páginas atuais de Reservas → Comunicação, Fila → Comunicação e Giftback → Ajustes mantêm a organização visual. Estado remoto é React Query, recebe unitId primeiro e distingue loading, error com retry, empty e data. Falha ao resolver modalidade não exibe editor oficial como se fosse não oficial.

Resposta autorizada do backend inclui modalidade oficial/não oficial, label/provider seguro, channel_id, capacidades, catálogo e situação por modelo. Sem token, secret, credentials, business_id ou WABA bruta necessária à loja. Mostrar nome amigável, texto/rodapé somente leitura no oficial, categoria solicitada/efetiva, qualidade conhecida, motivo de impedimento sanitizado e última sincronização. Não oferecer toggle de personalização em modelo oficial.

Ativação segue ajustes existentes; rotular “Salvar configuração” quando não grava texto. Campos das mensagens operacionais vêm dos recursos, não de caixa livre. “Sincronizar” coalesce tarefa e não promete aprovação imediata; “Tentar novamente” só aparece para falha corrigível, jamais loop automático de rejeitado.

Owner/gerente edita configurações permitidas, personalizações não oficiais e preferências com evidência. Operador conserva atendimento/reservas/fila e leitura necessária aos impedimentos, sem administrar catálogo, registrar opt-in ou trocar provider. Platform_admin administra versões e libera rollout. Toda ação replica guard de papel/recurso no backend; frontend não é autoridade.

Textos legados continuam em reservation_message_templates, waitlist_message_templates e settings. A loja oficial não modifica esses textos como se fossem o catálogo em uso; aplicar guarda na escrita direta desses campos para canal oficial, sem apagar linhas antigas ou bloquear chaves de configuração não relacionadas. Preservar o caminho administrativo autorizado de manutenção. RLS/trigger verifica canal real e papel, incluindo service role onde auth.uid não existe, sem concessão geral.

Prever estados de catálogo sem conexão, indisponível, pendente, utilizável e bloqueado. Mostrar problema junto à automação e em Entregas, sem notificação de erro falsa para TTL vencido. Reenvio só mantém tipos já suportados; não acrescentar botão de reenvio de survey/voucher implicitamente. Mobile usa o AdminShell, componentes responsivos e os padrões de foco/tap target existentes.

## 10. Flags, custos e rollout

Duas flags globais independentes, por platform-flags: catálogo/provisionamento e despacho atualizado. Opt-in de despacho por canal nasce false. A modalidade atual do canal não é reescrita pela flag. Gate de catálogo inclui autorização para submeter remotamente; testes usam mocks até essa autorização existir.

Flag de catálogo pode preparar modelos sem ligar envio. Flag de despacho+opt-in seleciona uma única perna produtora para cada automação; adopted_at distingue o canal ainda legado do já migrado e pausado. Falha de leitura não é OFF; recusar essa automação com motivo observável. Atendimento atual não consulta esses novos gates.

Nova passagem para MARKETING exige consentimento e revisão específica de custo da conta antes da ativação. Registrar autorização administrativa por conta, categoria e geração de binding, com vigência explícita; ausente/vencida bloqueia promoções oficiais. Não debitar saldo, estimar valor sem tarifa verificada nem afirmar gratuidade. O anexo de auditoria registra divergência Datafy×Meta; resolver comercialmente para o piloto sem transformar valor de referência em regra automática.

Rollout: migrations aditivas e ACL/gates antes das EFs; depois frontend com states client-safe; catálogo desligado; autorização para submissão; conta piloto; validar eventos e aprovação por modelo; autorização de envio em número de homologação; opt-in de canal; acompanhar fila/impedimentos/entrega; somente então expansão autorizada. Não ativar cron promocional novo nem despachar backlog anterior à ativação.

Rollback rápido: desligar opt-in de despacho no canal e pausar jobs não aceitos. Jobs claimed/posting/uncertain conservam o fence e exigem conclusão/reconciliação, sem retornar ao legado. Flag desligada não reenvia intenções já registradas pelo ledger. Manter migrations, catálogo e personalizações; não dropar dados como rollback. Produção só volta ao legado mediante avaliação explícita de elegibilidade e exigências do provider, sem texto livre fora das regras oficiais.

As EFs são bundles independentes. Mudanças no registry, cliente Datafy, envio, flags, conversation-log e novos núcleos atualizam a matriz transitiva completa de CLAUDE.md/AGENTS.md. Nunca declarar que só os dois workers de reserva precisam de deploy. A implementação lista todos os consumidores antes de pedir autorização de deploy.

## 11. Verificação e critérios de aceite

| Área | Evidência exigida |
| --- | --- |
| Catálogo | Sete definições completas, exemplos fictícios para todos os parâmetros, preview/envio paritários, parâmetros ausentes inválidos, códigos com finalidade separada e hash determinístico |
| Autorização | Unit/org do recurso, WABA compartilhada só dentro da org, binding concorrente, operador negado para gestão, platform_admin permitido, escrita direta de corpo oficial negada |
| Provisionamento | Paginação de múltiplas páginas, cursor cíclico recusado, reconexão sem duplicar, conflito preservado, timeout reconciliado, rejected sem loop, versão nova sem retirar a anterior |
| Webhook | Assinatura/replay inválidos, evento WABA legítimo sem metadata de número, mensagem alheia recusada, lote misto validado inteiro, idempotência, persistência antes do ACK, evento antigo não libera e zero invocação de IA |
| Envio | Pending/rejeitado/pausado/hash divergente/categoria incompatível nunca postam; canal atual/frescor/TTL/consentimento revalidados; claim concorrente só permite um POST; uncertain sem retry; falha local após aceite apenas reconcilia |
| Automação | Cron preservado, lembrete hoje antes da hora, reserva remarcada/cancelada, nota existente, fila seated e resources corretos, source/notify preservados, voucher emitido sem recriação, token/link sem efeito por GET |
| Atendimento | Testes de controle mostram sendText de IA/humano igual, handoff/eco/autor/lock preservados, notas/comentários e after_rating não usam novo despacho, events de gestão não entram na conversa |
| Preferências | Unknown não é consentimento; opt-out posterior ao enqueue vence; POST idempotente; token expirado/revogado/alheio negado; slot promocional concorrente; anonimização elimina acesso e impede envio |
| Interface | Oficial read-only sem toggle, não oficial conserva editor/restauração, erros/retry, status desconhecido claro, formulário preservado, mobile/foco e sem truncamento de dados essenciais |
| Rollout | Flags OFF baseline, corte único legado/novo, rollback sem duplicidade, fila não terminal observável, alertas de job falho/uncertain e approvals reais distinguidos de mocks |

Vitest para núcleos e regressões, testes de componente das telas alteradas, harness local de migrations para constraints/claims/triggers/idempotência e teste de integração local para RLS/ACL com anon/authenticated/service role. Harness sozinho não prova RLS/PostgREST. Gates npm lint/test/typecheck/build proporcionais; Deno check/test dos núcleos/EFs tocados quando runtime estiver disponível, sem chamar provider real. Ausência desse runtime deve ser registrada como verificação pendente, nunca substituída pelo tsc do frontend.

Executar saas-shield-br para RLS, isolamento, identidade/acesso, migration, secrets e confiabilidade; review de spec, qualidade por tarefa e whole-branch no fluxo obrigatório. Antes de merge de SQL/ACL, conferir acl-estatico e usar o audit autoritativo previsto no repositório para banco real quando autorizado. Não afirmar gate externo ou homologação que não rodou.

## 12. Dependências e estado desta entrega

Contratos Datafy e fontes primárias já consultadas constam na auditoria, em 2026-10-03. A documentação Meta de gerenciamento/componentes retornou 429 nesta etapa; o piloto Meta direta e componentes adicionais exigem verificação da documentação e conta antes de capability/rollout. Limites não são inferidos da suíte mockada.

Dependências externas: conta/WABA/número autorizados; token e grants com capacidade de template; eventos de gestão configurados; autorização para submissão; resposta de análise efetiva por WABA; evidência de consentimento promocional; revisão da regra de cobrança aplicável; autorização separada de migration/deploy e envios controlados.

Esta spec define o alvo implementável e os bloqueios de liberação. Não é evidência de produto implementado, template enviado/aprovado ou produção liberada. O passo seguinte é revisão desta spec escrita pelo usuário, depois writing-plans e execução pelo método obrigatório do projeto.
