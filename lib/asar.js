/**
 * asar 归档只读访问。
 *
 * Electron 把整个应用（含 node_modules 与内置技能）打进一个 app.asar，
 * 系统调用读不到里面的文件，Node 的 ESM 解析也不认这个路径。
 * 这里直接解析 asar 头，按需读出指定文件的文本。
 *
 * 格式：8 字节 pickle 前缀 → 4 字节头长度 → JSON 头 → 文件数据区。
 * 每个文件的 offset 是相对数据区起点的偏移。
 */
import { open } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const headerCache = new Map()

/**
 * 读取并缓存一个 asar 的索引。
 * @param {string} archivePath
 * @returns {Promise<{ fd: FileHandle, base: number, byPath: Map<string, {size:number, offset:number}> } | null>}
 */
async function loadIndex(archivePath) {
  const cached = headerCache.get(archivePath)
  if (cached) return cached
  if (!existsSync(archivePath)) return null
  let handle
  try {
    handle = await open(archivePath, 'r')
    const sizeBuf = Buffer.alloc(16)
    await handle.read(sizeBuf, 0, 16, 0)
    const headerSize = sizeBuf.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    await handle.read(headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8'))
    // 数据区起点按 8 字节对齐
    const base = 16 + headerSize + ((8 - (headerSize % 8)) % 8)
    const byPath = new Map()
    const walk = (node, path) => {
      for (const [key, value] of Object.entries(node.files || {})) {
        const next = path + '/' + key
        if (value.files) walk(value, next)
        else byPath.set(next, { size: value.size, offset: Number(value.offset) })
      }
    }
    walk(header, '')
    const index = { handle, base, byPath }
    headerCache.set(archivePath, index)
    return index
  } catch {
    try { await handle?.close() } catch { /* 忽略 */ }
    return null
  }
}

/**
 * 按 asar 内路径读文本。
 * @param {string} archivePath asar 文件
 * @param {string} innerPath 以 / 开头的内部路径
 * @returns {Promise<string | null>}
 */
export async function readAsarFile(archivePath, innerPath) {
  const index = await loadIndex(archivePath)
  if (index === null) return null
  const entry = index.byPath.get(innerPath)
  if (entry === undefined) return null
  try {
    const buf = Buffer.alloc(entry.size)
    await index.handle.read(buf, 0, entry.size, index.base + entry.offset)
    return buf.toString('utf8')
  } catch {
    return null
  }
}

/**
 * 列出某前缀下的直接子项名。
 * @param {string} archivePath
 * @param {string} prefix 以 / 开头、以 / 结尾
 * @returns {Promise<string[]>}
 */
export async function listAsarDir(archivePath, prefix) {
  const index = await loadIndex(archivePath)
  if (index === null) return []
  const names = new Set()
  for (const key of index.byPath.keys()) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    if (rest === '') continue
    const first = rest.split('/')[0]
    names.add(first)
  }
  return [...names].sort()
}

/** 清空索引缓存（asar 被替换后使用）。 */
export function clearAsarCache() {
  for (const index of headerCache.values()) {
    try { index.handle.close() } catch { /* 忽略 */ }
  }
  headerCache.clear()
}
