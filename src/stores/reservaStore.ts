import { create } from "zustand";
import { todayLocalISO } from "@/lib/utils";
import type { ReservaStatus } from "@/types/reserva";

interface ReservaFilters {
  date: string;
  status: ReservaStatus | "";
  search: string;
}

interface ReservaStore {
  filters: ReservaFilters;
  setFilter: <K extends keyof ReservaFilters>(key: K, value: ReservaFilters[K]) => void;
  resetFilters: () => void;
}

export const useReservaStore = create<ReservaStore>((set) => ({
  filters: {
    date: todayLocalISO(),
    status: "",
    search: "",
  },
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () =>
    set({ filters: { date: todayLocalISO(), status: "", search: "" } }),
}));
