import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

// Compile into a staging directory and swap it in only on success, so a failed
// build never leaves `lib/` half-written.
const root = process.cwd()
const stagingRoot = resolve(root, '.build')
const stagingLib = resolve(stagingRoot, 'lib')
const backupLib = resolve(stagingRoot, 'lib.previous')
const currentLib = resolve(root, 'lib')

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })

try {
  run('node', [
    'node_modules/typescript/bin/tsc',
    '-p', 'tsconfig.json',
    '--outDir', stagingLib,
    '--declarationDir', resolve(stagingLib, 'types'),
  ])
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
