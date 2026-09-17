#!/usr/bin/env node
/**
 * vue2-scan —— Vue 2 迁移债务扫描 CLI
 *
 * 用法示例：
 *   npx vue2-migration-scanner                     # 扫描当前目录
 *   npx vue2-migration-scanner ../pcMain            # 扫描指定目录
 *   vue2-scan --html report.html --json report.json
 *   vue2-scan --baseline baseline.json              # 看迁移进度
 *   vue2-scan --ci --max-mdi 200                    # 超标则退出码 1（给 CI 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RULES } from '../src/rules.mjs'
import { scanText, summarize, checkDeps, checkLibCompat, diffReports } from '../src/scan.mjs'
import { walk, readSource, findPackageJson } from '../src/walk.mjs'
import { renderHtml, renderMarkdown, topFiles } from '../src/report-html.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
}

const HELP = `
${c.bold('vue2-scan')} · Vue 2 迁移债务扫描器 v${PKG.version}

${c.bold('用法')}
  vue2-scan [目录] [选项]

${c.bold('选项')}
  --dir <path>        目标目录（等价于位置参数，默认当前目录）
  --ext <list>        扫描后缀，逗号分隔（默认 .vue,.js,.ts,.jsx,.tsx,.mjs,.cjs）
  --ignore <list>     额外跳过的路径（相对目标目录，逗号分隔）
  --json <file>       输出 JSON 报告
  --html <file>       输出 HTML 报告
  --md <file>         输出 Markdown 报告（适合贴 PR / 周报）
  --baseline <file>   对比上次的 JSON 报告，输出迁移进度
  --label <text>      报告里显示的目录名（默认绝对路径；分享报告时建议指定，避免泄露本机路径）
  --max-mdi <n>       MDI 超过该值则以退出码 1 结束
  --ci                等价于 --max-mdi 200 --quiet
  --top <n>           终端里展示前 n 个最重的文件（默认 10，0 关闭）
  --quiet             只输出结论
  --no-color          关闭颜色
  -h, --help          显示帮助
  -v, --version       显示版本

${c.bold('退出码')}
  0  扫描成功（未超标）
  1  MDI 超出 --max-mdi 阈值
  2  参数或目录错误

${c.bold('典型流程')}
  vue2-scan . --json baseline.json        # 迁移前存一份基线
  vue2-scan . --baseline baseline.json    # 每周跑一次，看进度
`

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
  if (argv.length === 0) {
    // 无参数时直接扫当前目录，不打印帮助，避免 npx 一跑就刷屏
  } else {
    console.log(HELP)
    process.exit(0)
  }
}
if (argv.includes('-v') || argv.includes('--version')) {
  console.log(PKG.version)
  process.exit(0)
}

function flag(name) {
  return argv.includes(`--${name}`)
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const positional = argv.filter((a, i) => !a.startsWith('-') && (i === 0 || !argv[i - 1].startsWith('--')))

const targetDir = path.resolve(opt('dir', positional[0] || process.cwd()))
const label = opt('label', '') || targetDir
const ciMode = flag('ci')
const maxMdi = ciMode ? Number(opt('max-mdi', 200)) : Number(opt('max-mdi', NaN))
const quiet = flag('quiet') || ciMode
const topN = Number(opt('top', 10))
const exts = opt('ext', '.vue,.js,.ts,.jsx,.tsx,.mjs,.cjs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const extraIgnore = (opt('ignore', '') || '').split(',').map((s) => s.trim()).filter(Boolean)

if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
  console.error(c.red(`✗ 目录不存在：${targetDir}`))
  process.exit(2)
}

const t0 = Date.now()
const { files, skippedDirs } = walk(targetDir, { exts, extraIgnore })
const findings = []
let skipped = 0
for (const f of files) {
  const code = readSource(f)
  if (code === null) {
    skipped++
    continue
  }
  findings.push(...scanText(code, path.relative(targetDir, f)))
}
const summary = summarize(findings)

let deps = []
let libCompat = []
const pkgPath = findPackageJson(targetDir)
if (pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    deps = checkDeps(pkg)
    libCompat = checkLibCompat(pkg)
  } catch {
    /* package.json 解析失败则跳过，不阻断源码扫描 */
  }
}

const elapsed = Date.now() - t0

let diff = null
const baselinePath = opt('baseline', '')
if (baselinePath) {
  if (!fs.existsSync(baselinePath)) {
    console.error(c.red(`✗ 基线文件不存在：${baselinePath}`))
    process.exit(2)
  }
  try {
    diff = diffReports(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), {
      target: targetDir,
      scannedAt: new Date().toISOString(),
      summary,
      findings,
    })
  } catch (e) {
    console.error(c.red(`✗ 基线文件解析失败：${e.message}`))
    process.exit(2)
  }
}

const remaining = files.length - skipped
const relevant = RULES.filter((r) => summary.byRule[r.id])

