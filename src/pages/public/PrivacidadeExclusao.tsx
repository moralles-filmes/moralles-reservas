import { Link } from "react-router-dom";
import { LegalLayout } from "./LegalLayout";
import { LEGAL_IDENTITY } from "./legal-identity";

export default function PrivacidadeExclusao() {
  const { privacyEmail } = LEGAL_IDENTITY;
  return (
    <LegalLayout title="Exclusão de dados">
      <p>
        Esta página explica como pedir a exclusão dos dados que o Moralles Reservas guarda sobre você, inclusive os
        recebidos pelo Instagram e pelo WhatsApp. Os detalhes de quais dados guardamos estão na{" "}
        <Link to="/privacidade">política de privacidade</Link>.
      </p>

      <section>
        <h2>Se você é cliente de um restaurante</h2>
        <ol>
          <li>
            Envie um e-mail para <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> com o assunto "Exclusão de
            dados".
          </li>
          <li>
            Informe o nome do restaurante e pelo menos um destes dados: o telefone usado na reserva ou no WhatsApp, ou o
            seu @ do Instagram.
          </li>
          <li>
            Podemos pedir uma confirmação pelo mesmo canal (por exemplo, uma mensagem no WhatsApp ou no Direct) para ter
            certeza de que o pedido é seu.
          </li>
        </ol>
        <p>Você também pode fazer o pedido diretamente à equipe do restaurante, que o encaminha para nós.</p>
      </section>

      <section>
        <h2>O que é apagado</h2>
        <ul>
          <li>Nome, telefone e e-mail do seu cadastro.</li>
          <li>O identificador do Instagram, o @ e o nome do perfil ligados às suas conversas.</li>
        </ul>
        <p>
          O histórico de reservas do restaurante continua existindo, mas sem nada que identifique você. Isso não pode ser
          desfeito. Dados que a lei obriga a guardar, como registros de pagamento, ficam pelo prazo legal.
        </p>
        <p>Confirmamos a exclusão por e-mail em até 15 dias.</p>
      </section>

      <section>
        <h2>Se você conectou a conta do Instagram de um restaurante</h2>
        <ol>
          <li>No painel do restaurante, abra a página Instagram e use "Desconectar".</li>
          <li>
            Se quiser, remova também o acesso no próprio Instagram: Configurações, depois Apps e sites, e remova o
            Moralles Reservas.
          </li>
          <li>
            Para apagar também as conversas recebidas por essa conta, envie o pedido para{" "}
            <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>.
          </li>
        </ol>
      </section>
    </LegalLayout>
  );
}
