import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarRatingProps {
  value: number;
  size?: "sm" | "md";
}

export function StarRating({ value, size = "sm" }: StarRatingProps) {
  const sizeClass = size === "md" ? "h-5 w-5" : "h-3.5 w-3.5";
  const safe = Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : 0;
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = Math.min(1, Math.max(0, safe - (n - 1)));
        return (
          <div key={n} className={cn("relative shrink-0", sizeClass)}>
            <Star className={cn(sizeClass, "text-muted-foreground/30")} />
            {fill > 0 && (
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fill * 100}%` }}
              >
                <Star className={cn(sizeClass, "fill-gold text-gold")} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
