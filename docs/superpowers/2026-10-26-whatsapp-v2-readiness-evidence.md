# Despacho WhatsApp v2 — estado de produção (26/10/2026)

Snapshot do projeto Moralles Reservas (`gbabxcrntkwgblgqsiit`) por volta de 14h BRT. Fontes: código e spec locais, painel administrativo autenticado e consultas SQL de leitura agregadas. Este registro não contém telefone, cliente, corpo de mensagem ou credencial.

## Escopo futuro

- A política `app_private.whatsapp_template_v2_policy` já está `enabled=true`, revisão 1. O painel **Integrações e chaves** mostra “Política v2 ativada”. O trigger `app_private.enroll_new_datafy_template_onboarding` inscreve no v2 apenas onboardings Datafy criados sob essa política e digest correntes. A política v1 `whatsapp_template_auto_policy` está desligada, sem impedir a preferência v2.
- A flag global `whatsapp_automation_dispatch` está `true`. Ela não libera despacho de uma unidade futura: o binding precisa ser criado, verificado, adotado e liberado separadamente; modelos v2, grant, saúde/sync, finalidade da loja, consentimento e eventual autorização de custo são revalidados no prepare e antes do POST.
- Nenhum enrollment v2 `origin='auto'` existe até este snapshot. Existe um enrollment v2 manual da Ren Sushi. Sem nova loja conectada, não há binding futuro para liberar nem envio futuro para testar.

## Unidade existente: Ren Sushi

| Gate | Evidência | Veredito |
| --- | --- | --- |
| Canal e binding | Datafy conectado/ativo; um binding verificado, geração 1, `dispatch_enabled=true`, adoção durável presente | Ligado para a unidade existente |
| Seleção de versão | Seis finalidades UTILITY têm seleção administrativa v2: confirmação, lembrete, pesquisa da reserva, entrada na fila, cancelamento e mesa pronta | Já selecionadas; não repetir a mutação |
| Histórico de envio | 26 jobs v2 reconciliados com ID do provedor: 4 confirmações, 7 lembretes e 15 pesquisas; nenhum job de automação em estado aberto ou exigindo reconciliação | V2 já operou para três finalidades; não é teste das outras três |
| Catálogo v2 | Oito modelos v2 com `APPROVED`, `usable`, categoria/hash concordantes e ID remoto; `mkt_voucher_programado_v2` segue `UNKNOWN`/`pending`, sem ID remoto. O job de provisionamento desse modelo terminou `rejected`/`provider_rejected` em 19/10 | Voucher v2 bloqueado; não repetir POST por inferência |
| MARKETING v2 | Nenhuma autorização de custo versão 2 para o binding; `waitlist_feedback` e `voucher_issued` continuam em v1, sem seleção v2 | Não ativado; precisa autorização de custo com validade, consentimento individual e modelo utilizável |
| Política v2 da conta | Coorte, enrollment e grant v2 manuais presentes, grant não revogado | Não transfere liberação nem custo a outra unidade |

## Decisão de ativação

O fluxo automático **de inscrição no catálogo v2 para futuras conexões já está ativo**; não há switch adicional a ligar. O despacho futuro é autorizado por binding/finalidade, após o onboarding real e seus gates. Na Ren Sushi, seis finalidades UTILITY já estão selecionadas e o despacho do binding está ligado. Esta sessão não alterou política, seleção, flag ou autorização de custo e não disparou mensagem a cliente ou submissão de modelo à Meta.

Uma atualização de leitura do catálogo foi solicitada no painel. O job de sync entrou na fila às 14h06 BRT, e o cron `whatsapp-template-workers` ativo (`*/5`) a concluiu como `done`, sem erro, às 14h10 BRT. Na consulta SQL das 14h11 BRT, `app_private.whatsapp_automation_v2_readiness` retornou `ready=true` para as seis finalidades UTILITY; `waitlist_feedback` retornou `cost_not_authorized` e `voucher_issued`, `meta_pending`. O gate de sync é de 60 segundos e precisa ser revalidado imediatamente antes de cada POST; este resultado é uma prova pontual, não uma liberação permanente.

**Pendente:** (1) uma futura loja real para executar o pré-voo de canal/binding/modelos e liberar o despacho da loja; (2) autorização de custo v2 delimitada e consentimento para MARKETING; (3) resolver a rejeição de `mkt_voucher_programado_v2` pelo provedor com evidência, sem retry cego. Nenhuma dessas pendências justifica modificar o fluxo UTILITY v2 já ativo.
