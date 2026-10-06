import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
await build({root:process.cwd(),plugins:[vue()],build:{outDir:'dist/client',emptyOutDir:true,lib:{entry:'client/index.ts',name:'KoishiRTC',formats:['es'],cssFileName:'style',fileName:()=> 'index.js'},rollupOptions:{external:['vue','@koishijs/client']}}});
