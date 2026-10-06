// Lambda entry. Its loader only resolves .js/.mjs handlers; Node 24 runs the .ts from here.
export { handler } from "./src/index.ts";
