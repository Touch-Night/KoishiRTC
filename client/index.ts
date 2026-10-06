import type { Context } from '@koishijs/client';
import Console from './console.vue';
export default (ctx: Context) => {
  ctx.page({ path: '/rtc', name: '实时通话', desc: '通话、音频路由与连接诊断', authority: 4, component: Console });
};
