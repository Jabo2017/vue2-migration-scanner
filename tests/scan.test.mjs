import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanText, summarize, checkDeps, checkLibCompat, bandFor, diffReports } from '../src/scan.mjs'
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
