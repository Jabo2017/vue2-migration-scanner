<script setup>
import { ref, onUnmounted } from 'vue'

const rows = ref([])
onUnmounted(() => {
  rows.value = []
})
</script>

<template>
  <Child v-model:title="title" />
  <template #default="{ row }">
    <span>{{ row.name }}</span>
  </template>
</template>
