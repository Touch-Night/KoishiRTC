// Isolated development Koishi; never edits or restarts an existing installation.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { App } = require('koishi');
const use = name => { const p=require(name); return p.default||p; };
const root=path.resolve(__dirname,'..');
const runtime=path.join(root,'runtime','console');fs.mkdirSync(runtime,{recursive:true,mode:0o700});
const configFile=path.join(runtime,'config.json');
if(!fs.existsSync(configFile))fs.writeFileSync(configFile,JSON.stringify({username:'rtc-admin',password:randomBytes(18).toString('base64url'),port:6129,plugin:{bridges:[],discord:[],historyLimit:100}},null,2),{mode:0o600});
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
// Put console assets beneath an actual node_modules path, as Koishi's asset guard expects.
const packageDir=path.join(runtime,'node_modules','koishi-plugin-rtc-bridge');fs.mkdirSync(packageDir,{recursive:true});fs.cpSync(path.join(root,'dist'),path.join(packageDir,'dist'),{recursive:true});
const ctx=new App({});ctx.baseDir=runtime;
ctx.plugin(use('@koishijs/plugin-server'),{host:'127.0.0.1',port:config.port});
ctx.plugin(use('@koishijs/plugin-database-sqlite'),{path:path.join(runtime,'state.db')});
ctx.plugin(use('@koishijs/plugin-console'),{uiPath:'/console',open:false});
ctx.plugin(use('@koishijs/plugin-auth'),{admin:{enabled:true,username:config.username,password:config.password}});
ctx.plugin(require(path.join(packageDir,'dist','index.cjs')) ,config.plugin);
ctx.start().then(()=>console.log(`Isolated RTC console: http://127.0.0.1:${config.port}/console/rtc\nLogin settings: ${configFile}`)).catch(e=>{console.error(e);process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>ctx.stop().finally(()=>process.exit(0)));
