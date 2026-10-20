# Design — aba administrativa de modelos e envios do WhatsApp

**Estado: aprovada para implementação.** O responsável respondeu “Aprovo a spec e implementação” em 20/10/2026, após revisão de spec independente PASS. Esta mudança organiza a tela da unidade na Plataforma; não altera a autoridade de envio, catálogo, canal, cobrança nem permissões.

## Contexto e decisão

Em `/platform/unidades/:unitSlug`, os cartões “Modelos oficiais da Meta”, “Envio automático com modelos v1” e “Versão dos avisos automáticos” aparecem no meio de “Canais WhatsApp”. Eles tratam de três decisões separadas e tornam difícil localizar o canal e compreender a ordem das ações.

Criar uma aba irmã chamada **Modelos e envios** na mesma página, ao lado de “Canais WhatsApp” e “Provedor de IA”. Mover os três cartões existentes, nesta ordem, para a nova aba. “Canais WhatsApp” mantém conexão, migração Datafy e lista/gestão de canais. A nova aba é de `platform_admin`, como a página atual; sua presença em cada unidade não concede nem copia liberação entre unidades.

No topo da nova aba, mostrar um resumo curto da sequência: **preparar modelos → aguardar aprovação da Meta → liberar despacho da unidade → escolher versão quando v2 estiver pronta**. Explicar que a loja habilita suas finalidades nos controles operacionais existentes; aprovação/seleção isolada não envia mensagem. Evitar prometer que todas as ações são sempre necessárias: Ren Sushi já opera v1, e onboarding futuro pode preparar v2 automaticamente. Mostrar estado real nos cartões existentes, sem novo indicador calculado em frontend.

## Contratos preservados

- Os três cartões, hooks, RPCs, diálogos, confirmações com pins, CAS, roles e gates permanecem intactos; a mudança é só de composição e texto de orientação.
- A aba de canais não carrega os cartões de modelos; a aba nova renderiza os cartões somente para a unidade atual. A troca de unidade não preserva estado de confirmação anterior.
- Nenhum clique automático, mutação, `db push`, Edge Function, nova seleção v2 ou envio Meta/cliente decorre da navegação.
- Ren Sushi continua v1 até seleção administrativa futura, condicionada a modelos v2 aprovados e gates. MARKETING continua sujeito a consentimento e autorização de custo próprios.

## Aceite

1. Em desktop e mobile (incluindo 320 e 360 px), a aba “Modelos e envios” é visível ou alcançável por rolagem horizontal e teclado; os três cartões estão nela, na ordem indicada, e não aparecem dentro de “Canais WhatsApp”.
2. A orientação distingue submissão, aprovação, despacho e versão, sem sugerir cobrança ou envio pela mera abertura da aba.
3. Testes focados de navegação/composição e `npm run typecheck`, lint do delta e build passam. Review de spec e qualidade confirma que a autoridade administrativa e os componentes existentes não mudaram.
