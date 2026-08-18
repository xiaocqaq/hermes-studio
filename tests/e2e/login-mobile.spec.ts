import { expect, test } from '@playwright/test'
import { mockHermesApi } from './fixtures'

test.use({ viewport: { width: 390, height: 844 } })

test('keeps the mobile login shell transparent with translucent inputs', async ({ page }) => {
  await mockHermesApi(page)
  await page.goto('/#/login')

  const card = page.locator('.login-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(card).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)')
  await expect(card).toHaveCSS('box-shadow', 'none')
  await expect(card).toHaveCSS('backdrop-filter', 'none')

  const inputs = page.locator('.login-input')
  await expect(inputs.nth(0)).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.72)')
  await expect(inputs.nth(1)).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.58)')
})
