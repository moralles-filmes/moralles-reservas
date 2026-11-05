# Escolha de mesa — chave por restaurante

Adendo da spec `2026-11-04-escolha-de-mesa-design.md` (branch `feat/escolha-de-mesa`). Aprovada pelo dono em 2026-11-05.

## Pedido

"O restaurante ter uma opção fácil de escolher se quer que o cliente consiga escolher a mesa no salão ao vivo e se prefere manter o padrão normal (igual era antes/é hoje)."

## Decisões do dono

1. A chave nasce **desligada** em todas as unidades: nada muda até o restaurante ligar.
2. **Uma chave por unidade**, valendo junto para página online, WhatsApp e Instagram.
3. **Dono e gerente** mudam a chave; operador não.
4. Chave desligada com escolha já feita pelo cliente: a reserva é **recusada com motivo próprio** (`seat_choice_disabled`) e a tela/agente volta sem a opção de escolher. Nunca troca a mesa em silêncio.
5. Erro ao ler a chave = **desligada** (falha fechada: o cliente segue o fluxo de hoje).

## Desenho

- **Banco.** Chave `seat_choice_enabled` em `settings` (valor JSON booleano; ausente = desligada). Entra na classe `manager` de `app_private.unit_setting_write_class` e o guard de valor recusa tudo que não for booleano (`22023 setting_value_invalid`).
- **Servidor.** O gate fica em `reserveSlot` (`_shared/availability.ts`) e vale só para `tableChoice = "customer"`: escolha do cliente com a chave desligada (ou ilegível) → `seat_choice_disabled`. A recepção (`staff`), a escolha automática (`system`) e a reserva sem escolha não leem a chave. `create-reservation` responde 409 `seat_choice_disabled`; `public-seat-map` devolve `choice_disabled` nos modos slug e token.
- **Tela.** Gestão → Reservas → Ajustes → Informações gerais: chave "Cliente escolhe a mesa", com texto de ajuda dizendo que, desligada, a reserva segue como hoje e que a recepção continua trocando e juntando mesas. Operador vê a tela sem poder salvar (mesma regra das outras chaves).
- **E5/E6.** `StepHall` só oferece "Ver o salão e escolher minha mesa" com a chave ligada (resposta do `public-seat-map`); `get_table_choice_link` devolve `{ available: false, reason: "disabled" }` com a chave desligada e o agente segue sem `table_choice`.

## Fora do escopo

E5/E6 em si; Salão ao vivo, trocar/juntar e reserva manual (não mudam); chave por salão ou por canal.
