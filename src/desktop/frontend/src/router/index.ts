import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  // Use hash history for Wails desktop compatibility
  history: createWebHashHistory(),
  routes: [
    {
      // Root redirects to default room
      path: '/',
      redirect: '/public'
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

