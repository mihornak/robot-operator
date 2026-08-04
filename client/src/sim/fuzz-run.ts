/**
 * Node runner for the randomised navigation fuzz (dev tool, never bundled):
 *   node --experimental-strip-types --no-warnings client/src/sim/fuzz-run.ts [seed] [samples]
 * Same `.ts` resolve hook as selftest-run.ts — Node ESM needs explicit
 * extensions and the sim sources use extensionless relative specifiers.
 */
export {}; // top-level await needs module context

type NextResolve = (specifier: string, context?: unknown) => unknown;

const nodeModule = (await import('node:' + 'module')) as unknown as {
  registerHooks: (hooks: {
    resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => unknown;
  }) => void;
};

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.\w+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const argv = (globalThis as { process?: { argv: string[] } }).process?.argv ?? [];
const seed = Number(argv[2]) || 0xbadf00d;
const samples = Number(argv[3]) || 6;

const { runFuzz, formatFuzz } = await import('./fuzz');
const report = runFuzz(seed, samples);
const text = formatFuzz(report);
console.log(text);
if (!text.startsWith('PASS')) throw new Error('navigation fuzz failed');
