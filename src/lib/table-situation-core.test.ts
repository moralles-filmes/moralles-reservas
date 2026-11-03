import { describe, it, expect } from "vitest";
import {
  brtNow,
  deriveTableStates,
  type BlockWindow,
  type SituationInput,
} from "./table-situation-core";

type Res = SituationInput["reservations"][number];
type Walk = SituationInput["walkIns"][number];
type Wait = SituationInput["waitlistSeated"][number];

// 2026-10-30 19:20 BRT = 22:20Z
const NOW = new Date("2026-10-30T22:20:00Z");

function res(o: Partial<Res> = {}): Res {
  return {
    id: "r1",
    table_id: "t1",
    date: "2026-10-30",
    time: "19:00",
    status: "confirmed",
    party_size: 4,
    arrived_at: null,
    released_at: null,
    ...o,
  };
}

function walk(o: Partial<Walk> = {}): Walk {
  return {
    id: "w1",
    table_id: "t1",
    status: "seated",
    seated_at: "2026-10-30T22:00:00Z",
    party_size: 2,
    released_at: null,
    ...o,
  };
}

function wait(o: Partial<Wait> = {}): Wait {
  return {
    id: "f1",
    table_id: "t1",
    status: "seated",
    seated_at: "2026-10-30T22:00:00Z",
    party_size: 3,
    released_at: null,
    ...o,
  };
}

function input(o: Partial<SituationInput> = {}): SituationInput {
  return {
    tables: [{ id: "t1", hall_id: "h1" }],
    reservations: [],
    walkIns: [],
    waitlistSeated: [],
    blocks: [],
    now: NOW,
    durationMinutes: 90,
    ...o,
  };
}

function block(o: Partial<BlockWindow> = {}): BlockWindow {
  return {
    table_id: "t1",
    hall_id: null,
    blocked_from: "2026-10-30T21:00:00Z",
    blocked_to: "2026-10-30T23:00:00Z",
    ...o,
  };
}

const st = (i: SituationInput) => deriveTableStates(i).get("t1")!;

describe("brtNow", () => {
  it("converte para data, minutos e ontem em BRT", () => {
    expect(brtNow(new Date("2026-10-31T02:30:00Z"))).toEqual({
      date: "2026-10-30",
      minutes: 1410,
      yesterday: "2026-10-29",
    });
  });
});

