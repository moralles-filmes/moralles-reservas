-- 83a: complemento do 81a/82a para o pré-voo 83 (escolha de mesa).
--
-- Roda como `postgres` DEPOIS do 81a, das migrations 20261030120000/120100,
-- do 82a e da 20261104120000, no mesmo contêiner (README §83). Só acrescenta
-- tabelas que o 81a/82a não projetam; fixtures que mudam contagens do 81/82
-- (como a mesa T14) nascem dentro da transação desfeita do 83.
-- Não reaplicar: cria tudo uma vez.
\set ON_ERROR_STOP on
begin;

commit;
