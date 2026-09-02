# Reconexão WhatsApp por QR Code no portal — design

## Contexto e problema

O canal configurado pelo suporte em **Automações** já contém as credenciais necessárias para operar o provider, mas a rota de gestão `/g/:unitSlug/whatsapp` só libera QR Code quando o adapter possui provisionamento automático. Na prática, owner/gerente consegue reconectar UazAPI, enquanto Z-API e WAHA exibem “fale com o suporte” mesmo quando a instância já existe e só precisa de novo pareamento.

A Meta Cloud API é o quarto provider registrado, porém não usa sessão de WhatsApp Web nem pareamento por QR Code. Ela continuará expondo apenas status; apresentar QR nesse provider seria um fluxo falso.

## Decisão

Separar as capabilities client-safe por operação e tornar a obtenção de QR uma operação do registry, independente de provisionamento automático:

- `qrConnection`: provider oferece pareamento por QR e pode liberar `connect|refresh_qr` para canal já configurado;
- `disconnect` e `restart`: continuam independentes, para a UI não oferecer ações que o adapter não suporta;
- `status`: continua disponível para qualquer canal com `getConnectionStatus`.

O registry ganhará um contrato de leitura de QR para providers manuais. Z-API buscará `GET /instances/{instanceId}/token/{token}/qr-code` e WAHA buscará `GET /api/{session}/auth/qr?format=raw`, ambos com timeout, autenticação server-side e parsing fail-closed. UazAPI preserva seu lifecycle gerenciado. Meta Cloud API manterá `qrConnection:false`.

O endpoint `manage-channels` continuará autenticando owner/gerente por `(user_id, unit_id)`. Para `connect|refresh_qr`, um canal manual precisa ser explicitamente resolvido dentro da unidade; nenhuma credencial, provider, external ID ou erro bruto cruza o shape client-safe. A resposta efêmera contém somente o QR e capabilities booleanas.

Não será criado canal manual pelo portal. Se a organização ainda não possui canal configurado, a regra comercial/provisionamento atual permanece: apenas o provider com lifecycle gerenciado e administrativamente selecionado pode criar a instância. Assim, “já configurado em Automações” é pré-condição para QR de Z-API/WAHA.

O QR nunca será persistido no banco nem logado. `status` para provider manual reconcilia o estado real e, quando o provider reportar que aguarda pareamento, pode incluir o QR na resposta; o frontend preserva o valor efêmero enquanto consulta status e só o renova por ação explícita. A UI renderiza o QR somente quando `qr_available` for verdadeiro e mostra botões de reinício/desconexão apenas conforme as respectivas capabilities. No WAHA, `STOPPED`/`FAILED` dispara um único `start`/`restart` e aguarda `SCAN_QR_CODE` por uma janela limitada antes de buscar o código; passkey não é apresentado como QR.

## UX

- Canal Z-API, WAHA ou UazAPI desconectado e configurado: botão **Conectar WhatsApp**.
- Ao iniciar: cartão com instruções e QR Code; botão **Renovar QR Code**.
- Polling permanece visibility-aware e consulta status sem renovar automaticamente o QR; o botão renova o código sem expor credenciais.
- Canal conectado: status e número continuam visíveis; cada ação aparece somente se suportada.
- Meta Cloud API: nenhuma promessa de QR; a tela explica que a conexão é administrada sem pareamento por QR.
- Operador continua redirecionado; apenas owner/gerente pode consultar ou alterar lifecycle.

## Critérios de aceite

- Owner/gerente de uma unidade com canal Z-API configurado e desconectado consegue gerar e renovar QR no portal.
- Owner/gerente de uma unidade com canal WAHA configurado e aguardando autenticação consegue gerar e renovar QR no portal.
- UazAPI mantém provisionamento, QR, status, restart e disconnect existentes.
- Meta Cloud API não mostra botão de QR.
- Canal manual de outra unidade não pode ser usado, mesmo fornecendo `channel_id` diretamente.
- Operador e usuário sem membership recebem 403 nas ações client-safe.
- Resposta client-safe não contém provider, credenciais, token, secret ou external instance ID.
- Resposta malformada/non-2xx do provider não é renderizada como QR.
- QR não é gravado em `whatsapp_channels`, logs ou audit payloads.

## Deploy

A mudança em `_shared/whatsapp-provider-core.ts` e `_shared/whatsapp-providers.ts` exige redeploy conjunto de `webhook-whatsapp`, `send-whatsapp`, `send-confirmation`, `send-cancellation`, `send-manual-message`, `manage-channels`, `whatsapp-health` e `manage-organizations`. Não há migration. O frontend deve ser publicado no mesmo rollout, depois da Edge Function compatível.