describe("deriveTableStates", () => {
  it("mesa sem nada fica livre", () => {
    expect(st(input()).situation).toBe("free");
  });

  it("mesa bloqueada pela janela de bloqueio", () => {
    expect(st(input({ blocks: [block()] })).situation).toBe("blocked");
  });

  it("bloqueio fora da janela não bloqueia", () => {
    expect(
      st(input({ blocks: [block({ blocked_to: "2026-10-30T22:20:00Z" })] })).situation,
    ).toBe("free");
  });

  it("mesa ocupada por reserva com chegada", () => {
    const s = st(input({ reservations: [res({ arrived_at: "2026-10-30T22:00:00Z" })] }));
    expect(s.situation).toBe("occupied");
    expect(s.occupant).toEqual({
      kind: "reservation",
      id: "r1",
      since: "2026-10-30T22:00:00Z",
      partySize: 4,
    });
    expect(s.overtime).toBe(false);
  });

  it("mesa atrasada com minutos de atraso", () => {
    const s = st(input({ reservations: [res()] }));
    expect(s.situation).toBe("late");
    expect(s.minutesLate).toBe(20);
    expect(s.focusReservationId).toBe("r1");
  });

  it("mesa chegando: confirmada daqui a 10 min", () => {
    const s = st(input({ reservations: [res({ time: "19:30" })] }));
    expect(s.situation).toBe("arriving");
    expect(s.minutesUntil).toBe(10);
    expect(s.focusReservationId).toBe("r1");
  });

  it("mesa reservada: confirmada mais tarde", () => {
    const s = st(input({ reservations: [res({ time: "21:00" })] }));
    expect(s.situation).toBe("reserved");
    expect(s.focusReservationId).toBe("r1");
  });

  it("bloqueio vence ocupada", () => {
    const s = st(input({ blocks: [block()], walkIns: [walk()] }));
    expect(s.situation).toBe("blocked");
  });

  it("ocupada vence atrasada na mesma mesa", () => {
    const s = st(
      input({
        reservations: [
          res({ id: "late" }),
          res({ id: "here", time: "19:10", arrived_at: "2026-10-30T22:10:00Z" }),
        ],
      }),
    );
    expect(s.situation).toBe("occupied");
    expect(s.occupant?.id).toBe("here");
  });

  it("várias reservas: atrasada com foco na mais antiga e, liberada, reservada na seguinte", () => {
    const r21 = res({ id: "r21", time: "21:00" });
    const s1 = st(input({ reservations: [res({ id: "r19" }), r21] }));
    expect(s1.situation).toBe("late");
    expect(s1.minutesLate).toBe(20);
    expect(s1.focusReservationId).toBe("r19");
    expect(s1.nextReservationId).toBe("r21");
    const s2 = st(
      input({
        reservations: [res({ id: "r19", released_at: "2026-10-30T22:15:00Z" }), r21],
      }),
    );
    expect(s2.situation).toBe("reserved");
    expect(s2.focusReservationId).toBe("r21");
  });

  it("passou do tempo: ocupada com overtime", () => {
    const now = new Date("2026-10-30T23:31:00Z"); // 20:31 BRT
    const s = st(
      input({ now, reservations: [res({ arrived_at: "2026-10-30T22:00:00Z" })] }),
    );
    expect(s.situation).toBe("occupied");
    expect(s.overtime).toBe(true);
  });

  it("ocupada atravessa a meia-noite", () => {
    const now = new Date("2026-10-31T03:20:00Z"); // 00:20 BRT de 31
    const s = st(
      input({
        now,
        reservations: [
          res({ date: "2026-10-30", time: "23:30", arrived_at: "2026-10-31T02:30:00Z" }),
        ],
      }),
    );
    expect(s.situation).toBe("occupied");
    expect(s.overtime).toBe(false);
  });

  it("bloqueio do salão afeta mesas do salão", () => {
    const m = deriveTableStates(
      input({
        tables: [
          { id: "t1", hall_id: "h1" },
          { id: "t2", hall_id: "h2" },
        ],
        blocks: [block({ table_id: null, hall_id: "h1" })],
      }),
    );
    expect(m.get("t1")!.situation).toBe("blocked");
    expect(m.get("t2")!.situation).toBe("free");
  });

  it("bloqueio da unidade inteira afeta todas as mesas", () => {
    const m = deriveTableStates(
      input({
        tables: [
          { id: "t1", hall_id: "h1" },
          { id: "t2", hall_id: "h2" },
        ],
        blocks: [block({ table_id: null, hall_id: null })],
      }),
    );
    expect(m.get("t1")!.situation).toBe("blocked");
    expect(m.get("t2")!.situation).toBe("blocked");
  });

  it("passante sentado sem liberação ocupa; liberado fica livre", () => {
    const s1 = st(input({ walkIns: [walk()] }));
    expect(s1.situation).toBe("occupied");
    expect(s1.occupant?.kind).toBe("walk_in");
    expect(
      st(input({ walkIns: [walk({ released_at: "2026-10-30T22:10:00Z" })] })).situation,
    ).toBe("free");
  });

  it("fila sentada sem liberação ocupa; liberada fica livre", () => {
    const s1 = st(input({ waitlistSeated: [wait()] }));
    expect(s1.situation).toBe("occupied");
    expect(s1.occupant?.kind).toBe("waitlist");
    expect(
      st(input({ waitlistSeated: [wait({ released_at: "2026-10-30T22:10:00Z" })] })).situation,
    ).toBe("free");
  });

  it("reserva pending daqui a 10 min fica reservada, não chegando", () => {
    const s = st(input({ reservations: [res({ time: "19:30", status: "pending" })] }));
    expect(s.situation).toBe("reserved");
  });

  it("reserva cancelada, no_show, liberada ou sem mesa é ignorada", () => {
    const s = st(
      input({
        reservations: [
          res({ id: "a", status: "cancelled" }),
          res({ id: "b", status: "no_show" }),
          res({ id: "c", released_at: "2026-10-30T22:00:00Z" }),
          res({ id: "d", table_id: null }),
        ],
      }),
    );
    expect(s.situation).toBe("free");
  });

  it("time com segundos dá o mesmo resultado", () => {
    const a = st(input({ reservations: [res({ time: "19:00" })] }));
    const b = st(input({ reservations: [res({ time: "19:00:00" })] }));
    expect(b).toEqual(a);
  });

  it("passante sentado há 2 dias sem liberação fica livre", () => {
    const s = st(input({ walkIns: [walk({ seated_at: "2026-10-28T22:00:00Z" })] }));
    expect(s.situation).toBe("free");
  });

  it("fila sentada há 2 dias sem liberação fica livre", () => {
    const s = st(input({ waitlistSeated: [wait({ seated_at: "2026-10-28T22:00:00Z" })] }));
    expect(s.situation).toBe("free");
  });

  it("chegando: confirmada em agora+15 chega, agora+16 é reservada", () => {
    expect(st(input({ reservations: [res({ time: "19:35" })] })).situation).toBe("arriving");
    expect(st(input({ reservations: [res({ time: "19:36" })] })).situation).toBe("reserved");
  });

  it("confirmada exatamente na hora de agora fica chegando", () => {
    const s = st(input({ reservations: [res({ time: "19:20" })] }));
    expect(s.situation).toBe("arriving");
    expect(s.minutesUntil).toBe(0);
  });

  it("reserva com chegada de 2 dias atrás sem liberação não ocupa", () => {
    const s = st(
      input({
        reservations: [res({ date: "2026-10-28", arrived_at: "2026-10-28T22:00:00Z" })],
      }),
    );
    expect(s.situation).toBe("free");
  });

  it("reserva de ontem sem chegada não fica atrasada", () => {
    const s = st(input({ reservations: [res({ date: "2026-10-29" })] }));
    expect(s.situation).toBe("free");
  });

  it("com mais de um ocupante vence o de since mais antigo", () => {
    const s = st(
      input({
        walkIns: [walk({ seated_at: "2026-10-30T22:10:00Z" })],
        waitlistSeated: [wait({ seated_at: "2026-10-30T21:50:00Z" })],
      }),
    );
    expect(s.occupant?.id).toBe("f1");
  });
});
