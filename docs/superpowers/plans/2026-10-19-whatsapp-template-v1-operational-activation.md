# Plano — liberação operacional v1 da Ren Sushi

## Contrato e autorizações

A [spec aprovada de templates](../specs/2026-10-03-whatsapp-templates-programados-design.md), especialmente os contratos de gestão/rollout dos §§221–237, já define opt-in de despacho por canal, adoção durável, papéis e flags independentes. Esta task completa o controle administrativo ausente para a operação existente `release_channel`, `scope=dispatch`, sem criar autoridade SQL ou alterar o mecanismo de envio.

Em 19/10/2026 o responsável autorizou v1 e confirmou expressamente: mensagens operacionais da Ren Sushi no Datafy remoto `d35128bb…`, acompanhamento manual enquanto alertas não configurados, primeira confirmação para o mesmo contato controlado. Alcance informado: todos os fatos elegíveis da unidade, inclusive lembretes/pesquisas de recursos existentes; não há allowlist de um destinatário. Assinatura R$49,90/número/mês já ativa; documentação Datafy consultada estima UTILITY R$0,035 por mensagem entregue no Brasil, sem garantir tarifa efetiva da conta. MARKETING continua sem autorização de custo e bloqueado. Não alterar consentimentos de clientes.

Alvo: Moralles Reservas `gbabxcrntkwgblgqsiit`; unidade `9dc55e51-99b2-4536-b596-d25b88946b44`; canal local `a368bea2-90aa-4d81-880e-6d962255c4b0`; binding `69247a84-4e7a-41dc-8fa2-c12947124218`, geração 1/revisão de credencial 0 no pré-voo. Relê-los antes de qualquer escrita.

## Task 1 — completar o controle administrativo existente

**Gate anterior obrigatório após a captura enviada pelo responsável:** a revisão encontrou P1 de corrida entre POST legado em voo e adoção/novo POST, além de aceite com falha de persistência e histórico `failed` com ID. O fluxo atual já envia mensagens; a proposta de [exclusividade legado/gerenciado](../specs/2026-10-19-whatsapp-legacy-managed-cutover-dedup-design.md) e seu [plano](2026-10-19-whatsapp-legacy-managed-cutover-dedup.md) precisam ser aprovados/implementados/testados antes do corte. Não ativar somente por adicionar este CTA. A autorização operacional recebida continua válida.

- [x] Implementer lê AGENTS/regras frontend/templates e a spec aprovada. Adiciona controle liberar/pausar despacho, somente `platform_admin`, no cartão administrativo da unidade. Reutiliza snapshot e API existentes, sem RPC/migration/EF novos.
- [x] Pin explícito de canal, geração, revisão de credenciais, estado de despacho/adoção e intenção enabled. Revalidar dados antes do único POST; drift/loading/erro bloqueiam. Consumir confirmação antes do await/refetch; lock síncrono e cerca de tentativa ambígua impedem segundo clique/reabertura cega.
- [x] Confirmação informa que habilita fatos elegíveis da unidade, pode cobrar mensagens e grava adoção durável; não promete selecionar apenas um contato, ativar a flag global, ligar MARKETING ou voltar ao legado ao pausar. Stop separado mantém adoção e histórico. Modelo/coorte de SUBMISSÃO v2 não impede operar o despacho v1 aprovado.
- [x] Testes focados provam papel, payload scope dispatch/pins corretos, uma tentativa, refetch esperado sem aviso falso, drift real, erro sanitizado e resultado ambíguo. Hook de catálogo conserva scope catalog; não regredir liberações v1/v2 de modelos.
- [x] Review independente de spec ROOT → review independente de qualidade `template_v2_integration_quality`, ambos PASS sem achado aberto. Implementer `template_v2_ui_impl`; 47 testes, typecheck, lint e build PASS. Evidência: [Task 4 UI](../2026-10-19-whatsapp-template-v1-activation-task4-ui-evidence.md). Aceite local do ROOT; publicação e operação continuam pendentes.

## Task 2 — gates e publicação do frontend

- [ ] Executar testes pertinentes, typecheck `tsc -b`, lint dos arquivos, build, revisão da branch e gates proporcionais de identidade/tenant/secrets/confiabilidade. Não ampliar backend ou autoridade para facilitar operação.
- [ ] Conferir git status/diff/100% staged e segredos; git add somente caminhos explícitos; commit/push/PR autorizado. Confirmar `acl-estatico`, preview verde, ausência de conflito e HEAD exato antes de merge. Comprovar Production READY; nenhum redeploy EF ou db push por alteração somente React.

## Task 3 — operação autorizada, uma vez e observada

- [x] Pré-voo read-only inicial: nove v1 APPROVED/usable com identidade/hash/categoria corretos, sync_required zero; canal ativo/conectado/assinado, binding/conta verificados e saúde fresca; zero jobs de automação da unidade, zero outros bindings com dispatch, custo MARKETING ausente, sem adoção anterior. Estado observado antes da escrita, não licença para usar snapshot vencido.
- [x] Obter confirmação do alcance amplo, custo estimado e exceção expressa de alertas para esta operação. Aceite: “Confirmo operacionais v1 e acompanhamento manual”. Não confundir esta exceção com configuração concluída de alertas.
- [x] Verificar a observação do responsável sobre envios atuais: às 14h25 BRT, dispatch global/binding OFF, zero jobs gerenciados e zero outbox pending/processing; últimos registros comprovam seis pesquisas com recibo entregue no fluxo atual. Histórico desde 17/10 também contém confirmação, lembrete e filas com provider ID e recibo failed, conservados como evidência de POST/aceite com falha de entrega. Isso não comprova duplicação atual nem ausência de HTTP legado em voo. A revisão estática independente identificou os dois vetores P1 acima; prova de exclusividade ainda pendente.
- [ ] Revalidar isolamento (outros grants e jobs não terminais), canal/geração/revisão, v1 e fila; anunciar canal/custo nominal. Pela sessão real de platform_admin e CTA da Task 1, liberar somente dispatch do binding Ren. Verificar uma adoção/grant por leitura antes de repetir; nunca usar SQL com auth impersonation.
- [ ] Alterar somente o gate global já existente `whatsapp_automation_dispatch`, por DML administrativa autorizada e predicados esperados: valor anterior false, somente binding Ren liberado, zero trabalho/alcance inesperado noutras unidades. Conferir retorno de uma linha e reconsultar. Não alterar schema, grants de catálogo, políticas v2 ou custo MARKETING; registrar a operação e o aceite em evidência.
- [ ] Confirmar um fato novo de reserva para contato controlado e uma tentativa de confirmação v1; coordenar com o responsável sem receber telefone/texto nesta conversa. Conferir job/versão/nome, aceite, notificação/histórico e callback entregue/lido; aceite não comprova entrega, timeout/uncertain não autoriza retry.
- [ ] Conferir ausência de duplicidade e bloqueio promocional; observar Entregas/ledger manualmente. Se falhar, pausar somente dispatch do canal pela API legítima, conservando adoção e jobs; reconciliar resultado em voo.
- [ ] Atualizar planos/memória e commit explícito somente das evidências comprovadas. Registrar limitação de alertas e separar o trabalho proposto de envio v2.
