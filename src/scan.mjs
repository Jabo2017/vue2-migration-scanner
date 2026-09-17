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
