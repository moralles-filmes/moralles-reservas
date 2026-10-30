import { useNavigate } from "react-router-dom";
import { ChevronDown, UtensilsCrossed } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useCurrentUnit } from "@/hooks/useCurrentUnit";
import { useUnitPublicContent } from "@/hooks/useUnitPublicContent";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSidebarCollapse } from "./sidebar-context";

interface SidebarUnitProfileProps {
  basePath: "g" | "o";
}

export function SidebarUnitProfile({ basePath }: SidebarUnitProfileProps) {
  const { memberships } = useAuth();
  const unit = useCurrentUnit();
  const navigate = useNavigate();
  const { data: content } = useUnitPublicContent(unit?.unit_id ?? "");
  const { collapsed } = useSidebarCollapse();

  if (!unit) return null;

  const heroUrl = content?.hero_image_url ?? null;
  const logoUrl = content?.logo_url ?? null;
  const hasMultiple = memberships.length > 1;

  const handleSwitch = (slug: string) => {
    navigate(`/${basePath}/${slug}`);
  };

  // Trilho recolhido: só o avatar circular (logo ou ícone), com tooltip do nome.
  if (collapsed) {
    const avatar = (
      <div className="mx-auto h-10 w-10 rounded-full bg-card ring-1 ring-sidebar-border shadow-depth-1 overflow-hidden flex items-center justify-center">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <UtensilsCrossed className="h-5 w-5 text-gold" />
        )}
      </div>
    );
    if (!hasMultiple) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{avatar}</TooltipTrigger>
          <TooltipContent side="right">{unit.unit_name}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`${unit.unit_name}, trocar unidade`} className="w-full rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {avatar}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right" className="w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Trocar unidade</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {memberships.map((m) => (
            <DropdownMenuItem
              key={m.unit_id}
              onClick={() => handleSwitch(m.unit_slug)}
              className={m.unit_slug === unit.unit_slug ? "font-medium text-gold" : ""}
            >
              {m.unit_name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const card = (
    <div
      className={cn(
        "surface relative w-full h-32 rounded-block overflow-hidden group",
        hasMultiple && "cursor-pointer hover:shadow-depth-2 transition-shadow",
      )}
    >
      {heroUrl ? (
        <img
          src={heroUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-gold to-gold/70" />
      )}

      {/* Véu e texto sobre a foto de capa são fixos (preto/branco): a foto não muda com o tema. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/20 to-transparent" />

      <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-end gap-2.5">
        <div className="h-11 w-11 rounded-full bg-logo-plate ring-2 ring-background shadow-depth-1 overflow-hidden shrink-0 flex items-center justify-center">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <UtensilsCrossed className="h-5 w-5 text-gold" />
          )}
        </div>
        <div className="flex-1 min-w-0 pb-0.5">
          <p className="text-sm font-semibold text-white truncate drop-shadow-md leading-tight">
            {unit.unit_name}
          </p>
          {unit.organization_slug && (
            <p className="text-[11px] text-white/90 truncate drop-shadow-md leading-tight mt-0.5">
              {unit.role === "owner" ? "Proprietário" : unit.role === "gerente" ? "Gerente" : "Operador"}
            </p>
          )}
        </div>
        {hasMultiple && (
          <ChevronDown className="h-4 w-4 text-white/90 drop-shadow-md shrink-0 mb-1" />
        )}
      </div>
    </div>
  );

  if (!hasMultiple) {
    return card;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="w-full text-left rounded-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {card}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Trocar unidade
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.unit_id}
            onClick={() => handleSwitch(m.unit_slug)}
            className={m.unit_slug === unit.unit_slug ? "font-medium text-gold" : ""}
          >
            {m.unit_name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
