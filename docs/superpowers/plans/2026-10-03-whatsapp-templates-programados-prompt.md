# Prompt para implementar em outro chat

Copie o texto abaixo no novo chat aberto no projeto `moralles.reservas`. O plano e a spec acompanham o prompt no próprio repositório.

---

Implemente localmente a atualização dos templates das automações WhatsApp existentes neste repositório:

`C:\Users\Yuri\Documents\Desenvolvedor\moralles.reservas`

Leia integralmente, antes de alterar código:

1. `AGENTS.md` e `CLAUDE.md`.
2. `docs/superpowers/specs/2026-10-03-whatsapp-templates-programados-auditoria.md`.
3. `docs/superpowers/specs/2026-10-03-whatsapp-templates-programados-design.md`.
4. `docs/superpowers/plans/2026-10-03-whatsapp-templates-programados.md`.

Este prompt autoriza a execução local do plano e os testes/reviews necessários. O desenho e a spec foram aprovados; não reinicie o brainstorming. Confira o plano contra o código atual e corrija referências que mudaram. Se houver divergência material de comportamento ou escopo, explique-a antes de alterar o requisito. Continue o trabalho independente enquanto resolve uma dependência concreta.

**Minha restrição principal:** o atendimento no WhatsApp deve continuar como está, incluindo a forma de interação, IA, mensagens humanas, handoff, eco, locks, interpretação de notas/comentários e voucher após avaliação. A atualização se limita aos templates e às automações existentes. O módulo Marketing será uma etapa posterior. A categoria MARKETING de um voucher existente não autoriza criar campanhas, públicos, segmentos, calendário, atribuição, carteira ou cobrança.

Atualize confirmação de reserva, lembrete no dia da reserva, pesquisa no dia seguinte, entrada na fila, pesquisa pós-fila e vouchers programados de aniversário/frequência. Preserve horários, critérios e benefícios atuais. Cancelamento, chamada manual de mesa e mensagens avulsas continuam nos caminhos atuais. Não crie produtores novos de automação nem replay de backlog anterior à ativação.

Use exatamente os sete modelos, corpos, FOOTERs, categorias propostas, variáveis e validações da seção 3 da spec. Oficial usa catálogo fixo e somente leitura na UI; não oficial mantém edição, variáveis, prévia, restauração e textos salvos. Não apague personalizações antigas. Sem aprovação/compatibilidade, registre e mostre o impedimento; não use texto livre como fallback oficial nem troque provider automaticamente.

Implemente pelo registry existente, reutilizando identidade, telefone, credenciais e conexão. Datafy e Meta direta precisam de capability comprovada por documentação primária atual; disponibilidade de sendText não prova suporte a templates. Uma WABA não pode pertencer a duas organizações, inclusive entre transportes diferentes. Preserve assinatura no corpo bruto e validação integral de lotes mistos: eventos de gestão WABA não entram no atendimento. Persistência desses eventos antecede ACK; falha é reentregável.

O ledger identifica unit+kind+recurso independentemente da versão do modelo/canal. Claims e fencing usam relógio SQL. Antes do POST, recarregue recurso, canal, status, TTL, aprovação/hash/categoria, consentimento e autorização aplicável. Timeout após início de POST é uncertain: não repita cegamente. Aceite externo seguido de falha local exige reconciliação sem segundo envio. Callbacks usam unit/provider/channel/message. Flags e opt-in nascem OFF; adoção sticky impede voltar ao legado ao desligar.

Promoções existentes exigem consentimento individual comprovado, saída por link seguro com GET sem mutação e POST explícito, frequência atômica e autorização de custo conforme spec. Não acrescente comando SAIR ao parser do atendimento. Voucher programado permanece inserido antes do envio e não é apagado/recriado por bloqueio ou retry. O voucher após avaliação conserva seu fluxo atual.

Siga o método obrigatório do projeto: `superpowers:subagent-driven-development`, builders SaaS adequados, implementador e reviews de spec/qualidade por tarefa, depois review whole-branch. Use ai-router por risco, mantendo decisões de segurança/arquitetura no principal. Execute os seis gates saas-shield-br antes de merge de produto. Descubra/leia as skills e agentes disponíveis; nunca declare um gate que não executou.

Preserve mudanças existentes. Trabalhe na branch `codex/whatsapp-templates-programados`, registre o destino local real, faça commits com paths explícitos e integre localmente após gates verdes. Atualize AGENTS/CLAUDE juntos para contratos permanentes e matriz de EFs. Não faça push.

Teste o fluxo completo com providers fake e banco Supabase local: catálogo/transporte, concorrência SQL, tenant/RLS/ACL/papéis, eventos, retry/reconciliação, três telas e regressões do atendimento. Execute lint, test, typecheck (`tsc -b --noEmit`), build e Deno check das EFs relevantes. Não substitua teste de comportamento por leitura de strings de código; não afirme que harness PostgreSQL isolado comprova PostgREST/JWT/RLS. Registre resultados reais e gates indisponíveis.

**Limite desta autorização:** implementação, testes, commits e integração locais. Não fazer migration/deploy em produção, submissão real de templates, ativação de canal, cobrança ou mensagem real. Prepare o runbook e indique as dependências externas. Essas ações precisam de autorização específica e resultado concreto revisável; complete primeiro o trabalho local que não depende delas.

Ao terminar, entregue resumo do que mudou, SHA/branch integrada, testes/gates executados e pendências externas. Diferencie código implementado, homologação remota e produção liberada.
