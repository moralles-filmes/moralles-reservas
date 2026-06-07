import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Não lintar build/deps/cobertura nem as Edge Functions Deno
  // (supabase/functions roda noutro runtime, com globais e imports próprios).
  {
    ignores: ["dist", "build", "coverage", "supabase/functions"],
  },
  // App React + TypeScript (browser; node pros arquivos de config na raiz).
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // O tsconfig do projeto desativa de propósito noImplicitAny /
      // noUnusedLocals / noUnusedParameters. Alinhar o ESLint a essa decisão:
      // sinalizar como warning (não bloquear o lint) em vez de error.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
