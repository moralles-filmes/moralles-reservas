# Datafy parceiro — rollout de produção em 2026-10-15

Escopo autorizado: pré-voos, migrations, 13 Edge Functions e merge do PR #28 para publicar o frontend. Piloto, vínculo de canal e contratação ficam para depois. Este registro supersede as restrições de deploy dos checkpoints anteriores, sem alterar suas evidências históricas.

## Banco

- Projeto confirmado: Moralles Reservas (`gbabxcrntkwgblgqsiit`). Backup físico COMPLETED de 2026-10-15 05:49:32 UTC; PITR desabilitado.
- Pré-voos de telefone normalizado e WABA→organização retornaram zero conflitos, inclusive imediatamente antes da retomada.
- CLI 2.120.0: dry-run inicial listou somente `20261014120000`, `20261014170540`, `20261015171115`, nessa ordem. Aplicação exclusivamente por `supabase db push --skip-vault`, sem seed/roles/include-all.
- Primeira migration aplicada; segunda falhou com `25P01` em LOCK TABLE. Leitura posterior comprovou ausência da tabela WABA e da coluna de proveniência da segunda migration; somente a primeira estava no histórico.
- Correção `3116856`: BEGIN/COMMIT explícitos envolvendo toda a segunda migration. Implementador e revisão independente aprovaram; harness executou arquivo cru duas vezes, quatro corridas com espera de lock observada, rollback de conflito com ausência de fixtures e trigger restaurado, grupos 62/63. Cluster próprio encerrado. Gates estáticos: 93 testes aprovados.
- Novo dry-run listou somente as duas restantes; db push concluiu ambas. Histórico remoto confirma as três versões.
- Auditoria real `scripts/audit-function-acl.ts`: 154 funções não-trigger, 27 entradas na allowlist, zero violações; inventário equivalente-advisor 0028=10 / 0029=25 conforme política. Credencial mínima obtida pela CLI em memória, sem logs, runtime instalado e rede restrita ao projeto. Não se redirecionou o job não-produção `acl-com-banco`.
- Quatro tabelas novas com RLS/FORCE RLS e zero policies; quatro índices únicos principais válidos/ready; três triggers de origem/WABA habilitados; zero constraints Datafy não validadas; zero grants diretos de service_role em WABA owners; zero divergências de backfill/proveniência.

## Edge Functions

Deploy via CLI `functions deploy` com lista explícita, `--use-api --jobs 1`, após validação do banco. Todas ACTIVE, versão incrementada e verify_jwt idêntico ao estado anterior:

| Função | Versão publicada | verify_jwt |
|---|---:|---|
| manage-platform-secrets | 22 | true |
| manage-channels | 47 | true |
| manage-organizations | 43 | true |
| manage-whatsapp-templates | 2 | false |
| process-whatsapp-channel-health | 9 | false |
| process-whatsapp-templates | 2 | false |
| send-cancellation | 44 | false |
| send-confirmation | 69 | false |
| send-manual-message | 48 | false |
| send-scheduled-whatsapp | 2 | false |
| send-whatsapp | 68 | false |
| webhook-whatsapp | 104 | false |
| whatsapp-health | 35 | true |

Smoke POST sem credenciais/corpo vazio: 401 em onze funções; 400 em send-scheduled-whatsapp e webhook-whatsapp, que recusam o envelope inválido. Nenhuma chamada de contratação/vínculo ou teste de entrega foi feita. Esse smoke não comprova o fluxo autenticado nem a integração real do piloto.

## Frontend e pendências

PR #28 mergeável; acl-estatico aprovado no commit de correção `3116856` ([check](https://github.com/moralles-filmes/moralles-reservas/actions/runs/38807931337/job/116673522101)). Após este registro, conferir novamente o check do HEAD final, realizar merge e verificar o deploy da main na Vercel. O resultado final fica também no histórico do PR/deployment.

Piloto permanece pendente: configurar/validar token de conta e endpoint de alertas, vínculo explícito do canal Moralles, eco/ativação, segunda loja e acompanhamento operacional. Não confundir release de código com homologação do provider. A limitação histórica MAIN109 da Task13 continua documentada e não bloqueia este escopo.
