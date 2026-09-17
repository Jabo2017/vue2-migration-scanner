import fs from 'node:fs'
import path from 'node:path'

/** 默认跳过的目录：产物、依赖、缓存 —— 扫它们只会污染报告 */
export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'dist-demo', 'build', 'out', '.git', '.github',
  'coverage', '.next', '.nuxt', '.output', '.cache', '.turbo', '.vite',
  'public', 'static', 'assets', 'vendor', 'bower_components',
  '.vscode', '.idea', '.husky', '__snapshots__', 'tmp', 'temp',
  // 构建产物目录：lib / es / umd 里是打包后的代码，扫它会把「压缩后的框架内部实现」
  // 算成业务债务，MDI 会虚高。真实的业务源码在 src/ 里。
  'lib', 'es', 'esm', 'umd',
])

/** 单个文件大小上限（超过认为不是人写的源码，可能是打包产物） */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * 递归收集待扫描文件。
 * 返回 skippedDirs 是为了「不静默忽略」—— 用户能看到哪些目录被跳过了，需要时用 --only 之类的方式补救。
 *
 * @param {string} dir 根目录
 * @param {{ exts?: string[], ignoreDirs?: Set<string>, extraIgnore?: string[] }} [opts]
 * @returns {{ files: string[], skippedDirs: string[] }}
 */
export function walk(dir, opts = {}) {
  const exts = opts.exts ?? ['.vue', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS
  const extraIgnore = (opts.extraIgnore ?? []).map((s) => s.replace(/\\/g, '/'))
  const files = []
  /** @type {string[]} */
  const skippedDirs = []

  ;(function rec(current) {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(current, e.name)
      const rel = path.relative(dir, full).replace(/\\/g, '/')
      if (extraIgnore.some((p) => rel === p || rel.startsWith(p + '/'))) continue

      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name) || e.name.startsWith('.')) {
          skippedDirs.push(rel)
          continue
        }
        rec(full)
      } else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          if (fs.statSync(full).size > MAX_FILE_BYTES) continue
        } catch {
          continue
        }
        files.push(full)
      }
    }
  })(dir)

  return { files, skippedDirs }
}

/**
 * 读取文件内容；二进制 / 读失败返回 null。
 * @param {string} file
 * @returns {string|null}
 */
export function readSource(file) {
  try {
    const code = fs.readFileSync(file, 'utf8')
    return code.includes('\u0000') ? null : code
  } catch {
    return null
  }
}

/** 找最近的 package.json（只在上层目录里找一层，避免 monorepo 认错根） */
export function findPackageJson(dir) {
  const p = path.join(dir, 'package.json')
  return fs.existsSync(p) ? p : null
}
