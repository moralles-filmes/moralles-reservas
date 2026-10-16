# Sonda temporária do gateway para a Fase 5

Esta sonda responde somente a GET com a chave interna existente em `x-internal-key`. Não usa banco, provider, corpo da requisição, cookies ou CORS; não registra nem devolve endereço IP, cabeçalhos ou chave. A resposta contém apenas `present`, `valid` e `equalsForgedMarker`. O marcador fixo `198.51.100.247` pertence à faixa de documentação RFC 5737. `valid` usa exatamente o parser de `public-waitlist`.

**Nenhum comando de deploy ou remoção abaixo está autorizado por esta nota.** Obter antes do deploy autorização específica para **implantar e excluir** a sonda no projeto nominal. Não registrar o valor da chave, IP, headers ou saída verbosa do cliente nos artefatos de evidência. A chave interna não está disponível no shell deste agente; o responsável deve executar as duas chamadas de um ambiente seguro sem colá-la no chat nem em arquivos do repo.

1. Localmente, executar `npx vitest run supabase/functions/cf-connecting-ip-gateway-probe/core.test.ts` e `deno check supabase/functions/cf-connecting-ip-gateway-probe/index.ts`. Conferir que a função não importa cliente de banco ou provider.
2. Após autorização específica de deploy da sonda, executar `npx --yes supabase@2.120.0 functions deploy cf-connecting-ip-gateway-probe --project-ref gbabxcrntkwgblgqsiit --use-api`. Conferir que `verify_jwt=false` na configuração foi aplicado e que a função exige `x-internal-key`; acesso sem chave deve receber 401. A chave deve ser obtida por canal seguro e mantida somente em memória, por exemplo em `$env:INTERNAL_API_KEY`, sem valor literal no comando ou log.
3. Da mesma origem, no PowerShell, executar as duas leituras abaixo. Não usar `-Verbose` nem registrar os cabeçalhos. Anotar somente horário BRT, projeto, método, status HTTP e três booleanos de cada resposta.

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

4. Exigir status 200 e `{present:true, valid:true, equalsForgedMarker:false}` nas duas leituras. Se a segunda devolver `equalsForgedMarker:true`, o cabeçalho forjado passou pelo gateway; se `present` ou `valid` for falso, a dependência da fila não está comprovada. Em qualquer desses casos, manter NO-GO. O teste não afirma que `X-Forwarded-For` é removido; a fila o ignora.
5. Após registrar e revisar os booleanos, usar a autorização de remoção obtida antes do deploy para executar `npx --yes supabase@2.120.0 functions delete cf-connecting-ip-gateway-probe --project-ref gbabxcrntkwgblgqsiit`. Confirmar que o endpoint deixou de responder. Remover este código temporário e a entrada de `supabase/config.toml` por commit com caminhos explícitos **antes do merge em `main`**.

**Validação local da preparação:** os três testes do núcleo passaram, ESLint dos três arquivos TypeScript passou sem avisos, `git diff --check` passou e `npx --yes deno@2.1.4 check supabase/functions/cf-connecting-ip-gateway-probe/index.ts` terminou com código 0. Reviews independentes de spec e qualidade aprovaram o código; a prova hospedada continua pendente. Nenhuma função foi implantada ou chamada no alvo nesta preparação.
