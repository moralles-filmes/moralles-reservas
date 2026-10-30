import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ChevronRight,
  MapPin,
  Search,
  UtensilsCrossed,
  X,
} from "lucide-react";
import {
  usePublicCities,
  usePublicUnits,
  type PublicUnitCard,
} from "@/hooks/useDiscoverUnits";

const CITY_KEY = "moralles:user-city";

export default function Index() {
  const [city, setCity] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [cityOpen, setCityOpen] = useState(false);

  // Hidrata cidade do localStorage só no client
  useEffect(() => {
    const saved = localStorage.getItem(CITY_KEY);
    if (saved) setCity(saved);
  }, []);

  const handleSelectCity = (next: string | null) => {
    setCity(next);
    if (next) localStorage.setItem(CITY_KEY, next);
    else localStorage.removeItem(CITY_KEY);
    setCityOpen(false);
  };

  const { data: cities = [] } = usePublicCities();
  const { data: units = [], isLoading } = usePublicUnits({ city, search });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header
        city={city}
        cities={cities}
        cityOpen={cityOpen}
        setCityOpen={setCityOpen}
        onSelectCity={handleSelectCity}
      />

      <Hero
        search={search}
        onSearch={setSearch}
        city={city}
        onPickCity={() => setCityOpen(true)}
      />

      <Discover
        city={city}
        cities={cities}
        search={search}
        units={units}
        isLoading={isLoading}
        onPickCity={() => setCityOpen(true)}
        onClearSearch={() => setSearch("")}
      />

      <Footer />
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

interface HeaderProps {
  city: string | null;
  cities: string[];
  cityOpen: boolean;
  setCityOpen: (o: boolean) => void;
  onSelectCity: (city: string | null) => void;
}

function Header({ city, cities, cityOpen, setCityOpen, onSelectCity }: HeaderProps) {
  return (
    <header className="absolute top-0 inset-x-0 z-30">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 h-16 sm:h-20 flex items-center justify-between gap-4">
        <Link
          to="/"
          className="font-display text-xl sm:text-2xl font-semibold tracking-tight text-foreground"
        >
          moralles<span className="text-gold-ink">.</span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <CityChip
            city={city}
            cities={cities}
            open={cityOpen}
            setOpen={setCityOpen}
            onSelect={onSelectCity}
          />
          <Link to="/admin">
            <Button
              size="sm"
              className="rounded-full border border-border bg-card/90 hover:bg-card text-foreground font-medium px-4 sm:px-5 backdrop-blur"
            >
              <UtensilsCrossed className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Sou restaurante</span>
              <span className="sr-only sm:hidden">Sou restaurante</span>
            </Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─── City picker chip ────────────────────────────────────────────────────────

interface CityChipProps {
  city: string | null;
  cities: string[];
  open: boolean;
  setOpen: (o: boolean) => void;
  onSelect: (city: string | null) => void;
}

function CityChip({ city, cities, open, setOpen, onSelect }: CityChipProps) {
  const [filter, setFilter] = useState("");
  const typed = filter.trim();
  const filtered = useMemo(() => {
    const q = typed.toLowerCase();
    if (!q) return cities;
    return cities.filter((c) => c.toLowerCase().includes(q));
  }, [cities, typed]);

  const showCustomConfirm =
    typed.length >= 2 &&
    !cities.some((c) => c.toLowerCase() === typed.toLowerCase());

  const confirmTyped = () => {
    if (typed.length < 2) return;
    onSelect(toTitleCase(typed));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFilter("");
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center gap-2 rounded-full bg-card/80 hover:bg-card backdrop-blur-md border border-border px-3 sm:px-4 py-1.5 coarse:min-h-11 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {city ? (
            <span className="flex items-center gap-1.5">
              <span className="hidden sm:inline text-muted-foreground text-xs">Você está em</span>
              <span className="font-medium">{city}</span>
              <span className="text-xs text-gold-ink underline underline-offset-2">
                alterar
              </span>
            </span>
          ) : (
            <span className="font-medium">
              <span aria-hidden="true" className="sm:hidden">Cidade</span>
              <span className="sr-only sm:not-sr-only">Selecione sua cidade</span>
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md rounded-panel">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Sua cidade</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Digite o nome da sua cidade para encontrar restaurantes por perto.
          </p>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            autoFocus
            placeholder="Ex: Bauru, São Paulo, Curitiba…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-12 sm:h-11 pl-9 rounded-block"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (filtered.length > 0) onSelect(filtered[0]);
                else confirmTyped();
              }
            }}
          />
        </div>

        <div className="mt-2 max-h-[60vh] overflow-y-auto -mx-2">
          {showCustomConfirm && (
            <button
              type="button"
              onClick={confirmTyped}
              className="w-full flex items-center justify-between px-3 py-3 text-left text-sm rounded-block hover:bg-gold/15 bg-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-gold-ink" />
                Usar <span className="font-semibold">"{toTitleCase(typed)}"</span> como minha cidade
              </span>
              <ChevronRight className="h-4 w-4 text-gold-ink" />
            </button>
          )}

          {filtered.length > 0 && (
            <>
              {showCustomConfirm && (
                <p className="px-3 mt-3 mb-1 text-xs font-medium text-tertiary">
                  Cidades com restaurantes
                </p>
              )}
              <div className="divide-y">
                {filtered.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onSelect(c)}
                    className={cn(
                      "w-full flex items-center justify-between gap-3 rounded-block px-3 py-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      c === city && "text-gold-ink font-medium",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                      {c}
                    </span>
                    {c === city && (
                      <span className="text-xs">
                        selecionada
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {!showCustomConfirm && filtered.length === 0 && cities.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Comece digitando o nome da sua cidade acima.
            </p>
          )}

          {!showCustomConfirm && filtered.length === 0 && cities.length > 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhuma cidade combina com "{typed}".
            </p>
          )}
        </div>

        {city && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start coarse:min-h-11 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="h-3 w-3" />
            Limpar seleção
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

interface HeroProps {
  search: string;
  onSearch: (s: string) => void;
  city: string | null;
  onPickCity: () => void;
}

function Hero({ search, onSearch, city, onPickCity }: HeroProps) {
  return (
    <section className="relative isolate ambient min-h-[580px] sm:min-h-[640px] flex items-center justify-center overflow-hidden rounded-b-panel border-b border-border">
      <div className="relative z-10 max-w-3xl w-full text-center px-5 pt-28 sm:pt-32 pb-14 motion-safe:animate-fade-up motion-safe:[animation-duration:1s] motion-safe:[animation-timing-function:cubic-bezier(0.16,1,0.3,1)]">
        <p className="text-xs sm:text-sm font-medium text-gold-ink mb-5 sm:mb-6 inline-flex items-center gap-2">
          <span className="h-px w-8 bg-gold/40" />
          Reservas inteligentes
          <span className="h-px w-8 bg-gold/40" />
        </p>

        <h1 className="font-display font-semibold text-[2.4rem] leading-[1.05] sm:text-6xl sm:leading-[1.02] tracking-[-0.045em]">
          Encontre sua próxima
          <br />
          <span className="text-gold-ink">mesa favorita.</span>
        </h1>

        <p className="mt-5 sm:mt-6 text-muted-foreground max-w-xl mx-auto text-sm sm:text-base leading-relaxed">
          {city ? (
            <>
              Restaurantes em <span className="font-medium">{city}</span> — reserve em
              segundos, atalhe para a fila ou descubra o próximo lugar para sentar.
            </>
          ) : (
            <>
              Comece escolhendo a sua cidade. A gente cuida do resto: reserva, fila,
              confirmação no WhatsApp.
            </>
          )}
        </p>

        {/* Search bar */}
        <div className="mt-8 sm:mt-10 max-w-2xl mx-auto">
          <div className="surface flex items-stretch gap-2 rounded-full p-1.5">
            <div className="flex-1 min-w-0 flex items-center gap-2 sm:gap-3 pl-4 sm:pl-5">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder={city ? `Buscar em ${city}…` : "Buscar restaurante…"}
                className="h-12 sm:h-11 border-0 shadow-none focus-visible:ring-0 px-0 text-sm sm:text-base bg-transparent text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Button
              size="lg"
              className="rounded-full px-5 sm:px-7 shrink-0"
              onClick={() => {
                document
                  .getElementById("discover")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              Buscar
            </Button>
          </div>

          {!city && (
            <button
              type="button"
              onClick={onPickCity}
              className="mt-5 inline-flex items-center gap-2 text-sm text-gold-ink hover:text-foreground underline underline-offset-4 decoration-gold/40 coarse:min-h-11 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <MapPin className="h-3.5 w-3.5" />
              Selecionar minha cidade primeiro
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Discover (grid de restaurantes) ─────────────────────────────────────────

interface DiscoverProps {
  city: string | null;
  cities: string[];
  search: string;
  units: PublicUnitCard[];
  isLoading: boolean;
  onPickCity: () => void;
  onClearSearch: () => void;
}

function Discover({
  city,
  cities,
  search,
  units,
  isLoading,
  onPickCity,
  onClearSearch,
}: DiscoverProps) {
  return (
    <section
      id="discover"
      className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20"
    >
      <div className="flex items-end justify-between gap-4 flex-wrap mb-8 sm:mb-10">
        <div>
          <p className="text-xs font-medium text-gold-ink mb-2">
            {city ? "Onde sentar" : "Comece por aqui"}
          </p>
          <h2 className="font-display font-semibold text-3xl sm:text-4xl tracking-tight">
            {city ? (
              <>
                Restaurantes em <span className="italic">{city}</span>
              </>
            ) : (
              "Escolha sua cidade"
            )}
          </h2>
          {city && !isLoading && units.length > 0 && (
            <p className="text-sm text-muted-foreground mt-2">
              {units.length} {units.length === 1 ? "lugar" : "lugares"} para conhecer
            </p>
          )}
        </div>

        {(city || search) && (
          <div className="flex items-center gap-2">
            {search && (
              <button
                type="button"
                onClick={onClearSearch}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 coarse:min-h-11 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X className="h-3 w-3" />
                Limpar busca "{search}"
              </button>
            )}
          </div>
        )}
      </div>

      {/* Estados */}
      {!city ? (
        <CityCallout cities={cities} onPickCity={onPickCity} />
      ) : isLoading ? (
        <CardsSkeleton />
      ) : units.length === 0 ? (
        <EmptyState
          city={city}
          search={search}
          onClearSearch={onClearSearch}
          onPickCity={onPickCity}
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-7">
          {units.map((u, i) => (
            <RestaurantCard key={u.id} unit={u} index={i} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Sub-states ───────────────────────────────────────────────────────────────

function CityCallout({
  cities,
  onPickCity,
}: {
  cities: string[];
  onPickCity: () => void;
}) {
  return (
    <div className="surface rounded-panel p-8 sm:p-12 flex flex-col items-center text-center gap-4">
      <div className="h-14 w-14 rounded-full bg-gold/10 text-gold-ink flex items-center justify-center">
        <MapPin className="h-6 w-6" />
      </div>
      <h3 className="font-display font-semibold text-2xl sm:text-3xl tracking-tight">
        Onde você quer comer hoje?
      </h3>
      <p className="text-sm text-muted-foreground max-w-md">
        Escolha sua cidade para descobrir os restaurantes disponíveis e reservar em
        segundos.
      </p>
      <Button size="lg" onClick={onPickCity} className="mt-2 rounded-full px-6">
        <MapPin className="h-4 w-4 mr-2" />
        {cities.length > 0
          ? `Escolher entre ${cities.length} ${cities.length === 1 ? "cidade" : "cidades"}`
          : "Selecionar cidade"}
      </Button>
    </div>
  );
}

function EmptyState({
  city,
  search,
  onClearSearch,
  onPickCity,
}: {
  city: string;
  search: string;
  onClearSearch: () => void;
  onPickCity: () => void;
}) {
  return (
    <div className="surface rounded-panel border-dashed p-10 sm:p-14 flex flex-col items-center text-center gap-4">
      <UtensilsCrossed className="h-10 w-10 text-muted-foreground/60" />
      <h3 className="font-display text-2xl font-semibold tracking-tight">Nada por aqui ainda</h3>
      <p className="text-sm text-muted-foreground max-w-md">
        {search
          ? `Não encontramos restaurantes em ${city} com "${search}".`
          : `Ainda não há restaurantes cadastrados em ${city}.`}
      </p>
      <div className="flex items-center gap-2 flex-wrap justify-center mt-2">
        {search && (
          <Button variant="outline" size="sm" onClick={onClearSearch}>
            Limpar busca
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onPickCity}>
          Trocar de cidade
        </Button>
      </div>
    </div>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-7">
      {[1, 2, 3].map((i) => (
        <div key={i} className="surface rounded-card p-3 space-y-3">
          <Skeleton className="aspect-[16/10] rounded-block" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ─── Restaurant card ─────────────────────────────────────────────────────────

function RestaurantCard({ unit, index }: { unit: PublicUnitCard; index: number }) {
  const cityLine = [unit.address?.neighborhood, unit.address?.city]
    .filter(Boolean)
    .join(" · ");
  const initials = getInitials(unit.name);

  return (
    <Link
      to={`/r/${unit.slug}`}
      className="surface group flex flex-col rounded-card overflow-hidden hover:border-gold/40 motion-safe:transition-transform motion-safe:duration-300 motion-safe:hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-safe:animate-fade-up motion-safe:[animation-duration:1s] motion-safe:[animation-timing-function:cubic-bezier(0.16,1,0.3,1)]"
      style={{ animationDelay: `${index * 60}ms`, animationFillMode: "backwards" }}
    >
      <div className="relative aspect-[16/10] bg-muted">
        <div className="absolute inset-0 overflow-hidden">
          {unit.hero_image_url ? (
            <img
              src={unit.hero_image_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-[1.04]"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-gold/20 via-muted to-gold/10" />
          )}
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-foreground/20 to-transparent" />
        </div>

        {/* Logo overlap — fora do overflow-hidden pra não ser cortada */}
        <div className="absolute -bottom-6 left-5">
          <div className="h-14 w-14 rounded-full ring-4 ring-card bg-background overflow-hidden flex items-center justify-center shadow-lg">
            {unit.logo_url ? (
              <img
                src={unit.logo_url}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="font-display text-base text-gold-ink">{initials}</span>
            )}
          </div>
        </div>

        {(unit.price_range_min != null || unit.price_range_max != null) && (
          <div className="surface absolute top-3 right-3 rounded-full bg-card text-xs font-medium tabular px-3 py-1 text-foreground">
            {formatPriceRangeShort(unit.price_range_min, unit.price_range_max)}
          </div>
        )}
      </div>

      <div className="p-5 pt-9 flex-1 flex flex-col">
        <h3 className="font-display font-semibold text-2xl leading-tight tracking-tight">
          {unit.name}
        </h3>
        {cityLine && (
          <p className="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {cityLine}
          </p>
        )}
        {unit.description && (
          <p className="text-sm text-foreground/70 mt-3 line-clamp-2 leading-relaxed">
            {unit.description}
          </p>
        )}
        <div className="mt-4 pt-3 border-t border-dashed flex items-center justify-between text-sm">
          <span className="text-gold-ink font-medium inline-flex items-center gap-1 motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:translate-x-0.5">
            Ver e reservar
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t bg-card mt-8">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="font-display text-base text-foreground">
          moralles<span className="text-gold-ink">.</span>
        </span>
        <span>Reservas inteligentes para restaurantes</span>
        <Link to="/admin" className="hover:text-foreground coarse:min-h-11 inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          Sou restaurante →
        </Link>
      </div>
    </footer>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatPriceRangeShort(min: number | null, max: number | null): string {
  const fmt = (n: number) =>
    n.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  if (min != null && max != null) return `${fmt(min)}–${fmt(max)}`;
  if (min != null) return `a partir de ${fmt(min)}`;
  if (max != null) return `até ${fmt(max)}`;
  return "";
}
