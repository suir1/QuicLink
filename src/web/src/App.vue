<script setup lang="ts">
import { RouterView } from 'vue-router';
</script>

<template>
  <RouterView />
</template>

<style>
/* Global styles can go here if needed */
body {
  margin: 0;
  font-family: 'Helvetica Neue', Helvetica, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
  background-color: #f5f7fa;
  color: var(--el-text-color-primary);
  transition: background-color 0.3s, color 0.3s;
}

html.dark body {
  background-color: var(--el-bg-color-page); /* Use page-level bg variable */
}
</style>
