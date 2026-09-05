# UazAPI: impedir reuso de QR expirado

## Contexto

Em produção, a instância da Ren Sushi encerrou o pareamento com `QR Code timeout`, mas `GET /instance/status` continuou devolvendo o campo `qrcode`. O cliente tratava qualquer QR presente como prova de uma sessão ativa, persistia `waiting_qr` e o painel reabria o QR expirado pelo botão **Status**.

## Contrato

- `POST /instance/connect` é a única autoridade para emitir QR ou pair code ao cliente.
- `GET /instance/status` é somente observação de estado. Seu adapter deve descartar `qrcode` e `paircode`, mesmo quando o provider os repetir.
- O portal marca localmente a proveniência do QR recebido por `connect`/`refresh_qr`/`restart` e preserva somente esse QR durante polling pendente. Em lifecycle gerenciado, `disconnected` é terminal e limpa o QR; providers manuais mantêm a compatibilidade existente. Um QR recebido por leitura passiva nunca ganha essa marca.
- Um status `disconnected` observado passivamente persiste e retorna `disconnected`, sem abrir modal de QR.
- O QR continua efêmero: não é persistido, logado nem renovado por polling.
- Uma nova tentativa explícita em **Conectar / QR** continua chamando `connect` e pode retornar o QR recém-gerado.

## Implementação

Endurecer `UazApiClient.getStatus()` para normalizar a resposta e limpar `qrCode`/`pairCode` antes de devolvê-la. No frontend, registrar no snapshot apenas a proveniência local de respostas a ações explícitas, preservando esse QR no refetch imediato até conexão ou estado terminal.

## Verificação

- Teste unitário: `getStatus` recebe `status: disconnected` com QR residual e devolve `disconnected` sem QR/pair code.
- Controle positivo: `connect` continua devolvendo o QR recebido do endpoint mutante.
- Teste do cache: `connect` gerenciado com QR → `connecting` sem QR preserva o código; `disconnected` ou QR sem marca explícita limpa o código.
- Testes do lifecycle, typecheck, lint e build.
- Após deploy de `manage-channels`, clicar **Status** deve exibir `Desconectado` sem modal; clicar **Conectar / QR** deve gerar um QR novo.

## Deploy

`uazapi-client.ts` e `whatsapp-channel-lifecycle-core.ts` têm `manage-channels` como único consumidor de runtime. Não há migration. Após o merge, o frontend sai pelo deploy automático da `main` e a Edge Function afetada é somente `manage-channels`.
