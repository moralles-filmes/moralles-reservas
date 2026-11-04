import { Link } from "react-router-dom";
import { LegalLayout } from "./LegalLayout";
import { LEGAL_IDENTITY } from "./legal-identity";

export default function Privacidade() {
  const { companyName, cnpj, privacyEmail } = LEGAL_IDENTITY;
  return (
    <LegalLayout title="Política de privacidade">
      <section>
        <h2>1. Quem somos</h2>
        <p>
          O Moralles Reservas é um sistema de reservas para restaurantes, operado por {companyName}, CNPJ {cnpj}.
          Ele recebe reservas pelo site, pelo WhatsApp e pelo Direct do Instagram, organiza fila de espera e envia
          mensagens sobre o atendimento.
        </p>
        <p>
          Quando você reserva ou conversa com um restaurante pelo Moralles Reservas, o restaurante é o controlador dos
          seus dados e nós tratamos esses dados em nome dele, como operadores, nos termos da Lei Geral de Proteção de
          Dados (Lei 13.709/2018). Para os dados de quem usa o painel do restaurante, somos o controlador.
        </p>
      </section>

      <section>
        <h2>2. Dados que tratamos</h2>
        <ul>
          <li>
            <strong>Reserva e fila de espera:</strong> nome, telefone, data, horário, número de pessoas, observações que
            você escrever e o histórico das suas reservas no restaurante.
          </li>
          <li>
            <strong>WhatsApp:</strong> número de telefone, nome do perfil e o conteúdo das mensagens trocadas com o
            restaurante.
          </li>
          <li>
            <strong>Instagram:</strong> o identificador que o Instagram atribui à conversa, o nome de usuário (@), o nome
            do perfil, o conteúdo das mensagens do Direct trocadas com o restaurante e o telefone que você informar na
            conversa. Não acessamos suas publicações, seguidores nem outras conversas.
          </li>
          <li>
            <strong>Caução de reserva:</strong> quando o restaurante exige caução, o pagamento é processado pela Stripe.
            Não guardamos o número do seu cartão.
          </li>
          <li>
            <strong>Usuários do painel:</strong> nome, e-mail, papel na equipe e registros de uso necessários à
            segurança da conta.
          </li>
          <li>
            <strong>Conta do Instagram do restaurante:</strong> quando o restaurante conecta a conta profissional, guardamos
            o identificador da conta, o @ e a credencial de acesso fornecida pela Meta. A credencial fica só no servidor e
            nunca aparece no painel.
          </li>
        </ul>
      </section>

      <section>
        <h2>3. Para que usamos</h2>
        <ul>
          <li>Criar, confirmar, alterar e cancelar reservas e administrar a fila de espera.</li>
          <li>Responder às suas mensagens no WhatsApp e no Instagram, pela equipe do restaurante ou por um assistente automático.</li>
          <li>Enviar lembretes e avisos sobre a sua reserva.</li>
          <li>Enviar ofertas do restaurante, só se você autorizar. Você pode recusar a qualquer momento pelo link da mensagem.</li>
          <li>Manter a segurança do sistema e cumprir obrigações legais.</li>
        </ul>
        <p>Não vendemos dados pessoais e não usamos as suas mensagens para publicidade.</p>
      </section>

      <section>
        <h2>4. Assistente automático</h2>
        <p>
          O restaurante pode ligar um assistente de inteligência artificial que responde mensagens e faz reservas. Para
          isso, o conteúdo da conversa é enviado ao provedor de IA contratado pelo restaurante, apenas para gerar a
          resposta. A qualquer momento a equipe do restaurante pode assumir a conversa.
        </p>
      </section>

      <section>
        <h2>5. Com quem compartilhamos</h2>
        <p>Compartilhamos dados só com os fornecedores necessários para o serviço funcionar:</p>
        <ul>
          <li>Supabase e Vercel: hospedagem do banco de dados e do site.</li>
          <li>Meta (WhatsApp e Instagram) e os provedores de conexão de WhatsApp contratados pelo restaurante: entrega das mensagens.</li>
          <li>Provedores de inteligência artificial: geração das respostas do assistente, quando ligado.</li>
          <li>Stripe: pagamento de caução.</li>
          <li>Provedor de e-mail: envio de e-mails do sistema.</li>
        </ul>
        <p>
          Também podemos fornecer dados a autoridades quando a lei exigir. Alguns desses fornecedores guardam dados fora
          do Brasil, com as salvaguardas previstas na LGPD.
        </p>
      </section>

      <section>
        <h2>6. Por quanto tempo guardamos</h2>
        <p>
          Guardamos os dados enquanto o restaurante usar o serviço e pelo tempo necessário para cumprir obrigações
          legais. Os registros técnicos de recebimento de mensagens do Instagram são apagados automaticamente em até 30
          dias. Quando você pede a exclusão, seus dados de identificação são removidos como descrito na página de{" "}
          <Link to="/privacidade/exclusao-de-dados">exclusão de dados</Link>.
        </p>
      </section>

      <section>
        <h2>7. Segurança</h2>
        <p>
          Os dados de cada restaurante ficam separados dos demais, o acesso no painel depende do papel de cada pessoa na
          equipe e as credenciais de integração ficam só no servidor.
        </p>
      </section>

      <section>
        <h2>8. Seus direitos</h2>
        <p>
          Você pode pedir a confirmação de que tratamos seus dados, o acesso a eles, a correção, a anonimização ou a
          exclusão, a portabilidade, informações sobre compartilhamento e a revogação do consentimento. Faça o pedido ao
          restaurante ou diretamente a nós pelo e-mail abaixo. Respondemos em até 15 dias.
        </p>
      </section>

      <section>
        <h2>9. Contato</h2>
        <p>
          Encarregado de proteção de dados: <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>.
        </p>
      </section>

      <section>
        <h2>10. Mudanças nesta política</h2>
        <p>Quando esta política mudar, a data no topo da página será atualizada.</p>
      </section>
    </LegalLayout>
  );
}
