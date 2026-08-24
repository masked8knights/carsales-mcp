/**
 * Free vehicle trust check (100% FOSS, NO paid API.
 *
 * Paid competitors wrap the PPSR (Personal Property Securities Register) for
 * encumbrance / write-off reports. We deliberately do NOT use PPSR: it charges
 * per search. Instead we point at the *free* state-transport registration checks
 * (which show registration validity + written-off status) and attempt a
 * best-effort automated lookup. The official manual URL is always returned so a
 * human can verify independently.
 *
 * NOTE: government rego-check pages are often CAPTCHA / datacenter-blocked, so
 * the automated lookup may return nothing. In that case use the manual URL.
 * Encumbrance (finance owed) is ONLY on paid PPSR and is intentionally out of
 * scope for this FOSS tool.
 */

import { getPage } from './browser.js';

const STATE_REGO_URL: Record<string, string> = {
  nsw: 'https://www.service.nsw.gov.au/transaction/check-registration',
  vic: 'https://www.vicroads.vic.gov.au/registration/buyers-and-sellers/check-vehicle-registration',
  qld: 'https://www.qld.gov.au/transport/registration/check/vehicle',
  wa: 'https://online.transport.wa.gov.au/web/vehicle-registration-check',
  sa: 'https://www.sa.gov.au/registration',
  tas: 'https://www.transport.tas.gov.au/',
  act: 'https://www.accesscanberra.act.gov.au/',
  nt: 'https://nt.gov.au/',
};

export interface VehicleCheck {
  plate: string;
  state: string;
  manualUrl: string;
  automated: boolean;
  text: string;
}

function normState(s: string): string {
  return s.toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
}

export async function checkVehicle(plate: string, stateRaw: string): Promise<VehicleCheck> {
  const state = normState(stateRaw);
  const manualUrl = STATE_REGO_URL[state] || STATE_REGO_URL.nsw;
  const page = await getPage();
  try {
    await page.goto(manualUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    // Fill the first plausible text input with the plate and submit.
    const input = page.locator('input[type="text"], input:not([type])').first();
    if (await input.count()) {
      await input.fill(plate);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }
    const body = await page.evaluate(() => document.body?.innerText || '');
    const lines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /(registration|rego|written|off|expir|valid|invalid|stolen|encumbrance|make|model|year|plate)/i.test(l))
      .slice(0, 25);
    return {
      plate,
      state,
      manualUrl,
      automated: lines.length > 0,
      text: lines.length
        ? lines.join('\n')
        : 'Automated lookup returned nothing (government page likely CAPTCHA / bot-blocked). Verify manually at the URL below.',
    };
  } catch (e) {
    return {
      plate,
      state,
      manualUrl,
      automated: false,
      text: `Automated lookup failed (${(e as Error).message}). Verify manually at the URL below.`,
    };
  }
}
