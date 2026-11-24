import { expect, test } from '@playwright/test';
import { t15Fixture } from './T15-fixture.js';

test('owner registers a passkey from the signed-out screen and signs in again', async ({ page, context }) => {
  const fixture = await t15Fixture();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.goto('/decisions');
    await page.getByRole('button', { name: '首次登记通行密钥' }).click();
    await page.getByLabel('一次性登记口令').fill('invalid-bootstrap-ticket');
    await page.getByRole('button', { name: '登记并登录' }).click();
    await expect(page.getByRole('alert')).toHaveText('登记未完成。请检查一次性口令后重试。');
    await expect(page.getByLabel('一次性登记口令')).toHaveValue('');
    await page.getByLabel('一次性登记口令').fill(fixture.bootstrapTicket);
    await page.getByRole('button', { name: '登记并登录' }).click();
    await expect(page.getByTestId('decision-Q-017')).toBeVisible();
    expect(fixture.db.prepare('SELECT account_id FROM passkey_credentials').all()).toEqual([{ account_id: 'owner' }]);
    await context.clearCookies();
    await page.reload();
    await page.getByRole('button', { name: '使用通行密钥登录' }).click();
    await expect(page.getByTestId('decision-Q-017')).toBeVisible();
    expect(fixture.requests.filter(({ method, path, status }) =>
      method === 'POST' && path === '/api/v1/auth/verify' && status === 200)).toHaveLength(2);
  } finally { await fixture.close(); }
});

test('same-work: consultation stays separate and the explicit decision reads its verified receipt', async ({ page }) => {
  const fixture = await t15Fixture();
  try {
    await fixture.signIn(page);
    await page.goto('/decisions');
    const card = page.getByTestId('decision-Q-017');
    await expect(card.getByText('写一个自定义决定')).toBeVisible({ timeout: 3500 });
    await expect(card.getByRole('radio', { name: /方案 A/ })).not.toBeChecked();
    await card.getByRole('link', { name: '查看工作 W-017' }).click();
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    await page.getByRole('button', { name: '问个问题' }).click();
    await page.getByRole('textbox', { name: '咨询草稿' }).fill('同意');
    await page.getByRole('button', { name: '发送咨询' }).click();
    await expect(page.getByText('正在回答')).toBeVisible();
    const started = fixture.db.prepare('SELECT request_id,result_version,raw_text,parent_work_id FROM consultations').get() as {
      request_id: string; result_version: number; raw_text: string; parent_work_id: string | null;
    };
    expect(started).toMatchObject({ result_version: 0, raw_text: '同意', parent_work_id: null });
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: '界面语言' }).selectOption('en');
    await page.getByRole('button', { name: 'Ask a question' }).click();
    await expect(page.getByText('Answering')).toBeVisible();
    expect(await fixture.completeConsultation(started.request_id, started.result_version, '保留咨询原话')).toBe(true);
    await expect(page.getByText('Consultation answered')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('保留咨询原话');
    expect(fixture.requests.filter(({ method, path }) => method === 'POST' && path === '/api/v1/consultations')).toHaveLength(1);
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Interface language' }).selectOption('zh');
    await page.getByRole('button', { name: '问个问题' }).click();
    await expect(page.getByText('咨询已回答')).toBeVisible();
    await page.getByRole('textbox', { name: '普通消息' }).fill('我同意这条普通消息');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('我同意这条普通消息')).toBeVisible();
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM answer_receipts').get()).toEqual({ count: 0 });
    expect(fixture.claimCollection('before-answer')).toEqual({ status: 'absent' });
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: '查看原决策 Q-017' }).click();
    await card.getByRole('radio', { name: /方案 A/ }).check();

    fixture.loseNextAnswerResponse();
    await card.getByRole('button', { name: '提交决定' }).click();
    await expect(card.getByRole('button', { name: '重试原提交' })).toBeVisible();
    await card.getByRole('button', { name: '重试原提交' }).click();
    await expect(page.getByTestId('answer-receipt-Q-017')).toContainText('已核验');
    const commands = fixture.requests.filter(({ method, path }) => method === 'POST' && path === '/api/v1/questions/Q-017/answers');
    expect(commands).toHaveLength(2);
    expect(commands[0].body).toEqual(commands[1].body);
    expect(commands[0].body).toMatchObject({ expected_revision: 1, payload: {
      work_id: 'W-017', generation: 1, question_id: 'Q-017', question_version: 1, proposal_revision: 1,
      options_hash: fixture.question.options_hash, answer: { kind: 'option', option_id: 'approved-choice' },
    } });
    expect(fixture.db.prepare('SELECT question_id,validity FROM answer_receipts').all()).toEqual([{ question_id: 'Q-017', validity: 'verified' }]);
    expect(fixture.claimCollection('after-answer')).toMatchObject({
      status: 'claimed', grant: { work_id: 'W-017', generation: 1, phase: 'collect_evidence', allowed_effects: ['collect:collection-017'] },
    });
    expect(fixture.claimCollection('repeated-answer')).toEqual({ status: 'duplicate' });
    await page.getByRole('link', { name: '查看工作 W-017' }).click();
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    await expect(page.getByText(/决定已核验/)).toBeVisible();
  } finally { await fixture.close(); }
});

