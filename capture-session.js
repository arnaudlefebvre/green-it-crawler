/*
 * Copyright 2025 Arnaud Lefebvre
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// capture-session.js
// Ouvre un navigateur visible, te laisse faire le login, puis enregistre storageState.json.
// Usage :
//   node capture-session.js --url https://... --out out/auth/storageState.json [--persist-session] [--ignore-https-errors]
//   (optionnel) --wait-selector "#appRoot"  ou  --wait-url-contains "/mysanteclair"
//   Ensuite lance ton runner avec --persist-session et storageStatePath pointant sur ce fichier.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive:true }); }

const args = process.argv.slice(2);
function getArg(flag, def=null){ const i = args.indexOf(flag); return i>=0 ? args[i+1] : def; }
function hasFlag(flag){ return args.includes(flag); }

const startUrl = getArg('--url', 'https://example.com');
const outPath  = getArg('--out', path.join(__dirname, 'out', 'auth', 'storageState.json'));
const waitSel  = getArg('--wait-selector', null);
const waitUrlContains = getArg('--wait-url-contains', null);
const ignoreHTTPSErrors = hasFlag('--ignore-https-errors');
const persistSession = hasFlag('--persist-session'); // juste un alias sémantique, on sauvegarde toujours à la fin

(async () => {
  ensureDir(path.dirname(outPath));
  const browser = await chromium.launch({ headless: false }); // visible
  const context = await browser.newContext({ ignoreHTTPSErrors });
  const page = await context.newPage();

  console.log('[capture-session] Navigating to:', startUrl);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  if (waitSel) {
    console.log(`[capture-session] Waiting for selector: ${waitSel} (no timeout)`);
    await page.waitForSelector(waitSel, { timeout: 0 });
  }
  if (waitUrlContains) {
    console.log(`[capture-session] Waiting until URL contains: ${waitUrlContains} (no timeout)`);
    await page.waitForFunction((sub) => location.href.includes(sub), waitUrlContains, { timeout: 0 });
  }

  console.log('\n[capture-session] Connecte-toi dans la fenêtre ouverte.');
  console.log('[capture-session] Quand c’est bon, reviens ici et appuie sur Entrée pour sauvegarder la session.\n');

  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));

  await context.storageState({ path: outPath });
  console.log(`[capture-session] Session sauvegardée -> ${outPath}`);

  await page.close();
  await context.close();
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('[capture-session] ERROR:', e);
  process.exit(1);
});
