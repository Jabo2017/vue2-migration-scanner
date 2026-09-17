import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'cli.mjs')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'legacy-project')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v2scan-'))

/** 跑 CLI，返回 { code, out } */
function run(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

test('--version 输出 package.json 里的版本号', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const { code, out } = run(['--version'])
  assert.equal(code, 0)
  assert.equal(out.trim(), pkg.version)
})

test('--help 输出用法说明', () => {
  const { code, out } = run(['--help'])
  assert.equal(code, 0)
  assert.match(out, /vue2-scan/)
  assert.match(out, /--baseline/)
  assert.match(out, /退出码/)
})

test('扫描 fixture 生成 JSON 报告，且跳过 node_modules 与 dist', () => {
  const jsonOut = path.join(TMP, 'report.json')
  const { code } = run([FIXTURE, '--json', jsonOut, '--quiet'])
  assert.equal(code, 0)

  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'))
  assert.ok(report.summary.total > 0, '应扫出遗留写法')
  assert.equal(report.summary.byRule['lifecycle-destroy'], 2)
  assert.equal(report.summary.byRule['mixins'], 1)
  assert.equal(report.summary.byRule['sync-modifier'], 1)
  assert.equal(report.summary.files, 2, '只有 LegacyPanel.vue 与 main.js 命中')

  for (const f of report.findings) {
    assert.ok(!f.file.includes('node_modules'), `不应扫 node_modules：${f.file}`)
    assert.ok(!f.file.startsWith('dist'), `不应扫 dist：${f.file}`)
    assert.ok(!f.file.includes('Modern.vue'), `Vue 3 写法不应误报：${f.file}:${f.line}`)
  }
})

test('依赖风险被识别', () => {
  const jsonOut = path.join(TMP, 'deps.json')
  run([FIXTURE, '--json', jsonOut, '--quiet'])
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'))
  const names = report.deps.map((d) => d.name).sort()
  assert.deepEqual(names, ['@vue/cli-service', 'element-ui', 'moment', 'vue', 'vue-router', 'vuex'])
})

test('--md 生成 Markdown 报告', () => {
  const mdOut = path.join(TMP, 'report.md')
  const { code } = run([FIXTURE, '--md', mdOut, '--quiet'])
  assert.equal(code, 0)
  const md = fs.readFileSync(mdOut, 'utf8')
  assert.match(md, /Vue 2 迁移债务报告/)
  assert.match(md, /MDI/)
  assert.match(md, /依赖风险/)
})

test('--html 生成自包含 HTML 报告', () => {
  const htmlOut = path.join(TMP, 'report.html')
  const { code } = run([FIXTURE, '--html', htmlOut, '--quiet'])
  assert.equal(code, 0)
  const html = fs.readFileSync(htmlOut, 'utf8')
  assert.match(html, /<!doctype html>/i)
  assert.match(html, /迁移债务指数/)
  assert.match(html, /最重的文件/)
  assert.ok(!/<script/i.test(html), 'HTML 报告应无脚本，方便存档')
})

test('--ci 在 MDI 超标时退出码为 1', () => {
  const { code, out } = run([FIXTURE, '--max-mdi', '1', '--quiet'])
  assert.equal(code, 1)
  assert.match(out, /超出阈值/)
})

test('--ci 在 MDI 未超标时退出码为 0', () => {
  const { code } = run([FIXTURE, '--max-mdi', '99999', '--quiet'])
  assert.equal(code, 0)
})

test('--baseline 输出迁移进度', () => {
  const baseline = path.join(TMP, 'baseline.json')
  run([FIXTURE, '--json', baseline, '--quiet'])

  // 造一份「只剩一半」的现状：扫描干净目录，与基线对比
  const cleanDir = path.join(TMP, 'clean')
  fs.mkdirSync(cleanDir, { recursive: true })
  fs.writeFileSync(path.join(cleanDir, 'ok.vue'), '<template><div /></template>')
  const { code, out } = run([cleanDir, '--baseline', baseline, '--max-mdi', '99999'])
  assert.equal(code, 0)
  assert.match(out, /迁移进度/)
  assert.match(out, /已消除/)
})

test('--label 替换报告里的目标名，避免泄露本机路径', () => {
  const htmlOut = path.join(TMP, 'labeled.html')
  const { code } = run([FIXTURE, '--html', htmlOut, '--label', 'my-app', '--quiet'])
  assert.equal(code, 0)
  const html = fs.readFileSync(htmlOut, 'utf8')
  assert.match(html, /my-app/)
  assert.ok(!html.includes(TMP), '报告里不应出现本机绝对路径')
  assert.ok(!html.includes(FIXTURE), '报告里不应出现本机绝对路径')
})

test('目录不存在时退出码为 2', () => {
  const { code } = run([path.join(TMP, 'definitely-not-here')])
  assert.equal(code, 2)
})

test('--ext 可限定扫描后缀', () => {
  const jsonOut = path.join(TMP, 'onlyvue.json')
  run([FIXTURE, '--ext', '.vue', '--json', jsonOut, '--quiet'])
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'))
  assert.ok(report.findings.every((f) => f.file.endsWith('.vue')), '只应扫 .vue')
})

test('--ignore 可跳过指定目录', () => {
  const jsonOut = path.join(TMP, 'ignored.json')
  run([FIXTURE, '--ignore', 'src', '--json', jsonOut, '--quiet'])
  const report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'))
  assert.equal(report.summary.total, 0, 'src 被忽略后应无命中')
})
