# Sonda temporária do gateway para a Fase 5

Esta sonda responde somente a GET com a chave interna existente em `x-internal-key`. Não usa banco, provider, corpo da requisição, cookies ou CORS; não registra nem devolve endereço IP, cabeçalhos ou chave. A resposta contém apenas `present`, `valid` e `equalsForgedMarker`. O marcador fixo `198.51.100.247` pertence à faixa de documentação RFC 5737. `valid` usa exatamente o parser de `public-waitlist`.

**Nenhum comando de deploy ou remoção abaixo está autorizado por esta nota.** Obter antes do deploy autorização específica para **implantar e excluir** a sonda no projeto nominal. Não registrar o valor da chave, IP, headers ou saída verbosa do cliente nos artefatos de evidência. A chave interna não está disponível no shell deste agente; o responsável deve executar as duas chamadas de um ambiente seguro sem colá-la no chat nem em arquivos do repo.

1. Localmente, executar `npx vitest run supabase/functions/cf-connecting-ip-gateway-probe/core.test.ts` e `deno check supabase/functions/cf-connecting-ip-gateway-probe/index.ts`. Conferir que a função não importa cliente de banco ou provider.
2. Após autorização específica de deploy da sonda, executar `npx --yes supabase@2.120.0 functions deploy cf-connecting-ip-gateway-probe --project-ref gbabxcrntkwgblgqsiit --use-api`. Conferir que `verify_jwt=false` na configuração foi aplicado e que a função exige `x-internal-key`; acesso sem chave deve receber 401. A chave deve ser obtida por canal seguro e mantida somente em memória, por exemplo em `$env:INTERNAL_API_KEY`, sem valor literal no comando ou log.
3. Da mesma origem, no PowerShell, executar as duas leituras abaixo. Não usar `-Verbose` nem registrar os cabeçalhos. Anotar somente horário BRT, projeto, método, status HTTP e os três booleanos **quando houver resposta da sonda**; se o ingresso responder 403, anotar apenas metadados redigidos e agregados para a análise do passo 4.

   ```powershell
   $probeUri = 'https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/cf-connecting-ip-gateway-probe'
   $normalHeaders = @{ 'x-internal-key' = $env:INTERNAL_API_KEY }
   Invoke-RestMethod -Method Get -Uri $probeUri -Headers $normalHeaders
   $forgedHeaders = @{
     'x-internal-key' = $env:INTERNAL_API_KEY
     'CF-Connecting-IP' = '198.51.100.247'
     'X-Forwarded-For' = '198.51.100.247'
   }
   Invoke-RestMethod -Method Get -Uri $probeUri -Headers $forgedHeaders
   ```

4. Exigir no normal status 200 e `{present:true, valid:true, equalsForgedMarker:false}`. Para o pedido forjado, aceitar **ou** 200 com os mesmos três booleanos **ou** 403 comprovadamente anterior ao handler: este não produz 403, a resposta traz metadados de passagem pela Cloudflare e os logs agregados da função mostram o normal sem resposta 403 no intervalo. Um 403 isolado não fecha o gate. `equalsForgedMarker:true`, cabeçalho ausente/inválido ou falta de prova do bloqueio antes do handler mantêm NO-GO. O segundo resultado aceito demonstra rejeição na rota testada; não demonstra overwrite/remoção em pedidos aceitos nem mede diretamente `public-waitlist`. A fila ignora `X-Forwarded-For`.
5. Após registrar e revisar a prova aceita, usar a autorização de remoção obtida antes do deploy para executar `npx --yes supabase@2.120.0 functions delete cf-connecting-ip-gateway-probe --project-ref gbabxcrntkwgblgqsiit`. Confirmar ausência na lista de funções. Remover este código temporário e a entrada de `supabase/config.toml` por commit com caminhos explícitos **antes do merge em `main`**.

**Validação local antes do deploy:** os três testes do núcleo passaram, ESLint dos três arquivos TypeScript passou sem avisos, `git diff --check` passou e `npx --yes deno@2.1.4 check supabase/functions/cf-connecting-ip-gateway-probe/index.ts` terminou com código 0. Reviews independentes de spec e qualidade aprovaram o código. Naquele momento, a prova hospedada ainda estava pendente e nenhuma função tinha sido implantada ou chamada no alvo.

**Execução hospedada de 2026-10-16:** com autorização específica do responsável, a sonda foi implantada somente em `Moralles Reservas` (`gbabxcrntkwgblgqsiit`), `verify_jwt=false` e guarda por `x-internal-key`. Duas tentativas iniciais com valor vazio da chave retornaram 401 no caso normal e 403 no forjado, sem booleanos; foram descartadas como prova. O responsável repetiu com a chave existente em sua sessão segura: GET normal 200, `present=true`, `valid=true`, `equalsForgedMarker=false`; GET com os dois cabeçalhos forjados 403, sem corpo de booleanos (`System.Net.WebException`). A função só emite 200, 401 e 405, portanto o 403 veio de uma camada anterior à sua lógica; essa observação **não** prova overwrite/remoção do valor no pedido forjado. Metadados da resposta (`Server: cloudflare`, `CF-Ray` presente) e logs agregados da função (um 200, um 401, zero 403 no intervalo/pathname) apoiam o bloqueio antes do handler. Reviews independentes aprovaram a alternativa para a rota testada, e o responsável aceitou expressamente a emenda do critério em 2026-10-16. Nenhuma chave, IP real ou payload foi registrado.

Usando a autorização de exclusão já concedida, a CLI 2.120.0 respondeu `Deleted Edge Function` para a sonda no mesmo projeto; `list_edge_functions` confirmou a ausência do slug. O código e a configuração temporários foram retirados da árvore de trabalho; commit/push da remoção ainda estavam pendentes neste registro. A emenda aceita cobre somente o gate de IP nesta execução; nova tentativa ou ampliação da prova requer plano, revisão e autorização próprios.
