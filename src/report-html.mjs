import { RULES } from './rules.mjs'

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** 按文件聚合命中数，找出「最重的文件」 */
export function topFiles(findings, limit = 15) {
  const map = new Map()
  for (const f of findings) map.set(f.file, (map.get(f.file) ?? 0) + 1)
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file, count]) => ({ file, count }))
}

/**
 * 生成自包含的 HTML 报告（无外链、无脚本，可直接存档或丢进 PR）。
 * @param {{ target: string, summary: any, deps: any[], libCompat: any[], findings: any[], elapsed: number, diff?: any }} data
 */
export function renderHtml(data) {
  const { summary: sum, deps, libCompat = [], findings, elapsed, diff, context, byDir = [], contracts } = data
  const target = data.label || data.target
  const relevant = RULES.filter((r) => sum.byRule[r.id])

  const rows = relevant
    .map(
      (r) => `<tr>
      <td><span class="lv ${r.level}">${r.level}</span></td>
      <td>${esc(r.title)}</td>
      <td class="n">${sum.byRule[r.id]}</td>
      <td class="w">×${r.weight}</td>
      <td class="hint">${esc(r.hint)}</td>
    </tr>`,
    )
    .join('\n')

  const detail = relevant
    .map((r) => {
      const all = findings.filter((f) => f.ruleId === r.id)
      const list = all
        .slice(0, 200)
        .map((f) => `<li><code>${esc(f.file)}:${f.line}</code><span>${esc(f.snippet)}</span></li>`)
        .join('\n')
      const more = all.length > 200 ? `<li class="more">… 另有 ${all.length - 200} 处，见 JSON 报告</li>` : ''
      return `<section><h3>${esc(r.title)} <em>${all.length} 处</em></h3><ul>${list}${more}</ul></section>`
    })
    .join('\n')

  const heavy = topFiles(findings, 15)
  const heavyRows = heavy
    .map(
      (h) =>
        `<tr><td><code>${esc(h.file)}</code></td><td class="n">${h.count}</td><td><span class="bar" style="width:${Math.max(
          4,
          Math.round((h.count / heavy[0].count) * 100),
        )}%"></span></td></tr>`,
    )
    .join('\n')

  const dirRows = byDir
    .slice(0, 15)
    .map(
      (d) =>
        `<tr><td><code>${esc(d.dir)}</code></td><td class="n">${d.count}</td><td class="n">${d.mdi}</td><td class="n">${d.files}</td></tr>`,
    )
    .join('\n')

  const contractBlock = contracts
    ? `<h2>v-model 契约扫描（--contracts，不计入 MDI）</h2>
<table><thead><tr><th>指标</th><th>数量</th><th>说明</th></tr></thead><tbody>
<tr><td>声明 model 选项的组件</td><td class="n">${contracts.modelComponents.length}</td><td>非默认契约（prop/event ≠ value/input）</td></tr>
<tr><td>需改 v-model:propName 的调用点</td><td class="n ${contracts.mismatches.length ? 'bad' : 'good'}">${contracts.mismatches.length}</td><td>确定性关联（相对 import）；组件声明 prop:event，调用方无参 v-model 必改</td></tr>
<tr><td>未能关联的无参 v-model</td><td class="n">${contracts.unresolvedCount}</td><td>别名 import / 全局注册组件，需人工核对</td></tr>
</tbody></table>
${contracts.mismatches.length ? `<section><h3>错配调用点明细 <em>${contracts.mismatches.length} 处</em></h3><ul>${contracts.mismatches
  .slice(0, 100)
  .map(
    (m) =>
      `<li><code>${esc(m.file)}:${m.line}</code><span>&lt;${esc(m.tag)} v-model="${esc(m.expr)}"&gt; → v-model:${esc(m.prop)}（组件 ${esc(m.component)} 声明 prop:${esc(m.prop)}/event:${esc(m.event)}）</span></li>`,
  )
  .join('\n')}</ul></section>`
  : ''}`
    : ''

  const depRows = deps
    .map((d) => `<tr><td><code>${esc(d.name)}</code></td><td>${esc(d.version)}</td><td>${esc(d.tip)}</td></tr>`)
    .join('\n')

  const compatRows = libCompat
    .map((d) => `<tr><td><code>${esc(d.name)}</code></td><td>${esc(d.version)}</td><td>${esc(d.tip)}</td></tr>`)
    .join('\n')

  const diffBlock = diff
    ? `<h2>迁移进度（对比基线）</h2>
<div class="cards">
  <div class="card"><b class="${diff.total.delta <= 0 ? 'good' : 'bad'}">${diff.total.delta > 0 ? '+' : ''}${diff.total.delta}</b><span>遗留写法变化</span></div>
  <div class="card"><b class="${diff.mdi.delta <= 0 ? 'good' : 'bad'}">${diff.mdi.delta > 0 ? '+' : ''}${diff.mdi.delta}</b><span>MDI 变化（${diff.mdi.before} → ${diff.mdi.after}）</span></div>
  <div class="card"><b class="good">${diff.fixedCount}</b><span>已消除</span></div>
  <div class="card"><b class="${diff.addedCount ? 'bad' : ''}">${diff.addedCount}</b><span>新增</span></div>
</div>
<table><thead><tr><th>检测项</th><th>基线</th><th>当前</th><th>变化</th></tr></thead><tbody>
${diff.rules
  .map(
    (r) =>
      `<tr><td>${esc(r.title)}</td><td class="n">${r.before}</td><td class="n">${r.after}</td><td class="n ${
        r.delta <= 0 ? 'good' : 'bad'
      }">${r.delta > 0 ? '+' : ''}${r.delta}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`
    : ''

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vue 2 迁移债务报告 · ${esc(target)}</title>
<style>
 :root{--ink:#1f2430;--muted:#6b7383;--line:#e6e9f0;--bg:#f7f8fc;--good:#1a7f4b;--bad:#c0274a}
 *{box-sizing:border-box}
 body{margin:0;padding:40px 24px;background:var(--bg);color:var(--ink);
   font-family:'PingFang SC','Microsoft YaHei',system-ui,-apple-system,sans-serif;line-height:1.6}
 .wrap{max-width:1000px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}
 h2{font-size:16px;margin:34px 0 12px} h3{font-size:14px;margin:0 0 8px}
 .sub{color:var(--muted);font-size:13px;margin-bottom:8px}
 .sub code{font-size:12px}
 .ctx{background:#fff8e6;border:1px solid #f0dfb2;border-radius:10px;padding:10px 16px;font-size:13px;color:#8a6a00;margin-bottom:20px}
 .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px}
 .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;min-width:150px;flex:1}
 .card b{display:block;font-size:26px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
 .card b.good{color:var(--good)} .card b.bad{color:var(--bad)}
 .card span{color:var(--muted);font-size:12px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
 th,td{padding:11px 14px;border-bottom:1px solid var(--line);font-size:13.5px;text-align:left;vertical-align:top}
 tr:last-child td{border-bottom:none}
 th{background:#fafbff;font-size:12px;color:var(--muted);font-weight:600}
 td.n{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
 td.w,td.hint{color:var(--muted)} td.hint{font-size:12.5px}
 td.n.good{color:var(--good)} td.n.bad{color:var(--bad)}
 .lv{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
 .lv.high{background:#fdecef;color:#c0274a}
 .lv.medium{background:#fff5e6;color:#a86a00}
 .lv.low{background:#eef1f6;color:#5b6472}
 section{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:12px}
 section h3 em{color:var(--muted);font-style:normal;font-weight:400;font-size:12px}
 ul{margin:0;padding:0;list-style:none}
 li{display:flex;gap:10px;padding:5px 0;border-bottom:1px dashed #eef0f5;font-size:12.5px;align-items:baseline}
 li:last-child{border-bottom:none}
 li code{color:#4f5ded;white-space:nowrap;font-size:12px}
 li span{color:var(--muted);font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 li.more{color:var(--muted)}
 .bar{display:block;height:8px;border-radius:4px;background:#c9d3ff}
 footer{color:var(--muted);font-size:12px;margin-top:28px;text-align:center}
 footer a{color:var(--muted)}
</style></head><body><div class="wrap">
<h1>Vue 2 → Vue 3 迁移债务报告</h1>
<div class="sub">目标：<code>${esc(target)}</code>　·　生成于 ${new Date().toLocaleString('zh-CN')}　·　耗时 ${elapsed}ms</div>
${context?.note ? `<div class="ctx">ℹ ${esc(context.note)}</div>` : ''}
<div class="cards">
  <div class="card"><b>${sum.total}</b><span>遗留写法命中</span></div>
  <div class="card"><b>${sum.mdi}</b><span>迁移债务指数 MDI</span></div>
  <div class="card"><b>${sum.band}</b><span>迁移量级 · ${esc(sum.bandNote ?? '')}</span></div>
  <div class="card"><b>${sum.files ?? 0}</b><span>涉及文件</span></div>
  <div class="card"><b>${deps.length}</b><span>依赖风险</span></div>
</div>
${diffBlock}
<h2>按检测项汇总</h2>
<table><thead><tr><th>级别</th><th>检测项</th><th>命中</th><th>权重</th><th>处置建议</th></tr></thead>
<tbody>${rows}</tbody></table>
${heavy.length ? `<h2>最重的文件</h2><table><thead><tr><th>文件</th><th>命中</th><th></th></tr></thead><tbody>${heavyRows}</tbody></table>` : ''}
${dirRows ? `<h2>按目录聚合（Top 15，按 MDI 降序）</h2><table><thead><tr><th>目录</th><th>命中</th><th>MDI</th><th>文件数</th></tr></thead><tbody>${dirRows}</tbody></table>` : ''}
${contractBlock}
${deps.length ? `<h2>依赖风险</h2><table><thead><tr><th>包</th><th>当前版本</th><th>处置</th></tr></thead><tbody>${depRows}</tbody></table>` : ''}
${compatRows ? `<h2>兼容性提醒（能装但要确认）</h2><table><thead><tr><th>包</th><th>当前版本</th><th>说明</th></tr></thead><tbody>${compatRows}</tbody></table>` : ''}
<h2>逐条明细（含行号）</h2>
${detail}
<footer>由 <a href="https://github.com/Jabo2017/vue2-migration-scanner">vue2-migration-scanner</a> 生成</footer>
</div></body></html>`
}

/**
 * 生成 Markdown 报告 —— 适合贴进 PR 描述或周报。
 */
export function renderMarkdown(data) {
  const { summary: sum, deps, libCompat = [], findings, diff, context, byDir = [], contracts } = data
  const target = data.label || data.target
  const relevant = RULES.filter((r) => sum.byRule[r.id])
  const out = []

  out.push(`## Vue 2 迁移债务报告`)
  out.push('')
  out.push(`目标：\`${target}\``)
  out.push('')
  if (context?.note) {
    out.push(`> ℹ ${context.note}`)
    out.push('')
  }
  out.push(`| 指标 | 值 |`)
  out.push(`| --- | --- |`)
  out.push(`| 遗留写法命中 | **${sum.total}** |`)
  out.push(`| 迁移债务指数 MDI | **${sum.mdi}** |`)
  out.push(`| 迁移量级 | ${sum.band}（${sum.bandNote ?? ''}） |`)
  out.push(`| 涉及文件 | ${sum.files ?? 0} |`)
  out.push(`| 依赖风险 | ${deps.length} |`)
  out.push('')

  if (diff) {
    out.push(`### 迁移进度（对比基线）`)
    out.push('')
    out.push(`遗留写法 ${diff.total.before} → ${diff.total.after}（${diff.total.delta > 0 ? '+' : ''}${diff.total.delta}）　·　MDI ${diff.mdi.before} → ${diff.mdi.after}（${diff.mdi.delta > 0 ? '+' : ''}${diff.mdi.delta}）　·　已消除 ${diff.fixedCount} 处，新增 ${diff.addedCount} 处`)
    out.push('')
    out.push(`| 检测项 | 基线 | 当前 | 变化 |`)
    out.push(`| --- | --: | --: | --: |`)
    for (const r of diff.rules) out.push(`| ${r.title} | ${r.before} | ${r.after} | ${r.delta > 0 ? '+' : ''}${r.delta} |`)
    out.push('')
  }

  out.push(`### 按检测项汇总`)
  out.push('')
  out.push(`| 级别 | 检测项 | 命中 | 权重 | 处置建议 |`)
  out.push(`| --- | --- | --: | --: | --- |`)
  for (const r of relevant) out.push(`| ${r.level} | ${r.title} | ${sum.byRule[r.id]} | ×${r.weight} | ${r.hint} |`)
  out.push('')

  if (deps.length) {
    out.push(`### 依赖风险`)
    out.push('')
    out.push(`| 包 | 当前版本 | 处置 |`)
    out.push(`| --- | --- | --- |`)
    for (const d of deps) out.push(`| \`${d.name}\` | ${d.version} | ${d.tip} |`)
    out.push('')
  }

  if (libCompat.length) {
    out.push(`### 兼容性提醒（能装但要确认）`)
    out.push('')
    out.push(`| 包 | 当前版本 | 说明 |`)
    out.push(`| --- | --- | --- |`)
    for (const d of libCompat) out.push(`| \`${d.name}\` | ${d.version} | ${d.tip} |`)
    out.push('')
  }

  const heavy = topFiles(findings, 10)
  if (heavy.length) {
    out.push(`### 最重的文件`)
    out.push('')
    for (const h of heavy) out.push(`- \`${h.file}\` — ${h.count} 处`)
    out.push('')
  }

  if (byDir.length) {
    out.push(`### 按目录聚合（Top 15，按 MDI 降序）`)
    out.push('')
    out.push(`| 目录 | 命中 | MDI | 文件数 |`)
    out.push(`| --- | --: | --: | --: |`)
    for (const d of byDir.slice(0, 15)) out.push(`| \`${d.dir}\` | ${d.count} | ${d.mdi} | ${d.files} |`)
    out.push('')
  }

  if (contracts) {
    out.push(`### v-model 契约扫描（不计入 MDI）`)
    out.push('')
    out.push(`- 声明 model 选项的组件：**${contracts.modelComponents.length}** 个`)
    out.push(
      `- 需改 \`v-model:propName\` 的调用点：**${contracts.mismatches.length}** 处（相对 import 确定性关联）`,
    )
    out.push(`- 未能关联的无参 v-model：${contracts.unresolvedCount} 处（别名 import / 全局注册，需人工核对）`)
    out.push('')
    if (contracts.mismatches.length) {
      out.push(`| 调用点 | 改为 | 组件契约 |`)
      out.push(`| --- | --- | --- |`)
      for (const m of contracts.mismatches.slice(0, 50)) {
        out.push(`| \`${m.file}:${m.line}\` \`<${m.tag}>\` | \`v-model:${m.prop}\` | prop:${m.prop} / event:${m.event} |`)
      }
      out.push('')
    }
  }

  out.push(`<sub>由 [vue2-migration-scanner](https://github.com/Jabo2017/vue2-migration-scanner) 生成</sub>`)
  return out.join('\n')
}
