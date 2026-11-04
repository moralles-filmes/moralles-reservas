import { LocateFixed, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_ZOOM, MIN_ZOOM } from "@/lib/plan-viewport-core";

interface PlanViewportControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

const TOUCH = "coarse:min-h-[44px] coarse:min-w-[44px]";

export function PlanViewportControls({ zoom, onZoomIn, onZoomOut, onReset }: PlanViewportControlsProps) {
  return (
    <div data-no-pan className="absolute bottom-2 right-2 flex gap-1">
      <Button type="button" size="icon" variant="outline" className={TOUCH} aria-label="Aproximar" disabled={zoom >= MAX_ZOOM} onClick={onZoomIn}>
        <ZoomIn className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button type="button" size="icon" variant="outline" className={TOUCH} aria-label="Afastar" disabled={zoom <= MIN_ZOOM} onClick={onZoomOut}>
        <ZoomOut className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button type="button" size="icon" variant="outline" className={TOUCH} aria-label="Centralizar" onClick={onReset}>
        <LocateFixed className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
