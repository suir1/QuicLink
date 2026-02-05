import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
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
