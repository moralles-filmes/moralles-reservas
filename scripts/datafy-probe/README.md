# Probe da Fase 0 — parceiro Datafy

## O que é

Script descartável que mede o contrato real da API de administração da Datafy (Task 0 do plano `docs/superpowers/plans/2026-10-13-datafy-parceiro-conexao-self-service.md`). Não é código de produção nem é importado pelo app.

Ele imprime a **forma** das respostas, nunca valores sensíveis:

- booleanos e números curtos saem com o valor (`subscribed`, `on_trial`, `expires_in` são o que se mede); número com 6 ou mais dígitos na parte inteira sai como `number<int:Nd>` (ou `number<dec:Nd>`, se tiver casas decimais), porque pode ser telefone, id da Meta ou PIN;
- string sai como `string`, `string<empty>`, `string<sk_live_>` (só o prefixo conhecido), `string<iso8601-Z>`/`string<iso8601-offset>`/`string<iso8601-local>`/`string<date>` (só o formato da data) ou `url<host>` (rótulo do host com cara de token ou de número vira `<rótulo>`);
- nas chaves de vocabulário (`source`, `event`, `type`, `status`, `subscription`, `error`, `events`, `coexistence` e, só em resposta HTTP de erro, `code`) sai `enum<valor>`, desde que o valor tenha cara de palavra de vocabulário (nada de token aleatório);
- só em resposta HTTP 400 ou mais, o texto de erro em `message`/`error`/`detail` sai como `text<…>` quando é cópia curta de produto (até 2 dígitos, sem e-mail, URL ou token). É o que diz qual 409 veio no passo 11.

São impressos **de propósito**:

- o id do canal (só funciona com o token de conta);
- o `name` **só** de canal criado por este probe (`probe-fase0-<número>`). Os outros saem como `string` + `name_len`, porque o ORIGINAL foi nomeado à mão e o nome pode conter o telefone. O ORIGINAL se reconhece por `subscribed`, `has_number` e `fp_phone_number_id`;
- o fingerprint (12 hex do SHA-256) de `phone_number_id`, `waba_id` e `business_id`, que mostra se o número mudou de identidade ao trocar de canal. Id que não é texto aparece como `<não-string>` ou `<inteiro-impreciso>`. O telefone nunca ganha fingerprint.

Node ≥ 18. O `--env-file` exige Node ≥ 20.6. Sem dependências.

## Token

O token de conta `sk_acct_` alcança **todos** os canais da conta, inclusive o da Moralles. Nunca cole o token no chat.

Forma principal, com o token em `.env.local` na variável `TOKEN_CONTA_DATAFY`:

```bash
node --env-file=.env.local scripts/datafy-probe/probe.mjs list
```

- `.env.local` está no `.gitignore` (`.env*`). A variável não tem prefixo `VITE_`, então o Vite não a coloca no bundle.
- `TOKEN_CONTA_DATAFY` vence `DATAFY_ACCOUNT_TOKEN`. O `--env-file` **não** sobrescreve variável que já existe no terminal: se o probe parecer usar um token velho, feche o terminal e abra outro.
- **O repositório está dentro do OneDrive, então o `.env.local` sobe para a nuvem.** Ao fim da rodada: revogue este `sk_acct_` na Datafy (Minha conta → Parceiros) e apague a linha do `.env.local`. Quando o sistema precisar do token de conta (em `platform_secrets`), gere um novo só para isso.

Alternativa sem arquivo (PowerShell), num **terminal só para isso**, sem abrir agentes (Claude, Codex) nem `npm run dev` nele:

```powershell
$s = Read-Host -AsSecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
$env:DATAFY_ACCOUNT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); Remove-Variable s, b
node scripts/datafy-probe/probe.mjs list
# no fim da rodada:
Remove-Item Env:DATAFY_ACCOUNT_TOKEN
```

No bash: `read -s DATAFY_ACCOUNT_TOKEN; export DATAFY_ACCOUNT_TOKEN`, e `unset DATAFY_ACCOUNT_TOKEN` no fim.

**O link de conexão** nunca aparece no terminal nem na página, mas fica no histórico do navegador e na barra de endereço da janela de conexão. Não tire print dela nem copie o endereço. O link é documentado como de uso único e com prazo; isso não foi medido.

`node scripts/datafy-probe/probe.mjs help` lista os comandos sem precisar do token.

## Travas

