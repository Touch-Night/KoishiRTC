import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const config=JSON.parse(await fs.readFile(new URL('../runtime/console/config.json',import.meta.url),'utf8'));
const browser=await puppeteer.launch({executablePath:'/snap/bin/chromium',headless:true,userDataDir:new URL('../runtime/console/test-browser',import.meta.url).pathname,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
  const context=await browser.createBrowserContext();const page=await context.newPage();page.on('pageerror',e=>console.log('PAGE ERROR',e.message));
  page.on('requestfailed',r=>console.log('FAILED',r.url(),r.failure()?.errorText));page.on('response',r=>{if(r.status()>=400)console.log('HTTP',r.status(),r.url())});
  await page.goto(`http://127.0.0.1:${config.port}/console/login`,{waitUntil:'networkidle0'});
  await page.type('input[placeholder="用户名"]',config.username);await page.type('input[placeholder="密码"]',config.password);await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.body.innerText.includes('用户资料'),{timeout:10000});
  await page.waitForSelector('a[href="/console/rtc"]');await page.click('a[href="/console/rtc"]');await page.waitForFunction(()=>document.body.innerText.includes('让对话接通'));await page.waitForFunction(()=>!document.body.innerText.includes('unauthorized'));
  for(const width of [1280,390]){await page.setViewport({width,height:900});await page.screenshot({path:`runtime/console/rtc-${width}.png`,fullPage:true});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow)throw new Error(`UI overflows at ${width}`);}
  console.log(await page.evaluate(()=>({title:document.title,text:document.body.innerText.slice(0,4000),inputs:[...document.querySelectorAll('input')].map(i=>({type:i.type,placeholder:i.placeholder}))})));
}finally{await browser.close();}
