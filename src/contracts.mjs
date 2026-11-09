/**
 * v-model 契约扫描（--contracts）：跨文件关联「声明 model 选项的组件」与「无参 v-model 调用方」。
 *
 * 与 rules.mjs 的分工（这决定了它是否符合本工具「稳定判定、不做猜测式推断」的原则）：
 * - rules.mjs 是单文件正则命中；本模块是跨文件「确定性关联」—— 只走相对路径 import 的
 *   ESM 语义解析，import 指向哪个文件就是哪个文件，零猜测；
 * - 解析不了的（别名 import、全局注册组件）进 unresolved 清单：那是「信息」，不是「命中」，
 *   宁可少报，不可误导；
 * - 关联出的 mismatch 是命中，但【不计入 MDI】—— MDI 保持单文件口径，--baseline 对比不被污染。
 *
 * 背景（真实项目迁移实战中反复出现的一类静默 bug）：组件用 model 选项声明了非默认 prop/event 契约时，
 * 调用方的无参 v-model 在 Vue 3 必须改成 v-model:propName，否则静默绑错 prop。
 * 这类问题单文件 grep 永远查不出来，只能跨文件关联 —— 这也是本模块存在的唯一理由。
 */
import path from 'node:path'

/** 原生标签上的 v-model 在 Vue 2/3 语义都由编译器处理，不算组件契约 */
const NATIVE_VMODEL_TAGS = new Set(['input', 'select', 'textarea'])

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const norm = (p) => p.replace(/\\/g, '/')

/**
 * 提取组件 model 选项契约。
 * prop/event 缺省为 value/input；显式声明且与默认一致时返回 null
 * （与 Vue 3 的 modelValue 契约不冲突的改造点在组件自身，不在调用方）。
 * @param {string} code
 * @returns {{ prop: string, event: string } | null}
 */
export function extractModelOption(code) {
  const re = /^[ \t]*model\s*:\s*\{([^}]*)\}/gm
  let m
  while ((m = re.exec(code)) !== null) {
    const body = m[1]
    const prop = /prop\s*:\s*['"]?([\w-]+)/.exec(body)?.[1] ?? 'value'
    const event = /event\s*:\s*['"]?([\w-]+)/.exec(body)?.[1] ?? 'input'
    if (prop === 'value' && event === 'input') return null
    return { prop, event }
  }
  return null
}

/**
 * 收集「无参 v-model 用在组件标签上」的调用点。
 * v-model:title（带参数）、原生标签上的 v-model 都不算。
 * 已知多报来源：模板注释里的标签、源码字符串里的模板片段 —— 带 file:line，逐条核对即可。
 * @param {string} code
 * @param {string} file
 */
export function extractBareVModelUsages(code, file) {
  const usages = []
  // 标签开区：<Tag attrs...>，属性区允许带引号的值（引号里可以出现 >），跨行亦可
  const tagRe = /<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/g
  let m
  while ((m = tagRe.exec(code)) !== null) {
    const tag = m[1]
    if (NATIVE_VMODEL_TAGS.has(tag.toLowerCase())) continue
    const vm = /\bv-model(?![\w:.])\s*=\s*(["'])(.*?)\1/.exec(m[2])
    if (!vm) continue
    const line = code.slice(0, m.index).split('\n').length
    usages.push({ file: norm(file), line, tag, expr: vm[2] })
  }
  return usages
}

/**
 * 提取一个文件的 import / require 绑定：[{ local, source }]
 * @param {string} code
 */
export function extractImports(code) {
  /** @type {{ local: string, source: string }[]} */
  const out = []
  const patterns = [
    // import X from 'p'  /  import X, { A as B } from 'p'
    /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g,
    // import { A, B as C } from 'p'
    /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    // const X = require('p')
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) {
      if (re === patterns[1]) {
        for (const seg of m[1].split(',')) {
          const local = /as\s+([A-Za-z_$][\w$]*)/.exec(seg)?.[1] ?? seg.trim()
          if (local) out.push({ local, source: m[2] })
        }
      } else if (re === patterns[2]) {
        out.push({ local: m[1], source: m[2] })
      } else {
        out.push({ local: m[1], source: m[3] })
        if (m[2]) {
          for (const seg of m[2].split(',')) {
            const local = /as\s+([A-Za-z_$][\w$]*)/.exec(seg)?.[1] ?? seg.trim()
            if (local) out.push({ local, source: m[3] })
          }
        }
      }
    }
  }
  return out
}

/** 相对路径 import 解析到已扫描文件集合内的具体文件；解析不到返回 null（不猜） */
function resolveRelative(importerFile, source, fileSet) {
  if (!source.startsWith('.')) return null
  const base = path.posix.dirname(norm(importerFile))
  const joined = path.posix.normalize(path.posix.join(base, source))
  const exts = ['', '.vue', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']
  for (const stem of [joined, joined + '/index']) {
    for (const e of exts) {
      if (fileSet.has(stem + e)) return stem + e
    }
  }
  return null
}

/**
 * v-model 契约扫描主入口。
 * @param {{ file: string, code: string }[]} entries file 为相对根目录的路径
 * @returns {{
 *   modelComponents: { file: string, prop: string, event: string }[],
 *   mismatches: { file: string, line: number, tag: string, expr: string, component: string, prop: string, event: string }[],
 *   unresolvedCount: number,
 *   unresolved: { file: string, line: number, tag: string }[],
 * }}
 */
export function scanContracts(entries) {
  const fileSet = new Set(entries.map((e) => norm(e.file)))

  // 1. 登记 model 选项组件
  /** @type {Map<string, { prop: string, event: string }>} */
  const modelByFile = new Map()
  const modelComponents = []
  for (const e of entries) {
    const contract = extractModelOption(e.code)
    if (contract) {
      modelByFile.set(norm(e.file), contract)
      modelComponents.push({ file: norm(e.file), ...contract })
    }
  }

  // 2. 收集无参 v-model 调用点 + 每个文件的 import 表
  /** @type {Map<string, { local: string, source: string }[]>} */
  const importsByFile = new Map()
  const usages = []
  for (const e of entries) {
    importsByFile.set(norm(e.file), extractImports(e.code))
    usages.push(...extractBareVModelUsages(e.code, norm(e.file)))
  }

  // 3. 关联：import 绑定名 == 标签名（kebab 归一），且目标文件声明了非默认 model 契约
  const mismatches = []
  const unresolved = []
  const seen = new Set()
  for (const u of usages) {
    const matched = (importsByFile.get(u.file) || []).find((im) => kebab(im.local) === kebab(u.tag))
    if (!matched) {
      unresolved.push(u) // 全局注册 / el-* 等库组件 —— 解析不了，进信息清单
      continue
    }
    if (!matched.source.startsWith('.')) {
      unresolved.push(u) // 别名 import（@/...、@xgj/...）—— 工具不读构建配置，不猜映射
      continue
    }
    const resolved = resolveRelative(u.file, matched.source, fileSet)
    if (!resolved) {
      unresolved.push(u) // 相对 import 指向未扫描的文件（被 ignore 的目录等）
      continue
    }
    const contract = modelByFile.get(resolved)
    if (!contract) continue // 目标组件契约与默认一致，改造点在组件自身，不在调用方
    const key = `${u.file}:${u.line}`
    if (seen.has(key)) continue
    seen.add(key)
    mismatches.push({ ...u, component: resolved, ...contract })
  }

  return { modelComponents, mismatches, unresolvedCount: unresolved.length, unresolved: unresolved.slice(0, 100) }
}