- `webhook`, `pause`, `resume`, `subscribe`, `cancel` e `delete` consultam o canal antes e **só seguem se ele foi criado por este probe (name `probe-fase0-<número>`) e não está assinado**. Qualquer outro caso é recusado (saída 4): canal de outro nome (como o ORIGINAL), canal assinado, consulta que falhou ou campo ilegível. Para forçar: `--canal-fora-do-probe-ok`. **Nesta rodada essa flag não é usada.**
- `delete` exige ainda que o canal esteja **sem número e sem WABA** (`has_number: false` e `has_waba: false` na linha `trava`). Não se mediu se apagar um canal com número descadastra o número ou tira o app da WABA, o que cortaria o ORIGINAL logo depois de religado na mesma WABA.
- `subscribe` **cobra na hora** e exige `--autorizo-cobranca`; repete o `subscribe` uma vez, só se o primeiro der 2xx, para medir a idempotência.
- `cancel` exige `--autorizo-cancelamento` (e, como só canal assinado tem o que cancelar, também `--canal-fora-do-probe-ok`).
- **Nesta rodada nem `subscribe` nem `cancel` são usados** (decisão do dono).
- `link` e `serve` não têm trava: gerar link não é destrutivo e é preciso para religar o ORIGINAL.

Códigos de saída: 0 ok (inclusive HTTP 4xx/5xx medido), 1 uso, 2 token, 3 falta autorização, 4 recusado pela trava, 5 erro de transporte, 9 erro inesperado.

## Sequência da rodada de 2026-10-14 (número da Moralles)

A Moralles é empresa de teste e o dono aceitou deixá-la fora do ar durante a rodada. **ORIGINAL** = canal Datafy assinado da Moralles; **PROBE** = canal de teste.

Antes de começar:

- Leia a seção "Se algo der errado" abaixo.
- Faça os passos 4 a 16 de uma vez só: o PROBE tem trial de 2 dias, e com o trial vencido o link de conexão é recusado.
- Do passo 8 ao 16 a Moralles fica fora do ar: mensagens automáticas falham e mensagens de clientes se perdem. Se der, evite as 9h, 10h e 14h (horário de Brasília), quando rodam giftback, lembrete do dia e pesquisa.

Em cada passo, `probe` = `node --env-file=.env.local scripts/datafy-probe/probe.mjs`.

1. `probe global`: olhe `global_webhook` (e `global_webhook_count`, se houver mais de um).
   - `ausente`: siga.
   - `presente` com `global_webhook_host` = `url<gbabxcrntkwgblgqsiit.supabase.co>` (o nosso Supabase): os eventos do PROBE também vão para o nosso webhook. Do passo 9 ao 14, espere `webhook_unauthorized` no Diagnóstico ou entregas duplicadas. É ruído esperado, não falha. Siga.
   - `presente` com outro host: anote o host e avise antes de seguir.
   - `ilegível`: cole a forma e avise antes de seguir.
2. `probe list` e `probe list-ids`: o ORIGINAL é a linha com `subscribed: true` e `has_number: true` (o `name` sai como `string` + `name_len`). Anote o id dele. Se houver mais de uma linha assim, pare e avise.
3. `probe get <ORIGINAL>`: forma com número. Guarde `fingerprints` e `webhook_count` (linha de base). **Se `fingerprints.phone_number_id` vier `null` ou com marcador (`<não-string>`, `<inteiro-impreciso>`) num canal com número, pare e avise:** a comparação dos passos 10 e 16 não vai funcionar.
4. `probe create`: anote `CHANNEL_ID` (é o PROBE) e `CHANNEL_NAME`.
5. `probe dup <PROBE>`: a Datafy aceita `name` repetido? Se imprimiu `DUPLICATE_ID`, rode `probe delete <DUPLICATE_ID>` (mede o delete de canal nunca assinado e sem número).
6. `probe get <PROBE>`: forma de canal sem número.
7. `probe webhook <PROBE> https://gbabxcrntkwgblgqsiit.supabase.co/functions/v1/webhook-whatsapp?channel=00000000-0000-0000-0000-000000000000`: a URL aponta de propósito para um canal inexistente, então a entrega vira 404.
8. **No painel da Datafy** (app.datafyapi.com.br): desconecte o número da Moralles do ORIGINAL. A partir daqui a Moralles fica fora do ar (esperado). Depois `probe get <ORIGINAL>`: forma de canal assinado sem número.
9. `probe serve <PROBE>`, abra **`http://localhost:5599`** e clique em "Abrir conexão". Faça o Embedded Signup com o número da Moralles em Coexistence, escolhendo **o mesmo portfólio e a mesma WABA** de antes. Anote:
   - as linhas `POSTMESSAGE`: a origem, a forma e `from_popup` (`true` = veio da janela de conexão ou de um frame dentro dela; `false` = de qualquer outra fonte, como a própria página, uma extensão do navegador ou outra janela);
   - se nenhuma chegou. A página manda `no-referrer`, como o app; então "nada chegou" pode ser essa política ou uma restrição de domínio da Datafy, e o probe não distingue as duas;
   - a linha `JANELA_FECHADA` e se a janela **ainda estava visível na tela** quando ela apareceu. Se estava, o navegador cortou o vínculo entre as janelas (COOP das páginas da Meta), e nenhuma mensagem consegue chegar;
   - qualquer recusa (ex.: número ainda vinculado). **Se o Embedded Signup recusar, não insista: pule direto para o passo 15 para devolver o número ao ORIGINAL;** o `delete <PROBE>` fica para depois, e só se `get <PROBE>` mostrar `has_number: false` (regra do passo 14).

   Se `localhost` não abrir, use `http://127.0.0.1:5599` e anote. Ctrl+C encerra o servidor.
