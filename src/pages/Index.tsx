import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
    <div className="min-h-screen bg-background">
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
          className="font-display text-xl sm:text-2xl tracking-tight text-white drop-shadow"
        >
          moralles<span className="text-primary">.</span>
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
              className="rounded-full bg-white/95 hover:bg-white text-foreground font-medium px-4 sm:px-5 backdrop-blur"
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
          className="group inline-flex items-center gap-2 rounded-full bg-black/25 hover:bg-black/35 backdrop-blur-md border border-white/20 px-3 sm:px-4 py-1.5 text-sm text-white transition"
        >
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {city ? (
            <span className="flex items-center gap-1.5">
              <span className="hidden sm:inline text-white/70 text-xs">Você está em</span>
              <span className="font-medium">{city}</span>
              <span className="text-xs text-white/70 underline underline-offset-2">
                alterar
              </span>
            </span>
          ) : (
            <span className="font-medium">Selecione sua cidade</span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
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
            className="pl-9"
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
              className="w-full flex items-center justify-between px-3 py-3 text-left text-sm rounded-md hover:bg-primary/10 bg-primary/5 transition"
            >
              <span className="flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-primary" />
                Usar <span className="font-semibold">"{toTitleCase(typed)}"</span> como minha cidade
              </span>
              <ChevronRight className="h-4 w-4 text-primary" />
            </button>
          )}

          {filtered.length > 0 && (
            <>
              {showCustomConfirm && (
                <p className="px-3 mt-3 mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Cidades com restaurantes
                </p>
              )}
              <div className="divide-y">
                {filtered.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onSelect(c)}
                    className={`w-full flex items-center justify-between px-3 py-3 text-left text-sm hover:bg-muted/60 transition ${
                      c === city ? "text-primary font-medium" : ""
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                      {c}
                    </span>
                    {c === city && (
                      <span className="text-xs uppercase tracking-wider">
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
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start"
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
    <section className="relative isolate min-h-[640px] sm:min-h-[680px] flex items-center justify-center overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 20% 30%, hsl(24 85% 45% / 0.85), transparent 60%), radial-gradient(ellipse 60% 70% at 80% 70%, hsl(340 55% 35% / 0.85), transparent 55%), radial-gradient(ellipse 50% 50% at 50% 100%, hsl(38 90% 50% / 0.7), transparent 60%), linear-gradient(180deg, hsl(20 25% 18%), hsl(20 30% 12%))",
        }}
      />

      {/* Overlays — escurece + grão sutil */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/30 to-black/65" />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.07] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.6'/></svg>\")",
        }}
      />

      <div className="relative z-10 max-w-3xl w-full text-center text-white px-5 pt-24 sm:pt-28 pb-12 animate-fade-up">
        <p className="text-xs sm:text-sm uppercase tracking-[0.3em] text-white/80 mb-5 sm:mb-6 inline-flex items-center gap-2">
          <span className="h-px w-8 bg-white/40" />
          Reservas inteligentes
          <span className="h-px w-8 bg-white/40" />
        </p>

        <h1 className="font-display text-[2.4rem] leading-[1.05] sm:text-6xl sm:leading-[1.02] tracking-tight">
          Encontre sua próxima
          <br />
          <span className="italic text-primary-foreground/95">mesa favorita.</span>
        </h1>

        <p className="mt-5 sm:mt-6 text-white/85 max-w-xl mx-auto text-sm sm:text-base leading-relaxed">
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
          <div className="flex items-stretch gap-2 rounded-full bg-white shadow-2xl shadow-black/30 p-1.5 ring-1 ring-white/30">
            <div className="flex-1 flex items-center gap-2 sm:gap-3 pl-4 sm:pl-5">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                placeholder={city ? `Buscar em ${city}…` : "Buscar restaurante…"}
                className="border-0 shadow-none focus-visible:ring-0 px-0 text-sm sm:text-base bg-transparent text-foreground placeholder:text-muted-foreground"
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
              className="mt-5 inline-flex items-center gap-2 text-sm text-white/85 hover:text-white underline underline-offset-4 decoration-white/40"
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
          <p className="text-xs uppercase tracking-[0.2em] text-primary mb-2">
            {city ? "Onde sentar" : "Comece por aqui"}
          </p>
          <h2 className="font-display text-3xl sm:text-4xl tracking-tight">
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
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
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
    <div className="rounded-3xl border bg-card p-8 sm:p-12 flex flex-col items-center text-center gap-4">
      <div className="h-14 w-14 rounded-full bg-primary/10 text-primary flex items-center justify-center">
        <MapPin className="h-6 w-6" />
      </div>
      <h3 className="font-display text-2xl sm:text-3xl">
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
    <div className="rounded-3xl border border-dashed bg-muted/30 p-10 sm:p-14 flex flex-col items-center text-center gap-4">
      <UtensilsCrossed className="h-10 w-10 text-muted-foreground/60" />
      <h3 className="font-display text-2xl">Nada por aqui ainda</h3>
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
        <div key={i} className="space-y-3">
          <Skeleton className="aspect-[16/10] rounded-2xl" />
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
      className="group flex flex-col rounded-2xl overflow-hidden bg-card border hover:border-primary/40 hover:shadow-xl hover:shadow-black/5 transition-all duration-300 animate-fade-up"
      style={{ animationDelay: `${index * 60}ms`, animationFillMode: "backwards" }}
    >
      <div className="relative aspect-[16/10] bg-muted">
        <div className="absolute inset-0 overflow-hidden">
          {unit.hero_image_url ? (
            <img
              src={unit.hero_image_url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
            />
          ) : (
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 30% 30%, hsl(24 85% 50% / 0.7), transparent 55%), radial-gradient(circle at 75% 70%, hsl(340 55% 40% / 0.6), transparent 55%), linear-gradient(135deg, hsl(20 25% 22%), hsl(28 50% 18%))",
              }}
            />
          )}
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/45 to-transparent" />
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
              <span className="font-display text-base text-primary">{initials}</span>
            )}
          </div>
        </div>

        {(unit.price_range_min != null || unit.price_range_max != null) && (
          <div className="absolute top-3 right-3 rounded-full bg-white/95 backdrop-blur text-xs font-medium px-3 py-1 text-foreground">
            {formatPriceRangeShort(unit.price_range_min, unit.price_range_max)}
          </div>
        )}
      </div>

      <div className="p-5 pt-9 flex-1 flex flex-col">
        <h3 className="font-display text-2xl leading-tight tracking-tight">
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
          <span className="text-primary font-medium inline-flex items-center gap-1 transition-transform group-hover:translate-x-0.5">
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
          moralles<span className="text-primary">.</span>
        </span>
        <span>Reservas inteligentes para restaurantes</span>
        <Link to="/admin" className="hover:text-foreground transition-colors">
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
