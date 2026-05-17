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
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={cn(sizeClass, n <= safe ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30")}
        />
      ))}
    </div>
  );
}
