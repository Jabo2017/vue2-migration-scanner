import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanText, summarize, checkDeps, checkLibCompat, bandFor, diffReports, groupDirs, detectContext } from '../src/scan.mjs'
import { RULES } from '../src/rules.mjs'

test('scanText 精确报出行号', () => {
  const code = ['export default {', '  name: "X",', '  beforeDestroy() {', '    this.$off()', '  },', '}'].join('\n')
  const found = scanText(code, 'a.vue')
  const lifecycle = found.filter((f) => f.ruleId === 'lifecycle-destroy')
  const events = found.filter((f) => f.ruleId === 'events-api')
  assert.equal(lifecycle.length, 1)
  assert.equal(lifecycle[0].line, 3)
  assert.equal(events.length, 1)
  assert.equal(events[0].line, 4)
  assert.equal(lifecycle[0].file, 'a.vue')
})

test('scanText 命中 .sync 修饰符', () => {
  const found = scanText('<Child :title.sync="t" />', 'C.vue')
  assert.equal(found.filter((f) => f.ruleId === 'sync-modifier').length, 1)
})

test('scanText 命中旧插槽语法但不误报 v-slot', () => {
  const old = scanText('<template slot-scope="p">{{ p.x }}</template>', 'a.vue')
  assert.equal(old.filter((f) => f.ruleId === 'slot-scope').length, 1)

  const modern = scanText('<template #default="p">{{ p.x }}</template>', 'b.vue')
  assert.equal(modern.filter((f) => f.ruleId === 'slot-scope').length, 0)
})

test('scanText 命中 filters 与全局 API', () => {
  const code = 'Vue.prototype.$http = axios\nnew Vue({ filters: { cap: (s) => s } })'
  const found = scanText(code, 'main.js')
  assert.ok(found.some((f) => f.ruleId === 'global-api'))
  assert.ok(found.some((f) => f.ruleId === 'filters'))
})

test('filters 规则不把插值里的 || 误报成管道过滤器', () => {
  // 实战教训：早期版本曾把 150+ 处 `{{ a || b }}` 算成 filters，误报率 76%
  const orExpr = scanText("<span>{{ text || '默认值' }}</span>", 'a.vue')
  assert.equal(orExpr.filter((f) => f.ruleId === 'filters').length, 0)

  const pipe = scanText('<span>{{ price | toFixed(2) }}</span>', 'a.vue')
  assert.equal(pipe.filter((f) => f.ruleId === 'filters').length, 1)

  const mixed = scanText('{{ a | b || c }}', 'a.vue') // 罕见混合写法，含真管道，报出来是对的
  assert.equal(mixed.filter((f) => f.ruleId === 'filters').length, 1)
})

test('scanText 命中 .native 修饰符两种写法', () => {
  const at = scanText('<Comp @click.native="fn" />', 'a.vue')
  assert.equal(at.filter((f) => f.ruleId === 'native-modifier').length, 1)
  const von = scanText('<Comp v-on:click.native="fn" />', 'b.vue')
  assert.equal(von.filter((f) => f.ruleId === 'native-modifier').length, 1)
})

test('scanText 命中 $scopedSlots', () => {
  const found = scanText('const x = this.$scopedSlots.default', 'a.vue')
  assert.equal(found.filter((f) => f.ruleId === 'scoped-slots').length, 1)
})

test('scanText 命中 $set / $delete 实例 API', () => {
  const found = scanText('this.$set(obj, "k", 1)\nthis.$delete(obj, "k")', 'a.vue')
  const ids = found.filter((f) => f.ruleId === 'instance-set')
  assert.equal(ids.length, 2)
  assert.equal(ids[0].line, 1)
  assert.equal(ids[1].line, 2)
})

test('scanText 命中组件 model 选项但不误报相邻单词', () => {
  const hit = scanText('export default {\n  model: {\n    prop: "value",\n    event: "change"\n  }\n}', 'Comp.vue')
  assert.equal(hit.filter((f) => f.ruleId === 'model-option').length, 1)

  // 带前缀的键（如 dataModel: {）不应命中 —— \b 边界检查
  // 说明：行首缩进的 `model: {` 普通对象键与组件选项在正则层面无法区分，属可接受多报，
  // 以 file:line 逐条核对为准（与 README「局限」一节口径一致）
  const prefix = scanText('const dataModel = { a: 1 }', 'x.js')
  assert.equal(prefix.filter((f) => f.ruleId === 'model-option').length, 0)
})

