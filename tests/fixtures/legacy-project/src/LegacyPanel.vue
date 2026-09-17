<template>
  <div class="panel">
    <Child :title.sync="title" />
    <template slot-scope="props">
      <span>{{ props.row.name | upper }}</span>
    </template>
    <slot name="footer" />
  </div>
</template>

<script>
import Bus from './bus'

export default {
  name: 'LegacyPanel',
  mixins: [panelMixin, resizeMixin],
  filters: {
    upper: (s) => String(s).toUpperCase(),
  },
  data() {
    return { title: '', listeners: [] }
  },
  created() {
    Bus.$on('refresh', this.reload)
    this.$on('inner', () => {})
  },
  beforeDestroy() {
    Bus.$off('refresh', this.reload)
    this.$children.forEach((c) => c.$off())
  },
  destroyed() {
    this.listeners = []
  },
  methods: {
    reload() {
      this.title = this.$listeners.change ? 'x' : 'y'
    },
  },
}
</script>
