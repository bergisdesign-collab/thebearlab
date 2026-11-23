// Автотест флоу прототипа — гард "без багов". Проходит весь путь и проверяет результаты.
// Запуск: node flow-test.mjs  (нужен локальный http-сервер на порту из URL и playwright)
import { chromium } from 'playwright';
const U = process.env.PROTO_URL || 'http://localhost:8163/';
const exe = process.env.CHROME || '/home/ubuntu/.cache/ms-playwright/chromium-1187/chrome-linux/chrome';
const errs = [];
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const pg = await b.newPage({ viewport: { width: 412, height: 892 } });
pg.on('pageerror', e => errs.push(e.message));
const last = s => pg.locator('.view:last-child ' + s);
const w = ms => pg.waitForTimeout(ms);
await pg.goto(U); await w(500);
await pg.locator('.nav button', { hasText: 'Гардероб' }).click(); await w(400);
await last('.ocard').filter({ hasText: 'Сарафан' }).click(); await w(400);
await last('.btn').filter({ hasText: 'Посмотреть' }).click(); await w(400);
await last('.btn').filter({ hasText: 'В корзину' }).click(); await w(450);
await last('.stepper button').filter({ hasText: '+' }).click(); await w(300);
await last('.btn').filter({ hasText: 'К доставке' }).click(); await w(400);
await last('.opt').filter({ hasText: 'Курьер' }).click(); await w(300);
await last('.btn').filter({ hasText: 'Создать заявку' }).click(); await w(500);
await last('.btn').filter({ hasText: 'Открыть заявку' }).click(); await w(500);
const asm = await last('.body').innerText();
const ok = asm.includes('Сарафан') && asm.includes('Ботинки');
console.log('assembly shows sundress+boots:', ok, '| JS errors:', errs.length ? errs : 'none');
await b.close();
process.exit(ok && !errs.length ? 0 : 1);
