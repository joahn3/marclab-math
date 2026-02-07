module.exports = {
  env: { browser: true, es2021: true },
  parserOptions: { ecmaVersion: "latest", sourceType: "script" },
  plugins: ["html"],
  rules: {
    "no-undef": "error",
    "no-unexpected-multiline": "error",
    "no-unused-vars": ["warn", { "args": "none" }]
  }
};