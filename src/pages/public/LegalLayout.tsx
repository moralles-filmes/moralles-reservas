import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { LEGAL_UPDATED_AT } from "./legal-identity";

export function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="min-h-[100dvh] bg-background text-foreground px-4 py-10 flex justify-center pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <Card className="w-full max-w-3xl h-fit p-6 sm:p-8 space-y-6">
        <header className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">Moralles Reservas</p>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">Atualizado em {LEGAL_UPDATED_AT}</p>
        </header>
        <div className="space-y-6 text-sm leading-relaxed [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-1 [&_a]:underline [&_a]:underline-offset-2">
          {children}
        </div>
      </Card>
    </main>
  );
}