test('small screen: a replacement card preserves the original draft without using it as an answer', async ({ page }) => {
  const fixture = await t15Fixture();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture.signIn(page);
    await page.goto('/decisions');
    const old = page.getByTestId('decision-Q-017');
    await old.getByText('写一个自定义决定').click();
    await old.getByRole('textbox', { name: '自定义决定' }).fill('保留这个尚未提交的决定');
    await page.getByRole('button', { name: '问个问题' }).click();
    const consult = page.getByRole('dialog');
    await consult.getByRole('textbox', { name: '咨询草稿' }).fill('这是另一份咨询草稿');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '问个问题' })).toBeFocused();
    await expect(old.getByRole('textbox', { name: '自定义决定' })).toHaveValue('保留这个尚未提交的决定');
    await fixture.replaceQuestion();
    await old.getByRole('button', { name: '读取决定' }).click();
    await expect(old.getByRole('textbox', { name: '自定义决定' })).toBeDisabled();
    await expect(old.getByRole('textbox', { name: '自定义决定' })).toHaveValue('保留这个尚未提交的决定');
    await old.getByRole('link', { name: '查看替代决定' }).click();
    const next = page.getByTestId('decision-Q-018');
    await next.getByText('写一个自定义决定').click();
    await expect(next.getByRole('textbox', { name: '自定义决定' })).toHaveValue('');
    await expect(next.getByRole('button', { name: '提交决定' })).toBeDisabled();
    expect(fixture.requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/answers'))).toHaveLength(0);

    await page.getByRole('button', { name: '问个问题' }).click();
    const link = consult.getByRole('checkbox', { name: '明确关联这项工作 W-017' });
    await expect(link).not.toBeChecked();
    await link.check();
    await expect(consult.getByRole('textbox', { name: '咨询草稿' })).toHaveValue('这是另一份咨询草稿');
    await consult.getByRole('button', { name: '发送咨询' }).click();
    await expect(consult.getByText('已关联的工作: W-017')).toBeVisible();
    expect(fixture.db.prepare('SELECT parent_work_id FROM consultations').get()).toEqual({ parent_work_id: 'W-017' });
    await page.keyboard.press('Escape');

    const custom = '  原话保留  ';
    await next.getByRole('textbox', { name: '自定义决定' }).fill(custom);
    await next.getByRole('button', { name: '提交自定义决定' }).click();
    await expect(page.getByTestId('answer-receipt-Q-018')).toContainText('已核验');
    expect(fixture.db.prepare('SELECT question_id, raw_custom FROM decision_submissions').get())
      .toEqual({ question_id: 'Q-018', raw_custom: custom });
  } finally { await fixture.close(); }
});

