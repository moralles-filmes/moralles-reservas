/**
 * ResponsiveDialog
 *
 * Wrapper sobre Radix Dialog que renderiza:
 *   - Mobile (<640px): bottom-sheet fullscreen com slide-up
 *   - Desktop (≥640px): Dialog centrado tradicional
 *
 * Estrutura: header sticky no topo + body scrollável (flex-1) + footer sticky
 * no rodapé respeitando env(safe-area-inset-bottom).
 *
 * Usado pelo wizard de reserva (PublicPortal). O `Dialog` padrão continua
 * disponível pra outros usos.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useDialogFocusReturn } from "@/components/ui/use-dialog-focus-return";

const ResponsiveDialog = DialogPrimitive.Root;
const ResponsiveDialogTrigger = DialogPrimitive.Trigger;
const ResponsiveDialogPortal = DialogPrimitive.Portal;
const ResponsiveDialogClose = DialogPrimitive.Close;

const ResponsiveDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-background/60 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
ResponsiveDialogOverlay.displayName = "ResponsiveDialogOverlay";

interface ResponsiveDialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Esconde o botão X de fechar no canto. Default: false. */
  hideClose?: boolean;
}

/**
 * Container do diálogo. Já provê o esqueleto grid-rows pra header/body/footer.
 * Esperado: filhos diretos = ResponsiveDialogHeader + ResponsiveDialogBody +
 * ResponsiveDialogFooter (na ordem que quiser).
 */
const ResponsiveDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ResponsiveDialogContentProps
>(({ className, children, hideClose = false, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
  const focusReturn = useDialogFocusReturn(onOpenAutoFocus, onCloseAutoFocus);
  return (
  <ResponsiveDialogPortal>
    <ResponsiveDialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      {...focusReturn}
      className={cn(
        // Base: vidro forte (superfície única)
        "glass-strong",
        // Mobile: ocupa a tela toda, sem raio
        "fixed z-50 inset-x-0 bottom-0 top-0 w-full max-w-none h-[100dvh] rounded-none",
        // Desktop (sm+): centraliza, max-width, raio, max-height
        "sm:inset-auto sm:left-[50%] sm:top-[50%] sm:translate-x-[-50%] sm:translate-y-[-50%]",
        "sm:max-w-lg sm:h-auto sm:max-h-[90dvh] sm:rounded-panel",
        // Layout interno: header / body scrollável / footer
        "grid grid-rows-[auto_1fr_auto]",
        // Animações
        "data-[state=open]:animate-in data-[state=closed]:animate-out duration-200",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        // Mobile: slide de baixo pra cima
        "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
        // Desktop: zoom subtle (anula o slide bottom em sm+)
        "sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=closed]:slide-out-to-bottom-0",
        "sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95",
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className={cn(
            "absolute right-3 top-3 sm:right-4 sm:top-4 z-10",
            "h-9 w-9 coarse:h-11 coarse:w-11 rounded-full inline-flex items-center justify-center",
            "bg-background/80 text-foreground/70",
            "hover:text-foreground hover:bg-muted transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          )}
          aria-label="Fechar"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </ResponsiveDialogPortal>
  );
});
ResponsiveDialogContent.displayName = "ResponsiveDialogContent";

/** Header fixo no topo. Sem padding inferior (o body controla seu próprio padding). */
const ResponsiveDialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "px-5 sm:px-6 pt-5 sm:pt-6 pb-4 border-b",
      className,
    )}
    {...props}
  />
);
ResponsiveDialogHeader.displayName = "ResponsiveDialogHeader";

/** Área scrollável central. Define o overflow + smooth scroll iOS. */
const ResponsiveDialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]",
      "px-5 sm:px-6 py-5",
      className,
    )}
    {...props}
  />
);
ResponsiveDialogBody.displayName = "ResponsiveDialogBody";

/** Footer fixo no rodapé. Respeita safe-area em mobile (iOS notch/bottom bar). */
const ResponsiveDialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "px-5 sm:px-6 pt-3 pb-[calc(0.875rem+env(safe-area-inset-bottom))] sm:pb-4",
      "border-t bg-background/95",
      "flex items-center gap-3",
      className,
    )}
    {...props}
  />
);
ResponsiveDialogFooter.displayName = "ResponsiveDialogFooter";

const ResponsiveDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg sm:text-xl font-semibold leading-tight tracking-tight",
      className,
    )}
    {...props}
  />
));
ResponsiveDialogTitle.displayName = "ResponsiveDialogTitle";

const ResponsiveDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
ResponsiveDialogDescription.displayName = "ResponsiveDialogDescription";

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogPortal,
  ResponsiveDialogClose,
  ResponsiveDialogOverlay,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
};
