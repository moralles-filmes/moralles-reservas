import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, UtensilsCrossed } from "lucide-react";

interface UnitSwitcherProps {
  basePath: "g" | "o";
}

export function UnitSwitcher({ basePath }: UnitSwitcherProps) {
  const { memberships } = useAuth();
  const { unitSlug } = useParams<{ unitSlug: string }>();
  const navigate = useNavigate();

  const current = memberships.find((m) => m.unit_slug === unitSlug) ?? memberships[0];

  if (!current) return null;

  const handleSwitch = (slug: string) => {
    navigate(`/${basePath}/${slug}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 max-w-[200px]">
          <UtensilsCrossed className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate font-medium">{current.unit_name}</span>
          {memberships.length > 1 && <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />}
        </Button>
      </DropdownMenuTrigger>
      {memberships.length > 1 && (
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Trocar unidade
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {memberships.map((m) => (
            <DropdownMenuItem
              key={m.unit_id}
              onClick={() => handleSwitch(m.unit_slug)}
              className={m.unit_slug === unitSlug ? "font-medium text-primary" : ""}
            >
              {m.unit_name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
