# Plano: bloquear QR expirado da UazAPI

1. Adicionar teste de regressão ao cliente UazAPI para diferenciar QR de `connect` e QR residual de `status`.
2. Alterar `UazApiClient.getStatus()` para remover material de pareamento da resposta passiva.
3. Atualizar `CLAUDE.md` e `AGENTS.md` com a invariante permanente.
4. Rodar testes focados e gates proporcionais (`test`, `typecheck`, `lint`, `build`).
5. Fazer revisão de implementação e revisão whole-branch por subagentes.
6. Revisar diff/staged e secrets, commitar, abrir PR, aguardar checks e mergear.
7. Redeployar `manage-channels`, conferir produção pelo botão **Status** e iniciar uma nova sessão por **Conectar / QR** para o usuário escanear.
