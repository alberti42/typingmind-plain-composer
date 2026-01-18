// eslint.config.js
import js from "@eslint/js";
import globals from "globals";

export default [
  // Ignore common stuff (adjust as needed)
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.min.js",
      "**/vendor/**",
    ],
  },

  // Base recommended rules
  js.configs.recommended,

  // Userscript linting
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script", // userscripts are typically not ESM modules
      globals: {
        // Browser globals
        ...globals.browser,

        // Userscript globals (Tampermonkey/Greasemonkey/Violentmonkey)
        unsafeWindow: "readonly",
        GM: "readonly",

        GM_addStyle: "readonly",
        GM_addValueChangeListener: "readonly",
        GM_cookie: "readonly",
        GM_deleteValue: "readonly",
        GM_download: "readonly",
        GM_getResourceText: "readonly",
        GM_getResourceURL: "readonly",
        GM_getTab: "readonly",
        GM_getTabs: "readonly",
        GM_getValue: "readonly",
        GM_info: "readonly",
        GM_listValues: "readonly",
        GM_notification: "readonly",
        GM_openInTab: "readonly",
        GM_registerMenuCommand: "readonly",
        GM_removeValueChangeListener: "readonly",
        GM_saveTab: "readonly",
        GM_setClipboard: "readonly",
        GM_setValue: "readonly",
        GM_unregisterMenuCommand: "readonly",
        GM_xmlhttpRequest: "readonly",

        // Firefox-specific helpers some scripts use
        exportFunction: "readonly",
        cloneInto: "readonly",
      },
    },

    rules: {
      // Practical for userscripts
      "no-console": "off",

      // Catch real issues
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

      // Code quality
      "eqeqeq": ["error", "always"],
      "curly": ["error", "all"],
      "no-var": "error",
      "prefer-const": ["warn", { destructuring: "all" }],
      "no-return-await": "error",

      // Readability
      "no-multi-spaces": ["warn", { ignoreEOLComments: true }],
    },
  },
];