test('scanText 命中 render(h) 与 staticRenderFns', () => {
  const code = 'export default {\n  render(h) { return h("div") },\n  staticRenderFns: []\n}'
  const found = scanText(code, 'Comp.vue')
  assert.equal(found.filter((f) => f.ruleId === 'render-h').length, 2)
})

test('deep-selector 只在样式类文件里命中，JS 的 >>> 位运算不报', () => {
  const vue = scanText('<style>.a >>> .b { color: red }</style>', 'a.vue')
  assert.equal(vue.filter((f) => f.ruleId === 'deep-selector').length, 1)

  const scss = scanText('.a ::v-deep .b { color: red }', 'a.scss')
  assert.equal(scss.filter((f) => f.ruleId === 'deep-selector').length, 1)

  const jsShift = scanText('const h = (n >>> 0).toString(16)', 'hash.js')
  assert.equal(jsShift.filter((f) => f.ruleId === 'deep-selector').length, 0)
})

test('scanText 命中 :attr="false" 绑定', () => {
  const found = scanText('<Comp :disabled="false" />', 'a.vue')
  assert.equal(found.filter((f) => f.ruleId === 'attr-false').length, 1)
})

test('scanText 忽略 Vue 3 的 createApp 写法', () => {
  const code = "import { createApp } from 'vue'\ncreateApp(App).use(router).mount('#app')"
  const found = scanText(code, 'main.js')
  assert.equal(found.filter((f) => f.ruleId === 'global-api').length, 0)
})

test('scanText 结果按行列排序', () => {
  const code = 'a\nbeforeDestroy() {}\n.sync=1'
  const found = scanText(code, 'x.js')
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i].line >= found[i - 1].line, '按行升序')
  }
})

test('scanText 不会因零宽匹配死循环', () => {
  const found = scanText('<\/script>'.repeat(3), 'x.js')
  assert.ok(found.length >= 0)
})

test('summarize 计算 MDI 与分档', () => {
  const code = 'beforeDestroy() {}\nbeforeDestroy() {}\nVue.prototype.a = 1'
  const sum = summarize(scanText(code, 'x.js'))
  // 2 处 lifecycle(权重2) + 1 处 global-api(权重3) = 7
  assert.equal(sum.byRule['lifecycle-destroy'], 2)
  assert.equal(sum.mdi, 7)
  assert.equal(sum.band, '低')
  assert.equal(sum.files, 1)
  assert.equal(sum.total, 3)
})

test('summarize 统计涉及文件数', () => {
  const sum = summarize([...scanText('beforeDestroy(){}', 'a.js'), ...scanText('beforeDestroy(){}', 'b.js')])
  assert.equal(sum.files, 2)
  assert.equal(sum.total, 2)
})

test('bandFor 分档边界', () => {
  assert.equal(bandFor(0).label, '低')
  assert.equal(bandFor(49.9).label, '低')
  assert.equal(bandFor(50).label, '中')
  assert.equal(bandFor(200).label, '高')
  assert.equal(bandFor(600).label, '极高')
})

test('checkDeps 命中 Vue 2 相关依赖', () => {
  const hits = checkDeps({
    dependencies: { vue: '^2.6.14', 'vue-router': '^3.5.1', vuex: '^3.6.2', 'element-ui': '^2.15.6' },
    devDependencies: { '@vue/cli-service': '^4.5.0' },
  })
  const names = hits.map((h) => h.name).sort()
  assert.deepEqual(names, ['@vue/cli-service', 'element-ui', 'vue', 'vue-router', 'vuex'])
})

test('checkDeps 不会把 Vue 3 误判为风险', () => {
  const hits = checkDeps({ dependencies: { vue: '^3.5.0', 'vue-router': '^4.4.0' } })
  assert.equal(hits.length, 0)
})

test('checkLibCompat 提示能装但要确认的包', () => {
  const hits = checkLibCompat({ dependencies: { vuex: '^3.6.2', 'vue-i18n': '^8.27.0', vuedraggable: '^2.24.3' } })
  const names = hits.map((h) => h.name).sort()
  assert.deepEqual(names, ['vue-i18n', 'vuedraggable', 'vuex'])
})

