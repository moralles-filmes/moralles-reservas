import {
  Accessibility,
  Baby,
  Beer,
  Car,
  Drumstick,
  Leaf,
  Music,
  PawPrint,
  Tv,
  Wheat,
  Wifi,
  Wine,
  type LucideIcon,
} from "lucide-react";

export interface FacilityItem {
  code: string;
  label: string;
  icon?: LucideIcon;
}

export interface FacilityGroup {
  group: string;
  items: FacilityItem[];
}

export const FACILITY_GROUPS: FacilityGroup[] = [
  {
    group: "Estacionamento e Acessibilidade",
    items: [
      { code: "parking", label: "Estacionamento disponível", icon: Car },
      { code: "valet", label: "Estacionamento com manobrista", icon: Car },
      { code: "wheelchair_access", label: "Acesso para cadeirantes", icon: Accessibility },
    ],
  },
  {
    group: "Estrutura e Ambiente",
    items: [
      { code: "tv", label: "Televisão", icon: Tv },
      { code: "live_music", label: "Música ao vivo", icon: Music },
      { code: "wifi", label: "Wifi Gratuito", icon: Wifi },
      { code: "baby_chair", label: "Cadeiras para bebês", icon: Baby },
      { code: "pet_friendly", label: "Pet Friendly", icon: PawPrint },
      { code: "kids_area", label: "Espaço Kids", icon: Baby },
    ],
  },
  {
    group: "Alimentos e Bebidas",
    items: [
      { code: "gluten_free", label: "Opções sem glúten", icon: Wheat },
      { code: "lactose_free", label: "Opções sem lactose", icon: Drumstick },
      { code: "vegan", label: "Opções vegetarianas / Vegano", icon: Leaf },
      { code: "kosher", label: "Opções Kosher", icon: Beer },
      { code: "corkage_free", label: "Rolha livre", icon: Wine },
    ],
  },
];

const ALL_ITEMS: FacilityItem[] = FACILITY_GROUPS.flatMap((g) => g.items);

export function getFacilityLabel(code: string): string {
  return ALL_ITEMS.find((i) => i.code === code)?.label ?? code;
}

export function getFacilityIcon(code: string): LucideIcon | undefined {
  return ALL_ITEMS.find((i) => i.code === code)?.icon;
}
