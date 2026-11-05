import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useDialogFocusReturn } from "@/components/ui/use-dialog-focus-return";

const Sheet = DialogPrimitive.Root;

const SheetTrigger = DialogPrimitive.Trigger;

const SheetClose = DialogPrimitive.Close;

const FADE =
  "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=closed]:fade-out-0";

const sheetVariants = cva(cn("fixed z-50 overflow-y-auto bg-background p-4 shadow-lg", FADE), {
  variants: {
    side: {
      right: cn(
        "inset-y-0 right-0 h-full w-full border-l sm:max-w-md",
        "motion-safe:data-[state=open]:slide-in-from-right motion-safe:data-[state=closed]:slide-out-to-right",
      ),
      bottom: cn(
        "inset-x-0 bottom-0 max-h-[85vh] rounded-t-xl border-t pb-[max(1rem,env(safe-area-inset-bottom))]",
        "motion-safe:data-[state=open]:slide-in-from-bottom motion-safe:data-[state=closed]:slide-out-to-bottom",
      ),
    },
  },
  defaultVariants: { side: "right" },
});

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: "right" | "bottom";
  /** Sem fundo escurecido: use com `modal={false}` quando a tela atrás deve continuar visível e tocável. */
  overlay?: boolean;
}

const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ side = "right", overlay = true, className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
    const focusReturn = useDialogFocusReturn(onOpenAutoFocus, onCloseAutoFocus);
    return (
      <DialogPrimitive.Portal>
        {overlay && <DialogPrimitive.Overlay className={cn("fixed inset-0 z-50 bg-background/60", FADE)} />}
        <DialogPrimitive.Content
          ref={ref}
          {...focusReturn}
          className={cn(sheetVariants({ side }), className)}
          {...props}
        >
          {children}
          <SheetClose
            aria-label="Fechar"
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-11 coarse:w-11"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </SheetClose>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  },
);
SheetContent.displayName = "SheetContent";

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("mb-4 space-y-1.5 pr-12", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription };
