// Stubs for TS-only globals that aren't defined by `assemblyscript/std/types/assembly`.
// Required because we run with `noLib: true` (AssemblyScript types own the global namespace);
// without these, the IDE/tsc emits TS2318 ("Cannot find global type ...") whenever code touches
// function-typed values (e.g. matchstick-as test helpers, graph-ts callbacks).
//
// Pure type-space additions — AssemblyScript's compiler ignores `.d.ts` files.

interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
