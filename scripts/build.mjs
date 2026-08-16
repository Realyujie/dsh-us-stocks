import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

// Compile into a staging directory and swap it in only on success, so a failed
// build never leaves `lib/` half-written.
const root = process.cwd()

/** Must match the package name: the host looks the bundle up by this id. */
const PLUGIN_ID = 'dsh-us-stocks'

const stagingRoot = resolve(root, '.build')
const stagingLib = resolve(stagingRoot, 'lib')
const backupLib = resolve(stagingRoot, 'lib.previous')
const currentLib = resolve(root, 'lib')

/**
 * Provided by the host page at runtime, so bundling them would ship a second
 * copy of React — two React instances on one page do not share hook state and
 * break in ways that are hard to trace.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-tool/client',
]

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })

try {
  // Server half: plain tsc, emitting JS plus declarations.
  run('node', [
    'node_modules/typescript/bin/tsc',
    '-p', 'tsconfig.json',
    '--outDir', stagingLib,
    '--declarationDir', resolve(stagingLib, 'types'),
  ])

  // Browser half. The host does not import this file as a module: it loads the
  // script and expects it to hand itself in through `__ModuleLoader__.load`,
  // which supplies the `require` that resolves the externals above against the
  // host's own copies. Hence CJS wrapped in a factory rather than plain ESM —
  // an ESM bundle loads and registers nothing, and the plugin tree fails.
  if (existsSync(resolve(root, 'src/client/index.ts'))) {
    await build({
      entryPoints: [resolve(root, 'src/client/index.ts')],
      outfile: resolve(stagingLib, 'client.js'),
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      external: CLIENT_EXTERNALS,
      // Otherwise every CJK character becomes a six-byte \uXXXX escape: the
      // bundle grows and the copy is unreadable when inspecting the output.
      charset: 'utf8',
      logLevel: 'warning',
      banner: {
        js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`
          + ' var module = { exports: {} }; var exports = module.exports;',
      },
      footer: { js: 'return module.exports; } });' },
    })
  }

  promote(stagingLib, currentLib, backupLib)
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}

function promote(source, destination, backup) {
  if (!existsSync(destination)) {
    renameSync(source, destination)
    return
  }
  try {
    renameSync(destination, backup)
    renameSync(source, destination)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination)
    throw error
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
}