test('two tabs fence a late private response when the session is revoked during reconnect', async ({ page, context }) => {
  const fixture = await t15Fixture();
  const second = await context.newPage();
  let held: ReturnType<typeof fixture.holdNextRead> | undefined;
  try {
    await fixture.signIn(page);
    await page.goto('/decisions?question=Q-017&work=W-017');
    await second.goto('/work/W-017');
    const card = page.getByTestId('decision-Q-017');
    await expect(card).toBeVisible();
    await expect(second.getByTestId('work-id')).toHaveText('W-017');
    await expect.poll(() => fixture.requests.filter(({ path, status }) => path === '/api/v1/events' && status === 200).length)
      .toBeGreaterThanOrEqual(2);
    fixture.disconnectEvents();
    held = fixture.holdNextRead('/api/v1/questions/Q-017');
    await card.getByText('写一个自定义决定').click();
    await card.getByRole('textbox', { name: '自定义决定' }).fill('不能泄露的旧草稿');
    await card.getByRole('button', { name: '读取决定' }).click();
    await held.ready;
    fixture.revoke();
    fixture.reconnectEvents();
    await expect(card).toHaveCount(0, { timeout: 12_000 });
    await expect(second.getByTestId('work-id')).toHaveCount(0, { timeout: 12_000 });
    await expect.poll(() => fixture.requests.filter(({ path, status }) => path === '/api/v1/session' && status === 401).length)
      .toBeGreaterThanOrEqual(2);
    held.release();
    await expect(card).toHaveCount(0);
    await expect(second.getByTestId('work-id')).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('patrick:private-draft:')))).toEqual([]);
  } finally { held?.release(); await second.close(); await fixture.close(); }
});

test('frozen question options are available only in the authorized domain', async () => {
  const fixture = await t15Fixture();
  try {
    const allowed = await fixture.readFrozenQuestion('same-domain');
    expect(allowed.status).toBe(200);
    const result = await allowed.json() as { scope: { data_domain: string }; data: Record<string, unknown> };
    expect(result.scope.data_domain).toBe('personal');
    expect(result.data).toMatchObject({ question_id: 'Q-017', options_hash: fixture.question.options_hash, custom_allowed: true,
      options: [{ option_id: 'approved-choice', index: 0, label: '方案 A：补充证据' },
        { option_id: 'deferred-choice', index: 1, label: '方案 B：稍后决定' }] });
    expect(result.data).not.toHaveProperty('custom_rules_json');
    expect(result.data).not.toHaveProperty('options_json');
    const denied = await fixture.readFrozenQuestion('different-domain');
    expect(denied.status).toBe(403);
  } finally { await fixture.close(); }
});

test('the decision card shows each option risk first and keeps the full detail one layer down', async ({ page }) => {
  const fixture = await t15Fixture();
  try {
    await fixture.signIn(page);
    await page.goto('/decisions');
    const card = page.getByTestId('decision-Q-017');
    await expect(card.getByRole('radio', { name: /方案 B/ })).toBeVisible({ timeout: 3500 });
    await expect(card.locator('.option-risk')).toHaveText('保持当前工作不推进');
    await expect(card.getByText('查看依据与完整利弊')).toBeVisible();
    await card.getByText('查看依据与完整利弊').click();
    await expect(card.getByText('接下来会做').first()).toBeVisible();
    await expect(card.getByText('还缺').first()).toBeVisible();
    await expect(card.getByText('还缺: 本人的决定')).toBeVisible();
  } finally { await fixture.close(); }
});

test('pause is shown only after the exact work control receipt is read', async ({ page }) => {
  const fixture = await t15Fixture();
  try {
    await fixture.signIn(page);
    await page.goto('/work/W-017');
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    await expect(page.getByRole('button', { name: '停止这项工作' })).toHaveCount(0);
    await page.getByRole('button', { name: '暂停这项工作' }).click();
    const review = page.getByRole('dialog', { name: '暂停这项工作' });
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM work_control_receipts').get()).toEqual({ n: 0 });
    await review.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByTestId('work-control-receipt')).toContainText('已暂停');
    expect(fixture.db.prepare('SELECT work_id,generation,state,revision FROM work_control_receipts').all())
      .toEqual([{ work_id: 'W-017', generation: 1, state: 'paused', revision: expect.any(Number) }]);
  } finally { await fixture.close(); }
});

