import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: [
      "src/modules/strategies/**/*.{js,jsx,mjs,ts,tsx}",
      "src/modules/execution/**/*.{js,jsx,mjs,ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/news", "**/news/**"],
              message: "News must never reach strategies or execution.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([".next/**", "coverage/**"]),
]);
