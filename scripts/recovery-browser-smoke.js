async () => {
  await page.goto("http://127.0.0.1:8792");
  const issues = [], requests = [];
  page.on('pageerror', error => issues.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/api/recover')) requests.push(request.postDataJSON());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '已有账号？去登录' }).click();
  await page.getByRole('button', { name: '找回账号 / 重置密码' }).click();
  if (await page.locator('input[name="username"]').count()) throw Error('Recovery still asks for a username');
  await page.getByLabel('找回密钥（8 个词，用空格隔开）').fill('错 错 错 错 错 错 错 错');
  await page.getByLabel('新密码', { exact: true }).fill('isolated-new-password');
  await page.getByLabel('确认新密码', { exact: true }).fill('different-password');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '两次输入的新密码不一致' }).waitFor();
  if (requests.length) throw Error('Mismatching passwords reached server');
  await page.getByLabel('确认新密码', { exact: true }).fill('isolated-new-password');
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '找回密钥不正确或已失效' }).waitFor();
  await page.getByLabel('找回密钥（8 个词，用空格隔开）').fill('山 海 星 月 春 风 秋 雨');
  await page.screenshot({ path: 'output/playwright/recovery-key-only-mobile.png' });
  await page.getByRole('button', { name: '重置密码', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '密码已重置' }).waitFor();
  if (await page.locator('input[name="username"]').inputValue() !== '旧测试账号') throw Error('Recovered account not filled');
  if (await page.getByLabel('密码', { exact: true }).inputValue()) throw Error('Password retained after reset');
  if (requests.length !== 2 || requests.some(body => Object.keys(body).sort().join(',') !== 'password,phrase')) throw Error('Recovery request includes unexpected fields');
  await page.screenshot({ path: 'output/playwright/recovery-success-mobile.png' });
  // Check signup saves the recovery hash in the original account-creation request.
  let signup;
  await page.route('https://auth.example.test/auth/v1/**', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (!route.request().url().includes('/signup')) throw Error('Unexpected auth request');
    signup = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({
      access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600, token_type: 'bearer',
      user: { id: 'new-isolated-user', email: signup.email, user_metadata: signup.data },
    }) });
  });
  await page.getByRole('button', { name: '没有账号？注册一个' }).click();
  await page.locator('input[name="username"]').fill('新测试账号');
  await page.getByLabel('密码', { exact: true }).fill('isolated-signup-password');
  await page.getByLabel('确认密码', { exact: true }).fill('isolated-signup-password');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByRole('heading', { name: '请保存你的找回密钥' }).waitFor();
  const words = await page.locator('.recovery-word').evaluateAll(nodes => nodes.map(node => [...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim()));
  if (words.length !== 8 || new Set(words).size !== 8) throw Error('Invalid generated key');
  const expected = await page.evaluate(async text => {
    const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join('');
  }, 'recovery:新测试账号:' + words.join(' '));
  if (signup?.data?.recovery !== expected) throw Error('Displayed key not saved at signup');
  if (issues.length) throw Error(issues.join('\n'));
  return { passed: ['no username field', 'no username in request', 'password confirmation', 'incorrect key rejection', 'legacy key reset', 'account autofill', 'password cleared', 'new key saved at signup'], pageErrors: issues };
}
