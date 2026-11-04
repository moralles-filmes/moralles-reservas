import { describe, expect, it } from "vitest";
import {
  comparePassantes,
  computePassantesReport,
  type PassanteInput,
  type PassanteRow,
} from "./relatorio-passantes";

let n = 0;
function row(p: Partial<PassanteRow>): PassanteRow {
  n += 1;
  return {
    id: `w${n}`,
    party_size: 2,
    status: "seated",
    arrived_at: "2026-11-03T15:00:00Z",
    seated_at: null,
    released_at: null,
    table_id: null,
    ...p,
  };
}

const base = {
  tables: [
    { id: "t1", number: 1, hall_id: "h1" },
    { id: "t2", number: 2, hall_id: "h1" },
  ],
  halls: [{ id: "h1", name: "Salão" }],
  fromKey: "2026-11-03",
  toKey: "2026-11-04",
  ticketCents: 5000,
};
const run = (walkIns: PassanteRow[], extra: Partial<PassanteInput> = {}) =>
  computePassantesReport({ ...base, walkIns, ...extra });

describe("computePassantesReport", () => {
  it("desistência após sentar não conta como desistência", () => {
    const r = run([
      row({ status: "left", seated_at: "2026-11-03T15:05:00Z" }),
      row({ status: "left" }),
      row({ status: "seated", seated_at: "2026-11-03T15:05:00Z" }),
    ]);
    expect(r.kpis.abandonedGroups).toBe(1);
    expect(r.kpis.seatedGroups).toBe(2);
    expect(r.kpis.abandonRatePct).toBeCloseTo(33.33, 1);
  });

  it("em espera fica fora das taxas; taxa null sem denominador", () => {
    const r = run([row({ status: "waiting" })]);
    expect(r.kpis.waitingGroups).toBe(1);
    expect(r.kpis.abandonRatePct).toBeNull();
    expect(r.kpis.directSeatedPct).toBeNull();
    expect(r.kpis.avgWaitSec).toBeNull();
  });

  it("espera <= 60s é sentou direto e fica fora da média de espera", () => {
    const r = run([
      row({ arrived_at: "2026-11-03T15:00:00Z", seated_at: "2026-11-03T15:01:00Z" }),
      row({ arrived_at: "2026-11-03T15:00:00Z", seated_at: "2026-11-03T15:10:00Z" }),
      row({ arrived_at: "2026-11-03T15:00:00Z", seated_at: "2026-11-03T15:20:00Z" }),
    ]);
    expect(r.kpis.directSeatedGroups).toBe(1);
    expect(r.kpis.directSeatedPct).toBeCloseTo(33.33, 1);
    expect(r.kpis.waitSampleSize).toBe(2);
    expect(r.kpis.avgWaitSec).toBe(900);
    expect(r.kpis.medianWaitSec).toBe(900);
  });

  it("sem released_at fica fora do tempo na mesa e entra na cobertura", () => {
    const r = run([
      row({ seated_at: "2026-11-03T15:00:00Z", released_at: "2026-11-03T16:00:00Z", table_id: "t1" }),
      row({ seated_at: "2026-11-03T15:00:00Z", table_id: "t1" }),
    ]);
    expect(r.kpis.avgTableSec).toBe(3600);
    expect(r.kpis.releasedGroups).toBe(1);
    expect(r.kpis.tableCoverageDenominator).toBe(2);
  });

  it("agrupa por dia/hora/dow BRT perto da meia-noite", () => {
    // 01:30Z de 04/11 = 22:30 de terça 03/11 em BRT
    const r = run([row({ arrived_at: "2026-11-04T01:30:00Z" })]);
    expect(r.daily.find((d) => d.date === "2026-11-03")!.groups).toBe(1);
    expect(r.daily.find((d) => d.date === "2026-11-04")!.groups).toBe(0);
    expect(r.byHour[22].groups).toBe(1);
    expect(r.byDow[1].label).toBe("Ter");
    expect(r.byDow[1].groups).toBe(1);
    expect(r.heatmap[1].hours[22]).toBe(1);
    expect(r.heatmapMax).toBe(1);
    expect(r.byDow.map((d) => d.label)).toEqual(["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]);
  });

  it("giro = sentados ÷ dias; salão e mesa; sem mesa/sem salão", () => {
    const r = run([
      row({ seated_at: "2026-11-03T15:00:00Z", table_id: "t1" }),
      row({ seated_at: "2026-11-03T16:00:00Z", table_id: "t1" }),
      row({ seated_at: "2026-11-03T16:00:00Z", table_id: "t2" }),
      row({ seated_at: "2026-11-03T16:00:00Z", table_id: null }),
      row({ seated_at: "2026-11-03T16:00:00Z", table_id: "zzz" }),
      row({ status: "left" }),
    ]);
    expect(r.periodDays).toBe(2);
    const t1 = r.byTable.find((t) => t.id === "t1")!;
    expect(t1.groups).toBe(2);
    expect(t1.turnover).toBe(1);
    expect(r.byTable.find((t) => t.id === null)!.name).toBe("Sem mesa");
    expect(r.byTable.find((t) => t.id === null)!.groups).toBe(2);
    expect(r.byHall.find((h) => h.id === "h1")!.groups).toBe(3);
    expect(r.byHall.find((h) => h.id === null)!.name).toBe("Sem salão");
    expect(r.kpis.seatedWithoutTable).toBe(1);
  });

  it("receita = pessoas sentadas × ticket; buckets", () => {
    const r = run([
      row({ party_size: 3, seated_at: "2026-11-03T15:00:00Z" }),
      row({ party_size: 8, status: "left" }),
    ]);
    expect(r.kpis.revenueCents).toBe(15000);
    expect(r.byPartySize.map((b) => b.bucket)).toEqual(["03-04", "07-08"]);
  });
});

describe("comparePassantes", () => {
  it("sem base devolve null; com base devolve % e pp", () => {
    const empty = run([]);
    const cur = run([row({ seated_at: "2026-11-03T15:00:00Z" }), row({ status: "left" })]);
    const c0 = comparePassantes(cur, empty);
    expect(c0.groups.delta).toBeNull();
    expect(c0.abandonRatePct.delta).toBeNull();
    expect(c0.avgTableSec.delta).toBeNull();

    const prev = run([row({ seated_at: "2026-11-03T15:00:00Z" })]);
    const c1 = comparePassantes(cur, prev);
    expect(c1.groups.delta).toBe(100);
    expect(c1.abandonRatePct.delta).toBe(50);
    expect(c1.abandonRatePct.unit).toBe("pp");
  });
});
