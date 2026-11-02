
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
const dir = 'D:\\dshbox\\instances\\container-1793541804-57e2d6c4-cc4f-41e0-99d3-4afa9e8312fa\\profile\\sessions\\--E-decision-skills--\\session-0ad1f82d-b63d-43bc-bbba-3cc1b223ff1d'
const entries = await readdir(dir, { withFileTypes: true })
console.log('entries:', entries.map(e => e.name + (e.isFile() ? '(file)' : e.isDirectory() ? '(dir)' : '(other)')))
for (const e of entries) {
  const s = await stat(join(dir, e.name))
  console.log('  ' + e.name + ' size=' + s.size)
}
