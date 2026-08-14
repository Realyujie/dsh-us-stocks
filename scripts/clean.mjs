import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
for (const target of ['lib', '.build']) {
  rmSync(resolve(root, target), { recursive: true, force: true })
}
