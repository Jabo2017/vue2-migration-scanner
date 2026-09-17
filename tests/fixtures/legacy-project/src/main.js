import Vue from 'vue'
import App from './App.vue'
import router from './router'

Vue.use(router)
Vue.prototype.$bus = new Vue()
Vue.mixin({ mounted() {} })
Vue.component('GlobalBtn', { template: '<button />' })

new Vue({
  router,
  render: (h) => h(App),
}).$mount('#app')