test('checkLibCompat 对 vue-i18n 9+ 不报', () => {
  const hits = checkLibCompat({ dependencies: { 'vue-i18n': '^9.14.0' } })
  assert.equal(hits.length, 0)
})

test('diffReports 得出已消除与新增', () => {
  const baseline = {
    scannedAt: '2026-01-01T00:00:00.000Z',
    summary: { total: 3, mdi: 6, byRule: { 'lifecycle-destroy': 3 } },
    findings: [
      { ruleId: 'lifecycle-destroy', file: 'a.vue', line: 1 },
      { ruleId: 'lifecycle-destroy', file: 'a.vue', line: 5 },
      { ruleId: 'lifecycle-destroy', file: 'b.vue', line: 9 },
    ],
  }
  const current = {
    scannedAt: '2026-02-01T00:00:00.000Z',
    summary: { total: 2, mdi: 4, byRule: { 'lifecycle-destroy': 2 } },
    findings: [
      { ruleId: 'lifecycle-destroy', file: 'a.vue', line: 1 },
      { ruleId: 'lifecycle-destroy', file: 'b.vue', line: 9 },
    ],
  }
  const d = diffReports(baseline, current)
  assert.equal(d.total.delta, -1)
  assert.equal(d.mdi.delta, -2)
  assert.equal(d.fixedCount, 1)
  assert.equal(d.addedCount, 0)
  assert.equal(d.rules[0].before, 3)
  assert.equal(d.rules[0].after, 2)
})

test('diffReports 容忍缺少字段的基线', () => {
  const d = diffReports({}, { summary: { total: 1, mdi: 2, byRule: { 'sync-modifier': 1 } }, findings: [] })
  assert.equal(d.mdi.before, 0)
  assert.equal(d.mdi.after, 2)
  assert.equal(d.addedCount, 0)
})

test('groupDirs 按目录聚合且 MDI 降序', () => {
  const findings = [
    ...scanText('beforeDestroy(){}\nbeforeDestroy(){}', 'src/views/heavy/List.vue'), // MDI 4
    ...scanText('.sync=1', 'src/views/heavy/Item.vue'), // MDI 1
    ...scanText('mixins: []', 'src/utils/x.js'), // MDI 1.5
  ]
  const dirs = groupDirs(findings)
  assert.equal(dirs[0].dir, 'src/views/heavy')
  assert.equal(dirs[0].count, 3)
  assert.equal(dirs[0].mdi, 5)
  assert.equal(dirs[0].files, 2)
  assert.equal(dirs[1].dir, 'src/utils')
})

test('detectContext 依据 package.json 事实切换报告口径', () => {
  const vue2 = detectContext({ dependencies: { vue: '^2.7.16' } })
  assert.equal(vue2.mode, 'vue2')
  assert.equal(vue2.note, null)

  const compat = detectContext({ dependencies: { vue: '^3.5.42', '@vue/compat': '^3.5.42' } })
  assert.equal(compat.mode, 'vue3-compat')
  assert.ok(compat.note.includes('@vue/compat'))

  const vue3 = detectContext({ dependencies: { vue: '^3.5.42' } })
  assert.equal(vue3.mode, 'vue3')

  const none = detectContext({})
  assert.equal(none.vueMajor, null)
  assert.equal(none.mode, 'unknown')
})

test('每条规则的 pattern 都带 g 标志且能重置 lastIndex', () => {
  for (const rule of RULES) {
    assert.ok(rule.pattern.global, `${rule.id} 应带 g 标志`)
    rule.pattern.lastIndex = 0
    assert.equal(rule.pattern.lastIndex, 0)
  }
})

test('规则 id 唯一', () => {
  const ids = RULES.map((r) => r.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('规则权重都是正数', () => {
  for (const r of RULES) assert.ok(r.weight > 0, `${r.id} 权重应大于 0`)
})

test('scanText 在 Vue 3 代码上保持干净', () => {
  const code = `
<script setup>
import { ref, onUnmounted } from 'vue'
const n = ref(0)
onUnmounted(() => { n.value = 0 })
<\/script>
<template>
  <Child v-model:title="t" />
  <template #default="{ row }">{{ row.name }}</template>
</template>`
  const found = scanText(code, 'Clean.vue')
  assert.equal(found.length, 0, `不应命中任何规则，实际：${JSON.stringify(found)}`)
})
