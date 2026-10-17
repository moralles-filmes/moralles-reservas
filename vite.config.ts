/// <reference types="vitest" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Worktrees de frentes paralelas vivem em `.claude/worktrees/` DENTRO da
    // raiz do repo, entao o runner do diretorio principal varre os arquivos de
    // teste das outras branches. Nao e falso positivo: o teste de outra frente
    // roda contra os arquivos DESTE checkout e falha por ausencia de mudanca
    // que so existe la. Espalhar `exclude` cru apagaria os defaults do vitest
    // (node_modules, dist) — por isso o spread de configDefaults.
    // Este arquivo usa node:test e roda com `node --test`; Vitest não consegue
    // coletá-lo mesmo quando suas três asserções passam no runner do Node.
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**", "**/.superpowers/**",
      "**/supabase/tests/local-preflight/local-runtime-paths.test.mjs"],
  },
});