if (!quiet) {
  console.log('')
  console.log(`  ${c.bold('Vue 2 迁移债务扫描')} ${c.dim('·')} ${label}`)
  console.log(`  ${c.dim(`扫描 ${remaining} 个文件（跳过 ${skipped}），耗时 ${elapsed}ms`)}`)
  if (skippedDirs.length) {
    const listed = skippedDirs.slice(0, 6).join('、')
    const more = skippedDirs.length > 6 ? ` 等 ${skippedDirs.length} 个` : ''
    console.log(`  ${c.dim(`已跳过目录：${listed}${more}（产物/依赖，扫它们会虚高）`)}`)
  }
  console.log('')

  if (!findings.length) {
    console.log(`  ${c.green('未发现遗留写法')} —— 这个项目已经是 Vue 3 的写法了`)
  } else {
    console.log(`  ${'检测项'.padEnd(40)}${'命中'.padStart(6)}  处置建议`)
    console.log('  ' + c.dim('─'.repeat(86)))
    for (const r of relevant) {
      const n = summary.byRule[r.id]
      console.log(`  ${r.title.padEnd(38)}${String(n).padStart(6)}  ${c.dim(r.hint.slice(0, 30) + '…')}`)
    }
    console.log('  ' + c.dim('─'.repeat(86)))
    console.log(
      `  ${c.bold(`合计 ${summary.total} 处 · ${summary.files} 个文件`).padEnd(46)}MDI ${c.bold(summary.mdi)}  量级：${summary.band}`,
    )
    console.log(`  ${c.dim(summary.bandNote ?? '')}`)
  }

  if (topN > 0 && findings.length) {
    const heavy = topFiles(findings, topN)
    console.log('')
    console.log(`  ${c.bold('最重的文件')}`)
    for (const h of heavy) {
      const bar = '█'.repeat(Math.max(1, Math.round((h.count / heavy[0].count) * 20)))
      console.log(`   ${String(h.count).padStart(4)}  ${bar} ${c.dim(h.file)}`)
    }
  }

  if (deps.length) {
    console.log('')
    console.log(`  ${c.bold('依赖风险')}`)
    for (const d of deps) console.log(`   · ${c.cyan(`${d.name}@${d.version}`)} —— ${d.tip}`)
  }

  if (libCompat.length) {
    console.log('')
    console.log(`  ${c.bold('兼容性提醒（能装，但升级后要确认行为）')}`)
    for (const d of libCompat) console.log(`   · ${c.cyan(`${d.name}@${d.version}`)} —— ${d.tip}`)
  }

  if (diff) {
    const arrow = diff.total.delta <= 0 ? c.green('↓') : c.red('↑')
    console.log('')
    console.log(`  ${c.bold('迁移进度（对比基线）')}`)
    console.log(
      `   遗留写法 ${diff.total.before} → ${diff.total.after}  ${arrow}${Math.abs(diff.total.delta)}　MDI ${diff.mdi.before} → ${diff.mdi.after}`,
    )
    console.log(`   已消除 ${c.green(String(diff.fixedCount))} 处，新增 ${diff.addedCount ? c.red(String(diff.addedCount)) : 0} 处`)
    const improved = diff.rules.filter((r) => r.delta !== 0)
    for (const r of improved) {
      const mark = r.delta < 0 ? c.green(`${r.delta}`) : c.red(`+${r.delta}`)
      console.log(`   · ${r.title.padEnd(38)} ${r.before} → ${r.after}  ${mark}`)
    }
  }

  console.log('')
}

if (opt('json', '')) {
  const out = opt('json')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(
    out,
    JSON.stringify(
      { target: targetDir, label, scannedAt: new Date().toISOString(), version: PKG.version, summary, deps, libCompat, filesScanned: remaining, skippedDirs, findings },
      null,
      1,
    ),
  )
  console.log(`  JSON 报告：${out}`)
}

if (opt('html', '')) {
  const out = opt('html')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, renderHtml({ target: targetDir, label, summary, deps, libCompat, findings, elapsed, diff }))
  console.log(`  HTML 报告：${out}`)
}

if (opt('md', '')) {
  const out = opt('md')
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, renderMarkdown({ target: targetDir, label, summary, deps, libCompat, findings, diff }))
  console.log(`  Markdown 报告：${out}`)
}

if (!Number.isNaN(maxMdi)) {
  if (summary.mdi > maxMdi) {
    if (ciMode) console.error(`  ${c.red('✗')} MDI ${summary.mdi} 超出阈值 ${maxMdi}`)
    else console.error(`  ${c.red('✗')} MDI ${summary.mdi} 超出阈值 ${maxMdi}`)
    process.exit(1)
  }
  if (!quiet) console.log(`  ${c.green('✓')} MDI ${summary.mdi} 未超出阈值 ${maxMdi}`)
}
