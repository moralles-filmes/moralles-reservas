import * as React from "react";

type AutoFocusHandler = (event: Event) => void;

/**
 * Devolve o foco a quem abriu o diálogo quando ele fecha.
 *
 * O Radix só restaura o foco no `DialogTrigger`; diálogo controlado por estado
 * e aberto por um botão comum (o padrão do projeto) fechava com o foco no
 * `body`, e quem usa teclado perdia o lugar. O `onOpenAutoFocus` dispara antes
 * de o Radix mover o foco, então `document.activeElement` ainda é quem abriu.
 * Handler do chamador roda antes e, se der `preventDefault`, prevalece.
 */
export function useDialogFocusReturn(
  onOpenAutoFocus?: AutoFocusHandler,
  onCloseAutoFocus?: AutoFocusHandler,
) {
  const openerRef = React.useRef<HTMLElement | null>(null);

  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      onOpenAutoFocus?.(event);
    },
    [onOpenAutoFocus],
  );

  const handleCloseAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event);
      const opener = openerRef.current;
      openerRef.current = null;
      if (event.defaultPrevented || !opener || !opener.isConnected) return;
      event.preventDefault();
      opener.focus();
    },
    [onCloseAutoFocus],
  );

  return { onOpenAutoFocus: handleOpenAutoFocus, onCloseAutoFocus: handleCloseAutoFocus };
}
