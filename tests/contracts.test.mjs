import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanContracts, extractModelOption, extractBareVModelUsages, extractImports } from '../src/contracts.mjs'

test('extractModelOption 提取非默认契约，默认契约返回 null', () => {
  const custom = extractModelOption('export default {\n  model: {\n    prop: "checked",\n    event: "change"\n  }\n}')
  assert.deepEqual(custom, { prop: 'checked', event: 'change' })

  const def = extractModelOption('export default {\n  model: {\n    prop: "value",\n    event: "input"\n  }\n}')
  assert.equal(def, null, '显式声明 value/input 与默认一致，改造点在组件自身')

  assert.equal(extractModelOption('export default { props: ["a"] }'), null)
})

test('extractBareVModelUsages 只收组件标签上的无参 v-model', () => {
  const usages = extractBareVModelUsages(
    '<input v-model="a">\n<select v-model="b"></select>\n<textarea v-model="c"/>\n<SortType v-model="d" />',
    'x.vue',
  )
  assert.equal(usages.length, 1)
  assert.equal(usages[0].tag, 'SortType')
  assert.equal(usages[0].expr, 'd')
  assert.equal(usages[0].line, 4)
})

test('extractBareVModelUsages 不把带参 v-model 算进来', () => {
  const usages = extractBareVModelUsages('<Comp v-model:title="t" /><Comp v-model.foo="x" />', 'x.vue')
  assert.equal(usages.length, 0)
})

test('extractImports 支持 default / 具名 as / require', () => {
  const im = extractImports(
    "import SortType from './a'\nimport Base, { helper as h } from './b'\nconst legacy = require('./c')",
  )
  assert.deepEqual(
    im.map((x) => `${x.local}:${x.source}`).sort(),
    ['Base:./b', 'SortType:./a', 'h:./b', 'legacy:./c'],
  )
})

test('scanContracts 关联相对 import 的错配调用点（含 kebab 标签名）', () => {
  const entries = [
    {
      file: 'src/components/SortType.vue',
      code: 'export default {\n  model: {\n    prop: "current",\n    event: "change"\n  }\n}',
    },
    {
      file: 'src/views/List.vue',
      code: "import SortType from '../components/SortType.vue'\n<template><sort-type v-model=\"cur\" /></template>",
    },
  ]
  const r = scanContracts(entries)
  assert.equal(r.modelComponents.length, 1)
  assert.equal(r.mismatches.length, 1)
  assert.equal(r.mismatches[0].file, 'src/views/List.vue')
  assert.equal(r.mismatches[0].prop, 'current')
  assert.equal(r.mismatches[0].event, 'change')
  assert.equal(r.mismatches[0].component, 'src/components/SortType.vue')
  assert.equal(r.unresolvedCount, 0)
})

test('scanContracts 别名 import 不猜测，进 unresolved 而非误报', () => {
  const entries = [
    { file: 'src/components/SortType.vue', code: 'model: { prop: "current", event: "change" }' },
    {
      file: 'src/views/List.vue',
      code: "import SortType from '@/components/SortType'\n<template><SortType v-model=\"cur\" /></template>",
    },
  ]
  const r = scanContracts(entries)
  assert.equal(r.mismatches.length, 0, '别名映射需要构建配置才能确定，不猜')
  assert.equal(r.unresolvedCount, 1)
})

test('scanContracts 目标组件无 model 选项不算错配', () => {
  const entries = [
    { file: 'src/components/Plain.vue', code: 'export default { props: ["value"] }' },
    {
      file: 'src/views/List.vue',
      code: "import Plain from '../components/Plain.vue'\n<template><Plain v-model=\"v\" /></template>",
    },
  ]
  const r = scanContracts(entries)
  assert.equal(r.mismatches.length, 0)
  assert.equal(r.unresolvedCount, 0)
})

test('scanContracts 原生标签与带参 v-model 都不进任何清单', () => {
  const entries = [
    {
      file: 'src/components/SortType.vue',
      code: 'model: { prop: "current", event: "change" }',
    },
    { file: 'src/views/Form.vue', code: '<template><input v-model="a"><SortType v-model:title="t" /></template>' },
  ]
  const r = scanContracts(entries)
  assert.equal(r.mismatches.length, 0)
  assert.equal(r.unresolvedCount, 0)
})
