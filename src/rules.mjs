/**
 * 检测规则表。
 *
 * 设计原则（很重要，决定了这个工具的可用性）：
 * 1. 只做「能在源码里稳定判定」的检测，不做猜测式 AST 推断 —— 宁可少报，不可误导；
 *    误报会让开发者失去信任，比漏报更致命。
 * 2. 每条命中都带 file:line + 代码片段，方便直接跳过去改；
 * 3. weight 用于汇总「迁移债务指数（MDI）」，权重依据见 README「MDI 怎么算」。
 *
 * @typedef {{ id: string, title: string, level: 'high'|'medium'|'low', weight: number, hint: string, pattern: RegExp }} Rule
 * @typedef {{ ruleId: string, file: string, line: number, column: number, snippet: string }} Finding
 */

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'lifecycle-destroy',
    title: 'beforeDestroy / destroyed 生命周期',
    level: 'high',
    weight: 2,
    hint: 'Vue 3 重命名为 beforeUnmount / unmounted，改名字即可，但要逐一确认清理逻辑',
    pattern: /\b(beforeDestroy|destroyed)\s*(\(|:)/g,
  },
  {
    id: 'sync-modifier',
    title: '.sync 修饰符',
    level: 'high',
    weight: 1,
    hint: 'Vue 3 移除 .sync，改为 v-model:propName；子组件 emit 名从 update:xxx 保持一致',
    pattern: /(?:v-bind:|:)[\w.-]+\.sync\s*=|\.sync\s*=/g,
  },
  {
    id: 'slot-scope',
    title: 'slot-scope / slot="name" 旧插槽语法',
    level: 'high',
    weight: 3,
    hint: 'Vue 3 只认 v-slot；<template slot-scope="x"> 要改成 <template #default="x">',
    pattern: /\bslot-scope\s*=|\bslot\s*=\s*["']/g,
  },
  {
    id: 'filters',
    title: 'filters 过滤器',
    level: 'high',
    weight: 2,
    hint: 'Vue 3 移除 filters 选项，改成 computed 或纯函数调用（模板里写 {{ fmt(x) }}）',
    pattern: /\bfilters\s*:\s*\{|(\{\{[^}]*\|[^}]*\}\})/g,
  },
  {
    id: 'global-api',
    title: 'Vue 全局 API（prototype / use / set ...）',
    level: 'high',
    weight: 3,
    hint: 'Vue 3 改为 app.use / app.config.globalProperties；Vue.set|delete 直接删除（响应式系统已覆盖）',
    pattern: /\bVue\s*\.\s*(prototype|use|mixin|component|directive|filter|extend|set|delete|observable)\b|\bnew\s+Vue\s*\(/g,
  },
  {
    id: 'events-api',
    title: '$on / $off / $once / $listeners / $children',
    level: 'high',
    weight: 3,
    hint: 'Vue 3 移除实例事件 API 与 $listeners/$children；EventBus 改用 mitt，父子通信改用 props/emit',
    pattern: /\$on\s*\(|\$off\s*\(|\$once\s*\(|\$listeners\b|\$children\b/g,
  },
  {
    id: 'functional-option',
    title: 'functional: true 函数式组件',
    level: 'medium',
    weight: 2,
    hint: '改成普通函数组件（props/emits 显式声明），Vue 3 中函数式组件是纯函数',
    pattern: /\bfunctional\s*:\s*true/g,
  },
  {
    id: 'webpack-coupling',
    title: 'Webpack / vue-cli 强耦合写法',
    level: 'medium',
    weight: 1,
    hint: 'Rspack 兼容大部分 loader 链，但 require.context 的写法、chainWebpack 配置要重写',
    pattern: /\brequire\.context\s*\(|process\.env\.VUE_APP_|chainWebpack\s*\(|configureWebpack\s*\(|vue-cli-service/g,
  },
  {
    id: 'mixins',
    title: 'mixins 引用',
    level: 'medium',
    weight: 1.5,
    hint: 'mixins 在 Vue 3 仍可用但同样导致数据来源不透明；建议迁移期换成组合式函数（composables）',
    pattern: /\bmixins\s*:\s*\[/g,
  },
  {
    id: 'event-bus',
    title: 'EventBus 模式（$emit 到全局实例）',
    level: 'medium',
    weight: 2,
    hint: 'Vue 3 无全局事件实例，改用 mitt / 或提到状态层（Pinia）',
    pattern: /new\s+Vue\s*\(\s*\)|\.\s*\$emit\s*\(\s*['"]\$?bus|bus\s*\.\s*\$emit/g,
  },
]

/**
 * 迁移期版本兜底表：命中不是"必须删"，而是"要按官方迁移指引确认行为差异"。
 * 这些包在 Vue 3 里仍能装，但封装的是 Vue 2 的实例/事件模型，容易出现「升级后某功能静默失效」。
 */
export const LIB_COMPAT = [
  { test: /^vuex$/, tip: 'Vuex 3 —— Vue 3 里能跑但官方推荐 Pinia；this.$store 在 setup 中不可用' },
  { test: /^(element-ui|mint-ui|vant|iview|view-design|vux)$/, tip: 'Vue 2 生态 UI 库 —— 需换 element-plus / vant 4 / view-ui-plus' },
  { test: /^vue-awesome-swiper$/, tip: '封装 Vue 2 的 swiper —— 换 swiper 官方 Vue 组件' },
  { test: /^vue-i18n$/, version: /^[\^~]?[678]\./, tip: 'vue-i18n 8 及以下 —— v9+ 改为 createI18n()，且去掉了 this.$t 之外的部分 API' },
  { test: /^vuedraggable$/, tip: 'vuedraggable 2 —— Vue 3 需换 vuedraggable@next 或 vue-draggable-plus' },
  { test: /^bootstrap-vue$/, tip: 'bootstrap-vue —— 仅支持 Vue 2，Vue 3 无官方版本' },
]

/** package.json 依赖里需要重点关注的包（Vue 2 主体 / 已停止维护 / 大版本破坏性变更） */
export const DEP_RISKS = [
  { test: /^vue$/, version: /^[\^~]?2\./, tip: 'Vue 2 —— 迁移主体，升到 3.x' },
  { test: /^vue-router$/, version: /^[\^~]?[23]\./, tip: 'Vue Router 2/3 —— 升到 4/5，API 从 new Router() 改为 createRouter()' },
  { test: /^vuex$/, version: /.*/, tip: 'Vuex 3 —— 官方推荐迁移到 Pinia' },
  { test: /^(element-ui|mint-ui|vant)$/, version: /.*/, tip: 'Vue 2 生态 UI 库 —— 需换 element-plus / vant 4' },
  { test: /^@vue\/cli-service$/, version: /.*/, tip: 'vue-cli —— 换 Rspack/Vite 构建' },
  { test: /^(webpack|webpack-dev-server)$/, version: /.*/, tip: 'Webpack —— 可换 Rspack，配置基本平移' },
  { test: /^node-sass$/, version: /.*/, tip: 'node-sass 已废弃 —— 换 sass（dart-sass）' },
  { test: /^moment$/, version: /.*/, tip: 'moment 停止维护且体积大 —— 换 dayjs' },
  { test: /^echarts$/, version: /^[\^~]?[0-4]\./, tip: 'echarts 4 及以下 —— 5.x API 有破坏性变更' },
  { test: /^swiper$/, version: /^[\^~]?[0-5]\./, tip: 'swiper 5 及以下 —— 6+ 组件名与 API 变更较大' },
  { test: /^lodash$/, version: /.*/, tip: 'lodash 全量引入 —— 换 lodash-es 按需引入' },
  { test: /^vue-awesome-swiper$/, version: /.*/, tip: 'Vue 2 封装的老 swiper —— 换 swiper 官方 Vue 组件' },
]

/** MDI 分档：用于粗粒度排期，不作为精确工期估算 */
export const MDI_BANDS = [
  { max: 50, label: '低', note: '写法基本干净，主要是依赖升级' },
  { max: 200, label: '中', note: '需要逐文件过一遍，可流水线推进' },
  { max: 600, label: '高', note: '建议先立规范再动，避免边改边新增' },
  { max: Infinity, label: '极高', note: '建议按模块分批，先冻结新增遗留写法' },
]