test('an accepted consultation with a lost reply is retried exactly once under the same verified scope after a stream reset', async ({ page }) => {
  const fixture = await t15Fixture({ paidConsultation: true });
  const paid = fixture.paid!;
  let verification: ReturnType<typeof fixture.holdNextRead> | undefined;
  try {
    await fixture.signIn(page);
    await page.goto('/work/W-017');
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    await expect.poll(() => fixture.requests.filter(({ path, status }) => path === '/api/v1/events' && status === 200).length)
      .toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: '问个问题' }).click();
    await page.getByRole('textbox', { name: '咨询草稿' }).fill('只用本资料域补充解释');
    fixture.loseNextConsultationResponse();
    await page.getByRole('button', { name: '发送咨询' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '重试' })).toBeVisible();
    const submissions = () => fixture.requests.filter(({ method, path }) => method === 'POST' && path === '/api/v1/consultations');
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0].status).toBe(202);
    await expect.poll(paid.sends).toBe(1);

    verification = fixture.holdNextRead('/api/v1/session');
    fixture.resetWorkStream();
    await verification.ready;
    await expect(page.getByTestId('work-id')).toHaveCount(0);
    await page.getByRole('button', { name: '问个问题' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '重试' })).toHaveCount(0);
    verification.release();
    await expect(page.getByTestId('work-id')).toHaveText('W-017');

    if (!await page.getByRole('dialog').count()) await page.getByRole('button', { name: '问个问题' }).click();
    expect(submissions()).toHaveLength(1);
    await page.getByRole('dialog').getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('正在回答')).toBeVisible();
    expect(submissions()).toHaveLength(2);
    expect(submissions()[1].body).toEqual(submissions()[0].body);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM consultations').get()).toEqual({ n: 1 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE json_extract(payload,'$.type')='consultation.requested'").get()).toEqual({ n: 1 });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM business_budgets WHERE business_id LIKE 'consultation:%'").get()).toEqual({ n: 1 });
    paid.release();
    await expect(page.getByRole('dialog').getByText(paid.answer).first()).toBeVisible();
    expect(paid.sends()).toBe(1);
    expect(paid.errors).toEqual([]);
    expect(fixture.db.prepare(`SELECT b.spent_micros,b.held_micros,r.status FROM business_budgets b
      JOIN budget_reservations r USING(business_id) WHERE b.business_id LIKE 'consultation:%'`).all())
      .toEqual([{ spent_micros: 137, held_micros: 0, status: 'settled' }]);
  } finally {
    verification?.release();
    await fixture.close();
  }
});

test('a different authenticated caller on the same account cannot revive a quarantined consultation', async ({ page }) => {
  const fixture = await t15Fixture();
  try {
    await fixture.signIn(page);
    await page.goto('/work/W-017');
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    await expect.poll(() => fixture.requests.filter(({ path, status }) => path === '/api/v1/events' && status === 200).length)
      .toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: '问个问题' }).click();
    await page.getByRole('textbox', { name: '咨询草稿' }).fill('只属于原调用者');
    fixture.loseNextConsultationResponse();
    await page.getByRole('button', { name: '发送咨询' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '重试' })).toBeVisible();
    await fixture.changeWebCaller(page);
    const recheckedSession = page.waitForResponse((response) => response.url().endsWith('/api/v1/session'));
    fixture.resetWorkStream();
    const current = await recheckedSession;
    expect(await current.json()).toMatchObject({ data: { caller_id: 'different-web-caller' } });
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    if (!await page.getByRole('dialog').count()) await page.getByRole('button', { name: '问个问题' }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: '重试' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '咨询草稿' })).toHaveValue('');
    expect(fixture.requests.filter(({ method, path }) => method === 'POST' && path === '/api/v1/consultations')).toHaveLength(1);
  } finally { await fixture.close(); }
});

test('the consultation streams its answer and stays answering until the result is saved', async ({ page }) => {
  const fixture = await t15Fixture({ paidConsultation: true });
  try {
    await fixture.signIn(page);
    await page.goto('/work/W-017');
    await expect(page.getByTestId('work-id')).toHaveText('W-017');
    await page.getByRole('button', { name: '问个问题' }).click();
    await page.getByRole('textbox', { name: '咨询草稿' }).fill('答案是什么');
    await page.getByRole('button', { name: '发送咨询' }).click();
    await expect(page.getByText('正在回答')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('这是同一咨询的测试')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('咨询已回答')).toHaveCount(0);
    expect(fixture.db.prepare("SELECT status FROM consultations WHERE status='answered'").get()).toBeUndefined();
    expect(fixture.db.prepare('SELECT partial_text FROM consultations').get())
      .toEqual({ partial_text: '这是同一咨询的测试' });
  } finally { await fixture.close(); }
});
