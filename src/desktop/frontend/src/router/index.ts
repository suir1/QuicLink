import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  // Use hash history for Wails desktop compatibility
  history: createWebHashHistory(),
  routes: [
    {
      // Root renders HomeView directly (Lobby if no room param)
      path: '/',
      name: 'root',
      component: HomeView
    },
    {
      // Dynamic room path
      path: '/:roomId',
      name: 'room',
      component: HomeView
    }
  ]
})

export default router

