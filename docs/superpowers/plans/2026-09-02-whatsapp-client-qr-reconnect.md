# Reconexão WhatsApp por QR Code no portal — plano

## Tarefa 1 — Contrato e parsers do registry

- Adicionar um snapshot mínimo de QR e método opcional no adapter.
- Habilitar `qrConnection` para Z-API e WAHA; manter Meta Cloud API sem QR.
- Implementar parsers puros fail-closed para os formatos Z-API e WAHA.
- Cobrir respostas válidas, ausentes e malformadas com Vitest.

## Tarefa 2 — Adapters server-side

- Implementar chamadas autenticadas e com timeout aos endpoints oficiais de QR da Z-API e WAHA.
- Manter tokens exclusivamente em `ChannelCredentials` dentro da Edge Function.
- Não persistir nem logar QR/payload do provider.

## Tarefa 3 — Lifecycle client-safe multi-provider

- Separar capabilities `qr_available`, `restart_available` e `disconnect_available` no retorno client-safe.
- Generalizar a resolução de canal para aceitar canal manual configurado na mesma unidade.
- Rotear `connect|refresh_qr|status` pelo registry para Z-API/WAHA e preservar UazAPI.
- Manter create/provisionamento exclusivo do fluxo UazAPI e toda validação de membership/tenant.

## Tarefa 4 — Portal do colaborador

- Normalizar as novas capabilities no hook sem aceitar campos administrativos.
- Exibir conectar/renovar QR para todo adapter compatível.
- Condicionar restart/disconnect às capabilities reais.
- Ajustar polling e textos para lifecycle multi-provider.

## Tarefa 5 — Verificação e documentação permanente

- Ampliar testes do hook, core e guardrails de wiring/tenant.
- Atualizar `CLAUDE.md` e `AGENTS.md` com a invariante cross-provider.
- Rodar testes direcionados, `npm run typecheck`, `npm run lint`, `npm run test` e `npm run build`.
- Fazer reviews de spec, qualidade, identidade/acesso, isolamento de tenant, secrets e confiabilidade da integração.
- Revisar diff/staged integralmente, procurar secrets e commitar em caminhos explícitos.
