import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      // 1. 根路径：如果没有房间号，跳转到一个随机房间或默认房间
      path: '/',
      redirect: () => {
        // 生成一个随机 6 位房间号 (可选)，这里暂时默认跳到 public
        return '/public'
      }
    },
    {
      // 2. 动态路径：捕获房间号
      path: '/:roomId',
      name: 'room',
      component: HomeView
    }
  ]
})

export default router
