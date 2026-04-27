import { create } from "zustand";
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

const today = new Date().toISOString().split("T")[0];

export const useReservaStore = create<ReservaStore>((set) => ({
  filters: {
    date: today,
    status: "",
    search: "",
  },
  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () =>
    set({ filters: { date: today, status: "", search: "" } }),
}));