10. `probe get <PROBE>`: forma com número. Compare as fingerprints com o passo 3.
11. `probe link <PROBE>`: esperado 409. O `enum<…>` de `error`/`code` e o `text<…>` de `message` dizem qual (já conectado ou trial expirado).
12. `probe pause <PROBE>`, `probe get <PROBE>`, `probe resume <PROBE>`, `probe get <PROBE>`: anote as formas e se o `resume` pediu novo link. Se pediu, não gere link; siga para o passo 14.
13. Assinatura: **não executar** (decisão do dono). Registre "não medido".
14. **No painel da Datafy:** desconecte o número do PROBE. Depois `probe get <PROBE>`, e só siga para `probe delete <PROBE>` se ele mostrar `has_number: false` e `fingerprints.waba_id: null` (o `delete` confere de novo e recusa se não for assim). Mede se canal nunca assinado pode ser apagado; se der 409, anote. **Se o PROBE ainda tiver número ou WABA, não apague:** deixe o trial expirar sozinho (2 dias) e anote. O mesmo vale depois do passo 15: com o ORIGINAL religado, nunca apague um PROBE que ainda tenha número.
15. `probe serve <ORIGINAL>`, abra **`http://127.0.0.1:5599`** (o outro endereço, de propósito: são dois pontos de medida) e religue o número ao ORIGINAL, no mesmo portfólio e na mesma WABA. Anote o `POSTMESSAGE` de novo.
16. `probe get <ORIGINAL>`: as fingerprints e o `webhook_count` são iguais aos do passo 3? `subscribed` é `true` e `paused` é `false`?
17. Confira o sistema: mande uma mensagem pelo app WhatsApp Business do celular para qualquer contato (eco) e uma mensagem de outro celular para a Moralles (entrada e resposta da IA). Confira o Diagnóstico. **Pare e avise** se:
    - a fingerprint de `phone_number_id` mudou: as credenciais do canal no banco precisam ser atualizadas, o que invalida a prova de eco e exige reativação;
    - aparecer `webhook_unauthorized` com `reason: signature_invalid`: o `webhook_secret` do ORIGINAL mudou na reconexão;
    - aparecer `webhook_unauthorized` com `reason: meta_identity_mismatch`: o `phone_number_id` mudou;
    - a entrada funciona mas a resposta falha com `send_error`: o token `sk_live_` do ORIGINAL mudou.

## Se algo der errado

- **Passo 9 recusado:** vá direto ao passo 15. Apague o PROBE só se `get <PROBE>` mostrar `has_number: false`.
- **Se o passo 15 falhar, a Moralles continua fora do ar.** Religue o número ao ORIGINAL pelo painel da Datafy (app.datafyapi.com.br) ou fale com o suporte da Datafy. **Não improvise comandos do probe no ORIGINAL** (nada de `pause`, `resume`, `delete` nem `--canal-fora-do-probe-ok`). Conte ao Claude o resultado: as saídas e o que o painel mostrou.
- **Riscos de saber de antemão:** religar um número em Coexistence não é garantido. A Meta pode exigir que ele saia do PROBE antes, pode impor espera entre conexões, e o compartilhamento de histórico pode não ser oferecido de novo. Os passos 9 e 15 fazem isso duas vezes em pouco tempo. E se o trial do PROBE vencer com o número nele, o comportamento é desconhecido; por isso a rodada é feita de uma vez.

## O que colar de volta

- A saída de cada passo, como saiu no terminal. Ela só tem forma, então pode ser colada.
- As observações: se a janela fechou sozinha e se ainda estava visível, qual endereço (localhost ou 127.0.0.1) funcionou, recusas, o que o painel da Datafy mostrou e pediu.

Nunca cole o `.env.local`, o token, nem o endereço da janela de conexão. Depois da rodada, revogue o token (seção Token).
