/**
 * Node runner for the sim determinism selftest (dev tool, never bundled):
 *   node --experimental-strip-types --no-warnings client/src/sim/selftest-run.ts
 * Node ESM needs explicit extensions; sim sources use extensionless relative
 * specifiers (per tsconfig), so a resolve hook appends `.ts`.
 */
export {}; // top-level await needs module context

type NextResolve = (specifier: string, context?: unknown) => unknown;

// dynamic + untyped: @types/node is not visible to the client tsconfig
const nodeModule = (await import('node:' + 'module')) as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => unknown;
  }) => void;
};

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    // Anything relative that does not already name a MODULE extension gets
    // `.ts`. Deliberately a list rather than /\.\w+$/: designer levels are
    // `<id>.level.ts`, and a bare dot test reads `./showcase.level` as a file
    // that already has an extension and then cannot find it.
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.(?:ts|js|mjs|cjs|json)$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { runSelftest } = await import('./selftest');
const result = runSelftest();
console.log(result);
if (!result.startsWith('PASS')) throw new Error('sim selftest failed');
