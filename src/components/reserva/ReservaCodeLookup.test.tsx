import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ReservaCodeLookup, ReservaCodeLookupResult } from "./ReservaCodeLookup";
import { buildConfirmationMessage } from "@/lib/zapi";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const real = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...real, useNavigate: () => navigate };
});

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const UNIT = "bbbbbbbb-0000-0000-0000-000000000001";
const TOKEN = "dddddddd-0000-0000-0000-000000000001";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  navigate.mockReset();
  rpc.mockReset();
});

async function buscar(codigo: string) {
  await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
  await userEvent.type(screen.getByPlaceholderText(/AB1C2DEF/i), codigo);
  await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));
}

describe("ReservaCodeLookupResult", () => {
  it("não afirma nada enquanto está parado ou buscando", () => {
    const { rerender } = render(<ReservaCodeLookupResult state="idle" onRetry={() => {}} />);
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/não foi possível consultar/i)).not.toBeInTheDocument();
    rerender(<ReservaCodeLookupResult state="pending" onRetry={() => {}} />);
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
  });

  it("diz 'não encontrada' quando a RPC devolveu null", () => {
    render(<ReservaCodeLookupResult state="notFound" onRetry={() => {}} />);
    expect(screen.getByText("Reserva não encontrada. Verifique o código.")).toBeInTheDocument();
  });

  // O ramo que esta frente existe para criar. Ele não existia, e por isso 54
  // dias de HTTP 401 chegaram ao cliente como "código errado".
  it("diz que FALHOU, nunca 'não encontrada', quando a consulta deu erro", async () => {
    const onRetry = vi.fn();
    render(<ReservaCodeLookupResult state="error" onRetry={onRetry} />);

    expect(
      screen.getByText("Não foi possível consultar agora. Tente novamente em instantes.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /tentar de novo/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ReservaCodeLookup", () => {
  it("leva para /acompanhar quando o código resolve", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "AB1C2DEF",
      p_unit_id: UNIT,
    });
    expect(navigate).toHaveBeenCalledWith(`/acompanhar/${TOKEN}`);
  });

  it("não navega quando a RPC devolve null — diz que não encontrou", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByText("Reserva não encontrada. Verifique o código.")).toBeInTheDocument();
  });

  it("não navega e não diz 'não encontrada' quando a RPC dá erro", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await buscar("AB1C2DEF");

    expect(navigate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Não foi possível consultar agora. Tente novamente em instantes.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/não encontrada/i)).not.toBeInTheDocument();
  });

  // Defeito real de produção: o cliente copia o código exatamente como o
  // sistema o exibe (com "#" — WizardSuccess, AcompanharReserva, WhatsApp) e
  // COLA no campo. maxLength=8 cortava a colagem ANTES de qualquer sanitização
  // rodar, comendo o último caractere real do código ("#8GY6EG9X" virava
  // "#8GY6EG9" no DOM). Usa paste (não type) porque é isso que reproduz o
  // truncamento pela colagem de uma vez só — ver relatório.
  it("cola '#8GY6EG9X' do WhatsApp e busca pelo código sem a cerquilha, sem perder o último caractere", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste("#8GY6EG9X");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("digita '#' no começo e o caractere não aparece no campo", async () => {
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.type(input, "#AB1C2DEF");

    expect(input.value).toBe("AB1C2DEF");
  });

  // FIX ROUND 2 — caso mais provável que o da round 1: a DialogDescription
  // deste componente diz "recebido no WhatsApp", e a mensagem que o próprio
  // sistema manda (zapi.ts) é isso que o cliente tem na tela pra copiar. Ele
  // não recorta só o código — copia a bolha inteira. A string aqui vem do
  // PRÓPRIO template de produção, não de um exemplo inventado.
  it("cola a mensagem REAL de confirmação (gerada por buildConfirmationMessage) e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    const mensagemReal = buildConfirmationMessage({
      name: "Maria",
      date: "22/09/2026",
      time: "20:00",
      partySize: 2,
      code: "8GY6EG9X",
    });

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste(mensagemReal);
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("cola 'Código: #8GY6EG9X' sem emoji e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste("Código: #8GY6EG9X");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  // FIX ROUND 3 — o lembrete D-0 (process-reservation-reminders) NÃO usa
  // template hardcoded: usa `reservation_message_templates.body`, texto
  // LIVRE editado pelo lojista no painel (useReservationTemplates.ts, até
  // 600 chars, com "{{codigo}}" inserível em qualquer posição). Um lojista
  // pode plausivelmente incluir uma hashtag de Instagram no corpo — e
  // "último #" (round 2) pega a hashtag em vez do código. String reproduzida
  // literalmente do achado da revisão.
  it("cola lembrete customizado com hashtag de Instagram depois do código e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste("Codigo #8GY6EG9X. Segue a gente no insta #renSushiOficial");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  // Regressão menor da round 2: "#" avulso DEPOIS de um código já válido
  // apagava o campo inteiro (afterHash de um "#" final é "", e round 2
  // retornava isso direto). Na round 1 esse "#" avulso era só descartado.
  it("digita '#' por engano DEPOIS de um código válido — o código não some", async () => {
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.type(input, "AB1C2DEF#");

    expect(input.value).toBe("AB1C2DEF");
  });

  // O texto que a PRODUÇÃO de fato envia na confirmação é este, linha a linha
  // de supabase/functions/send-confirmation/index.ts:340-348 — não
  // buildConfirmationMessage de src/lib/zapi.ts, que é código morto para esse
  // fim (zero imports em supabase/functions/). O teste de zapi.ts acima
  // continua válido como proxy (mesma disposição do "#"), mas foi essa
  // imprecisão que deixou o lembrete customizável fora da primeira verificação.
  it("cola o template REAL de confirmação de send-confirmation/index.ts:340-348 (sem desconto) e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    const templateVivo =
      `✅ *Reserva Confirmada!*\n\n` +
      `Olá Maria, sua reserva está confirmada.\n\n` +
      `📅 Data: 22/09/2026\n` +
      `⏰ Horário: 20:00\n` +
      `👥 Pessoas: 2\n` +
      `🔑 Código: #8GY6EG9X\n\n` +
      `Para alterar ou cancelar, é só responder aqui. Até logo! 😊`;

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste(templateVivo);
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  // FIX ROUND 4 — o que sobrou da round 3: um `<input type="text">` REMOVE as
  // quebras de linha do texto colado ANTES do onChange rodar, sem pôr espaço
  // no lugar (HTML padrão, seguido pelo jsdom). O template DEFAULT do lembrete
  // D-0 tem `Código: #{{codigo}}\n\n` (useReservationTemplates.ts:40), então a
  // fusão acontece SEM customização nenhuma: o código chega ao onChange colado
  // na palavra seguinte ("#8GY6EG9XAcompanhe"). Basta o lojista acrescentar UMA
  // hashtag ao corpo pra que NENHUM dos dois candidatos tenha comprimento 8 —
  // a camada 2 da round 3 fica sem em que se apoiar e a extração cai no
  // fallback sem âncora, devolvendo os 8 primeiros alfanuméricos da mensagem
  // inteira ("OLMARIAL"). Mesma tela de falha do defeito original.
  //
  // A informação não está perdida: ClipboardEvent.clipboardData.getData("text")
  // entrega o texto com os "\n" intactos, e a função pura já acerta quando os
  // recebe. Estes testes usam userEvent.paste de verdade (medido: esta versão
  // popula clipboardData e dispara onPaste ANTES do onChange) — montar o
  // ClipboardEvent à mão provaria só que o mock funciona.

  // Corpo copiado literalmente de RESERVATION_TEMPLATES[0].defaultBody
  // (src/hooks/useReservationTemplates.ts:40) — com os "\n\n" preservados, que
  // é justamente o que o <input> destrói.
  const LEMBRETE_D0_DEFAULT_BODY =
    "Olá, {{cliente_nome}}! 👋\n\nLembrete da sua reserva hoje às {{horario}} para {{party_size}} pessoa(s) em {{unidade_nome}}.\n\nCódigo: #{{codigo}}\n\nAcompanhe sua reserva: {{link_acompanhamento}}\n\nPara alterar ou cancelar, é só responder esta mensagem. Te esperamos! 🍽️";

  function lembreteD0(sufixo = "") {
    const corpo = LEMBRETE_D0_DEFAULT_BODY.replace("{{cliente_nome}}", "Maria")
      .replace("{{horario}}", "20:00")
      .replace("{{party_size}}", "2")
      .replace("{{unidade_nome}}", "Ren Sushi")
      .replace("{{codigo}}", "8GY6EG9X")
      .replace("{{link_acompanhamento}}", `https://reservas.moralles.com.br/acompanhar/${TOKEN}`);
    return sufixo ? `${corpo}\n\n${sufixo}` : corpo;
  }

  it("cola o lembrete D-0 com o template DEFAULT mais uma hashtag de Instagram e busca só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste(lembreteD0("Segue a gente no insta #renSushiOficial"));
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("cola o lembrete D-0 com o template DEFAULT sem hashtag e continua buscando só pelo código", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i);
    await userEvent.click(input);
    await userEvent.paste(lembreteD0());
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("cola o código pelado, sem '#': segue pelo valor do campo, não pelo clipboard", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.paste("8GY6EG9X");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(input.value).toBe("8GY6EG9X");
    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "8GY6EG9X",
      p_unit_id: UNIT,
    });
  });

  it("digitação tecla a tecla continua funcionando (o clipboard nunca entra)", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.type(input, "AB1C2DEF");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(input.value).toBe("AB1C2DEF");
    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "AB1C2DEF",
      p_unit_id: UNIT,
    });
  });

  // O item que não pode ser afrouxado: o caminho do clipboard existe SÓ pro
  // caso em que o <input> destruiu uma quebra de linha que importava —
  // mensagem decorada com "#". Colar um pedaço no meio do que já está no campo
  // tem que continuar passando por e.target.value; usar o clipboard aqui
  // devolveria só "2DEF" e apagaria o que o cliente já tinha digitado. É o
  // controle positivo desta round: remover a condição do "#" faz ESTE teste
  // reprovar.
  it("campo já preenchido + colagem de um pedaço sem '#': concatena, não substitui", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.type(input, "AB1C");
    await userEvent.paste("2DEF");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(input.value).toBe("AB1C2DEF");
    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "AB1C2DEF",
      p_unit_id: UNIT,
    });
  });

  // A janela em que o ref sobra por um tick: medido com evento real, o único
  // paste que dispara onPaste SEM onChange é o de texto vazio (qualquer texto
  // não-vazio muda o campo e dispara o onChange que limpa o ref). Vazio nunca
  // contém "#", então a digitação seguinte passa pelo valor do campo. Medido,
  // não deduzido.
  it("paste vazio (dispara onPaste sem onChange) não contamina a digitação seguinte", async () => {
    rpc.mockResolvedValue({ data: TOKEN, error: null });
    render(wrap(<ReservaCodeLookup unitId={UNIT} />));

    await userEvent.click(screen.getByRole("button", { name: /consulte pelo código/i }));
    const input = screen.getByPlaceholderText(/AB1C2DEF/i) as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.paste("");
    await userEvent.type(input, "AB1C2DEF");
    await userEvent.click(screen.getByRole("button", { name: /^buscar$/i }));

    expect(input.value).toBe("AB1C2DEF");
    expect(rpc).toHaveBeenCalledWith("resolve_tracking_token_by_code", {
      p_code: "AB1C2DEF",
      p_unit_id: UNIT,
    });
  });
});
