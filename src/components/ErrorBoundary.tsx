import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

const CHUNK_ERROR_FLAG = "moralles:chunk-reload-attempt";

function isDynamicImportError(error: Error): boolean {
  const msg = error.message || "";
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    error.name === "ChunkLoadError"
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);

    if (isDynamicImportError(error)) {
      const alreadyTried = sessionStorage.getItem(CHUNK_ERROR_FLAG);
      if (!alreadyTried) {
        sessionStorage.setItem(CHUNK_ERROR_FLAG, "1");
        window.location.reload();
        return;
      }
      sessionStorage.removeItem(CHUNK_ERROR_FLAG);
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center px-4 bg-background">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-bold">Algo deu errado</h1>
            <p className="text-sm text-muted-foreground">
              Encontramos um erro inesperado. Tente recarregar a página — se o problema
              persistir, avise o administrador.
            </p>
          </div>
          {import.meta.env.DEV && (
            <pre className="text-left text-xs bg-muted p-3 rounded-lg overflow-auto max-h-40">
              {error.message}
            </pre>
          )}
          <div className="flex gap-2 justify-center">
            <Button variant="outline" onClick={this.reset}>
              Tentar novamente
            </Button>
            <Button onClick={() => window.location.reload()}>Recarregar</Button>
          </div>
        </div>
      </div>
    );
  }
}
