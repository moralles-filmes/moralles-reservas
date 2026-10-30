import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogTitle,
} from "./responsive-dialog";

// Diálogo controlado por estado, aberto por botão comum (sem DialogTrigger),
// que é o padrão das telas: o Radix sozinho deixava o foco no body ao fechar.
function Controlled({ responsive = false, keepFocus = false }: { responsive?: boolean; keepFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const onCloseAutoFocus = keepFocus ? (e: Event) => e.preventDefault() : undefined;
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir</button>
      {responsive ? (
        <ResponsiveDialog open={open} onOpenChange={setOpen}>
          <ResponsiveDialogContent onCloseAutoFocus={onCloseAutoFocus}>
            <ResponsiveDialogTitle>Título</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>Descrição</ResponsiveDialogDescription>
            <input aria-label="Campo" />
          </ResponsiveDialogContent>
        </ResponsiveDialog>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
            <DialogTitle>Título</DialogTitle>
            <DialogDescription>Descrição</DialogDescription>
            <input aria-label="Campo" />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

describe("useDialogFocusReturn", () => {
  for (const responsive of [false, true]) {
    const name = responsive ? "ResponsiveDialog" : "Dialog";

    it(`${name}: Esc devolve o foco ao botão que abriu`, async () => {
      const user = userEvent.setup();
      render(<Controlled responsive={responsive} />);
      const opener = screen.getByRole("button", { name: "Abrir" });
      await user.click(opener);
      await screen.findByRole("dialog");
      expect(document.activeElement).not.toBe(opener);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(opener);
    });

    it(`${name}: preventDefault de quem chama prevalece`, async () => {
      const user = userEvent.setup();
      render(<Controlled responsive={responsive} keepFocus />);
      const opener = screen.getByRole("button", { name: "Abrir" });
      await user.click(opener);
      await screen.findByRole("dialog");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).not.toBe(opener);
    });
  }
});
