/**
 * 扫描内核：纯函数，无 I/O，便于单元测试与在浏览器/CI 里复用。
 */
import { RULES, DEP_RISKS, LIB_COMPAT, MDI_BANDS } from './rules.mjs'

/**
 * 扫描一段源码，返回命中列表。
 * @param {string} code
 * @param {string} [file]
 */
export function scanText(code, file = '<inline>') {
  /** @type {import('./rules.mjs').Finding[]} */
  const findings = []
  const lines = code.split(/\r?\n/)

  for (const rule of RULES) {
    // rules.files（可选）：限定该规则只对某些扩展名生效（如深度选择器只查样式文件，避开 JS 的 >>> 位运算）
    if (rule.files && !rule.files.test(file)) continue
    rule.pattern.lastIndex = 0
    let m
    while ((m = rule.pattern.exec(code)) !== null) {
      const upto = code.slice(0, m.index)
      const line = upto.split('\n').length
      const column = m.index - upto.lastIndexOf('\n')
      findings.push({
        ruleId: rule.id,
        file,
        line,
        column,
        snippet: (lines[line - 1] || '').trim().slice(0, 120),
      })
      // 零宽匹配保护
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** 按 MDI 分数返回量级分档 */
export function bandFor(mdi) {
  return MDI_BANDS.find((b) => mdi < b.max)
}

/**
 * 按目录聚合命中 —— 迁移排期是按模块组织的，不是按文件，报告也要能按模块看。
 * 纯聚合，不做任何新判定，符合「稳定判定」原则。
 * @param {import('./rules.mjs').Finding[]} findings
 * @param {number} [limit] 最多返回多少个目录（按 MDI 降序取前 n）
 * @returns {{ dir: string, count: number, mdi: number, files: number }[]}
 */
export function groupDirs(findings, limit = 50) {
  const weightOf = new Map(RULES.map((r) => [r.id, r.weight]))
  /** @type {Map<string, { dir: string, count: number, mdi: number, files: Set<string> }>} */
  const map = new Map()
  for (const f of findings) {
    const p = f.file.replace(/\\/g, '/')
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'
    let cell = map.get(dir)
    if (!cell) map.set(dir, (cell = { dir, count: 0, mdi: 0, files: new Set() }))
    cell.count++
    cell.mdi += weightOf.get(f.ruleId) ?? 1
    cell.files.add(f.file)
  }
  return [...map.values()]
    .map((c) => ({ dir: c.dir, count: c.count, mdi: Math.round(c.mdi * 10) / 10, files: c.files.size }))
    .sort((a, b) => b.mdi - a.mdi || b.count - a.count)
    .slice(0, limit)
}

/**
 * 检测 Vue 大版本与 compat 状态，切换报告口径。
 * 判定依据只有 package.json 里的版本号事实，不做推断 —— 符合「稳定判定」原则。
 *
 * Vue 3（尤其挂了 @vue/compat）项目里，同样的「Vue 2 写法命中」含义完全不同：
 * 不是「还没开始迁移」的进度起点，而是「过渡期仍在运行、切 MODE 3 / 移除 compat 前必须清零」的阻塞清单。
 * @param {{ dependencies?: Record<string,string>, devDependencies?: Record<string,string> } | null} [pkg]
 */
export function detectContext(pkg) {
  const all = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }
  const vueVersion = String(all.vue ?? '')
  const majorStr = /^[~^>=\s]*v?(\d+)/.exec(vueVersion)?.[1]
  const vueMajor = majorStr ? Number(majorStr) : null
  const hasCompat = '@vue/compat' in all

  if (vueMajor === 3 && hasCompat) {
    return {
      vueMajor,
      hasCompat,
      mode: 'vue3-compat',
      note: '检测到 Vue 3 + @vue/compat：以下命中是过渡期仍在运行的 Vue 2 写法，即移除 compat（切 MODE 3）前必须清零的阻塞清单',
    }
  }
  if (vueMajor === 3) {
    return {
      vueMajor,
      hasCompat,
      mode: 'vue3',
      note: '检测到 Vue 3：以下命中是残留的 Vue 2 写法，可能运行时报错或产生静默行为差异',
    }
  }
  return { vueMajor, hasCompat: false, mode: vueMajor === 2 ? 'vue2' : 'unknown', note: null }
}

/**
 * 汇总扫描结果：按规则计数 + 计算迁移债务指数（MDI）。
 * MDI = Σ(命中数 × 权重)，权重反映「改起来的成本」而非「出现频率」。
 * @param {import('./rules.mjs').Finding[]} findings
 */
export function summarize(findings) {
  /** @type {Record<string, number>} */
  const byRule = {}
  /** @type {Record<string, string[]>} */
  const filesByRule = {}
  for (const f of findings) {
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
    filesByRule[f.ruleId] = filesByRule[f.ruleId] ?? []
    if (!filesByRule[f.ruleId].includes(f.file)) filesByRule[f.ruleId].push(f.file)
  }

  let mdi = 0
  for (const rule of RULES) {
    mdi += (byRule[rule.id] ?? 0) * rule.weight
  }
  mdi = Math.round(mdi * 10) / 10

  const band = bandFor(mdi)

  return {
    total: findings.length,
    files: new Set(findings.map((f) => f.file)).size,
    byRule,
    filesByRule,
    mdi,
    band: band.label,
    bandNote: band.note,
  }
}

/**
 * 检查 package.json 依赖风险。
 * @param {{ dependencies?: Record<string,string>, devDependencies?: Record<string,string> }} pkg
 */
export function checkDeps(pkg) {
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const hits = []
  for (const [name, version] of Object.entries(all)) {
    for (const risk of DEP_RISKS) {
      if (risk.test.test(name) && risk.version.test(String(version))) {
        hits.push({ name, version, tip: risk.tip })
      }
    }
  }
  return hits
}

/**
 * 兼容性提醒：能装、但升级后容易「静默失效」的包。
 * @param {{ dependencies?: Record<string,string>, devDependencies?: Record<string,string> }} pkg
 */
export function checkLibCompat(pkg) {
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const hits = []
  for (const [name, version] of Object.entries(all)) {
    for (const item of LIB_COMPAT) {
      if (item.test.test(name) && (!item.version || item.version.test(String(version)))) {
        hits.push({ name, version, tip: item.tip })
      }
    }
  }
  return hits
}

/**
 * 对比两次扫描，得出迁移进度。
 * 用法：第一次扫描存 --json baseline.json，改一阵子后再扫描并 --baseline baseline.json。
 *
 * 由于文件内容会变，counts 的差值是「权威口径」，而新增/消除的位置清单需要按
 * file:line:ruleId 求差 —— 行号会漂移，所以位置清单只做参考，进度看 counts。
 *
 * @param {any} baseline 之前的 JSON 报告
 * @param {any} current 当前的 JSON 报告
 */
export function diffReports(baseline, current) {
  const before = baseline?.summary?.byRule ?? {}
  const after = current?.summary?.byRule ?? {}

  const rules = []
  for (const rule of RULES) {
    const b = before[rule.id] ?? 0
    const a = after[rule.id] ?? 0
    if (b === 0 && a === 0) continue
    rules.push({ id: rule.id, title: rule.title, before: b, after: a, delta: a - b })
  }

  const mdiBefore = baseline?.summary?.mdi ?? 0
  const mdiAfter = current?.summary?.mdi ?? 0

  const key = (f) => `${f.file}:${f.line}:${f.ruleId}`
  const oldSet = new Set((baseline?.findings ?? []).map(key))
  const newSet = new Set((current?.findings ?? []).map(key))

  const fixed = (baseline?.findings ?? []).filter((f) => !newSet.has(key(f)))
  const added = (current?.findings ?? []).filter((f) => !oldSet.has(key(f)))

  return {
    rules,
    mdi: { before: mdiBefore, after: mdiAfter, delta: Math.round((mdiAfter - mdiBefore) * 10) / 10 },
    total: {
      before: baseline?.summary?.total ?? 0,
      after: current?.summary?.total ?? 0,
      delta: (current?.summary?.total ?? 0) - (baseline?.summary?.total ?? 0),
    },
    fixedCount: fixed.length,
    addedCount: added.length,
    fixed: fixed.slice(0, 200),
    added: added.slice(0, 200),
    scannedAt: { before: baseline?.scannedAt ?? null, after: current?.scannedAt ?? null },
  }
}
