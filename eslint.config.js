import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Worktrees de frentes paralelas vivem em `.claude/worktrees/` DENTRO da raiz
    // do repo, entao o lint do diretorio principal varre o codigo das outras
    // branches — e acusa violacao que so existe la, numa versao velha do arquivo.
    // Mesmo buraco que o `vite.config.ts` ja fechou pro vitest; sem os dois, o
    // gate de uma frente reprova por causa de outra e "eslint 0 erros" deixa de
    // significar a mesma coisa dependendo de onde foi rodado.
    ignores: ["dist", "build", "coverage", ".claude/worktrees/**"],
  },
  // Edge Functions Deno — SÓ `no-undef`, e existe por um motivo específico.
  //
  // `tsc -b` não alcança supabase/functions (o tsconfig do app não as inclui) e
  // não há Deno instalado no ambiente de CI. Resultado: um identificador fora de
  // escopo compila, passa no lint, passa nos 611 testes e só explode em runtime
  // — foi exatamente assim que um `ReferenceError` chegou ao caminho de
  // autorização de `manage-whatsapp-instances` (achado IAA-6B-05, auditoria de
  // 2026-08-02), num ramo que só executa quando o lookup de `platform_admins`
  // falha. Nenhuma ferramenta do projeto o teria pego.
  //
  // Ligar o conjunto completo aqui produziria ruído (imports por URL, globais do
  // Deno, convenções próprias) e seria abandonado. Uma regra só, que pega a
  // classe de defeito que passou, é o que se sustenta.
  {
    files: ["supabase/functions/**/*.ts"],
    languageOptions: {
      // Parser TS explícito: sem ele o espree padrão nem parseia o arquivo, e o
      // "erro de parse" seria confundido com ausência de achado.
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        Deno: "readonly",
        EdgeRuntime: "readonly",
        // LIMITAÇÃO CONHECIDA: `no-undef` não entende tipos de TypeScript, e
        // acusa identificador que só existe como TIPO. Tipo do lib DOM usado
        // nestas funções entra aqui — é o preço de ter a regra funcionando sem
        // Deno instalado. Se esta lista começar a crescer toda semana, a regra
        // virou tributo: troque por um typecheck de verdade sobre
        // supabase/functions em vez de desligá-la em silêncio.
        RequestInit: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
    },
  },
  // App React + TypeScript (browser; node pros arquivos de config na raiz).
  {
    files: ["**/*.{ts,tsx}"],
    // As Edge Functions rodam noutro runtime, com globais e imports próprios —
    // o conjunto completo aqui só geraria ruído. Elas têm bloco próprio abaixo.
    ignores: ["supabase/functions/**"],
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
