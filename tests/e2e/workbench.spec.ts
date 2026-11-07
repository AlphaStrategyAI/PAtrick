import { test, expect } from '@playwright/test';

test('workbench exposes a real project and lets a manual task enter the ledger', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.getByText('演示模式', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '新建任务', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '交给 PAtrick 一件事' });
  await form.getByLabel('任务名称').fill(`浏览器验收 ${Date.now()}`);
  await form.getByLabel('原始材料').fill('请整理用户对草稿恢复的要求。原话：导出失败后应保留草稿，供用户下次恢复。');
  await form.getByRole('button', { name: '交给 PAtrick', exact: true }).click();
  await expect(form).not.toBeVisible();
  await expect(page.getByText('浏览器验收', { exact: false }).first()).toBeVisible();
});

test('Chinese knowledge search preserves quoted evidence and source revision', async ({ page }) => {
  await page.goto('/knowledge?q=草稿');
  await expect(page.getByRole('heading', { name: '知识', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索知识' })).toHaveValue('草稿');
  const card = page.locator('.knowledge-card').first();
  await expect(card).toBeVisible();
  const original = card.locator('details.knowledge-evidence').filter({ hasText: '查看原文' });
  await expect(original).toHaveCount(1);
  await original.getByText('查看原文', { exact: true }).click();
  await expect(original.locator('blockquote')).toHaveCount(1);
  await expect(original.locator('blockquote')).toBeVisible();
  await expect(original.getByText('来源修订', { exact: false })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索知识' }).fill('不存在的知识主题xqz987');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByText('没有找到相关知识', { exact: true })).toBeVisible();
});

test('task details retain a seven layer trace and delivery evidence', async ({ page }) => {
  await page.goto('/');
  const delivered = page.locator('[data-task-status="delivered"]').first();
  await delivered.getByRole('link', { name: /查看任务/ }).click();
  const drawer = page.getByRole('dialog', { name: '任务详情' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '七层轨迹', exact: true })).toBeVisible();
  await expect(drawer.locator('.layer-list > li')).toHaveCount(7);
  await expect(drawer.getByRole('heading', { name: '交付回执', exact: true })).toBeVisible();
  await expect(drawer.getByText('合并 SHA', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
});

test('a rejected custom answer is announced without losing the draft', async ({ page }) => {
  await page.goto('/');
  const question = page.locator('.question-form').first();
  await expect(question).toBeVisible();
  await question.getByLabel('C · 我自己决定').check();
  await question.getByLabel('你的决定').fill('保留这个尚未提交的决定。');
  await page.route('**/api/questions/*/answer', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '问题版本已更新，请重新查看当前问题。' }) }));
  await question.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(question.getByRole('alert')).toContainText('问题版本已更新');
  await expect(question.getByLabel('你的决定')).toHaveValue('保留这个尚未提交的决定。');
});

test('custom answer keeps original words and resumes the current question', async ({ page }) => {
  await page.goto('/');
  const question = page.locator('.question-form').first();
  await expect(question).toBeVisible();
  await question.getByLabel('C · 我自己决定').check();
  const input = question.getByLabel('你的决定');
  await expect(input).toBeVisible();
  await input.fill('仅保留到用户下一次成功导出，最多七天。');
  await question.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByText('仅保留到用户下一次成功导出，最多七天。', { exact: false }).first()).toBeVisible();
});


for (const width of [375, 768, 1440]) {
  test(`navigation, source management and layouts work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    if (width < 768) await page.getByRole('button', { name: '打开导航' }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '来源', exact: true }).click();
    await expect(page.getByRole('heading', { name: '来源', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '连接与就绪状态', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('keyboard command search opens and the page remains usable without JavaScript', async ({ page, browser }) => {
  await page.goto('/');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByRole('dialog', { name: '搜索工作记忆' })).toBeVisible();
  await page.keyboard.press('Escape');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const basic = await context.newPage();
  await basic.goto('/knowledge?q=草稿');
  await expect(basic.getByRole('searchbox', { name: '搜索知识' })).toHaveValue('草稿');
  await expect(basic.locator('.knowledge-card').first()).toBeVisible();
  await context.close();
});

test('workbench filters and standards navigation expose matching ledger records', async ({ page }) => {
  await page.goto('/?view=delivered');
  const cards = page.locator('.task-card');
  expect(await cards.count()).toBeGreaterThan(0);
  await expect(page.locator('.task-card:not([data-task-status="delivered"])')).toHaveCount(0);
  await page.getByRole('link', { name: '全部任务', exact: true }).click();
  await expect(page.locator('[data-task-status="queued"]')).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '判断标准', exact: true }).click();
  await expect(page.getByRole('heading', { name: '判断标准', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '本人原则', exact: true }).click();
  await expect(page.locator('.rule-card').first()).toBeVisible();
  await expect(page.locator('.rule-card').first().getByText('本人原则', { exact: true })).toBeVisible();
  await page.locator('.rule-evidence summary').first().click();
  await expect(page.locator('.decision-case').first()).toContainText('仅保留到用户下一次成功导出，最多七天。');
});

test('withdrawing an added source removes its knowledge from active search', async ({ page, request }) => {
  const marker = `withdrawal${Date.now()}`;
  const title = `撤回验收 ${marker}`;
  await page.goto('/sources');
  const form = page.locator('#add-source .new-task-form');
  await form.getByLabel('任务名称').fill(title);
  await form.getByLabel('原始材料').fill(`${marker} 用户报告：导出失败后应恢复草稿。这条材料将用于验证来源撤回。`);
  await form.getByRole('button', { name: '加入资料并开始处理', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect.poll(async () => {
    const state = await (await request.get('/api/state')).json();
    return state.cards.some((card: { title: string }) => card.title === title);
  }).toBe(true);
  const beforeWithdrawal = await (await request.get('/api/state')).json();
  const originalSource = beforeWithdrawal.sources.find((source: { title: string }) => source.title === title);
  expect(originalSource).toBeDefined();
  await page.goto('/sources');
  const source = page.locator('.source-item').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await source.locator('.withdraw-confirm > summary').click();
  await source.getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(page.getByRole('heading', { name: '来源', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.goto(`/knowledge?q=${marker}`);
  await expect(page.getByText('没有找到相关知识', { exact: true })).toBeVisible();
  await page.goto('/sources?status=withdrawn');
  const tombstone = page.locator('.source-item').filter({ hasText: `withdrawn:${originalSource.id}` });
  await expect(tombstone).toBeVisible();
  await expect(tombstone.getByText('已撤回', { exact: true })).toBeVisible();
  await expect(page.getByText(marker, { exact: false })).toHaveCount(0);
});

test('a custom answer submits and keeps the original decision without JavaScript', async ({ request, browser }) => {
  const state = await (await request.get('/api/state')).json();
  const project = state.projects[0];
  const title = `无脚本问题 ${Date.now()}`;
  const created = await request.post('/api/tasks', {
    headers: { Accept: 'application/json' },
    form: { projectId: project.id, title, externalId: `nojs-question-${Date.now()}`, content: '用户报告：导出失败后需要恢复草稿。相同范围的要求存在失败即删与保留七天的冲突，请确定保留时间。' },
  });
  expect(created.ok()).toBe(true);
  const { task } = await created.json();
  await expect.poll(async () => (await (await request.get(`/api/tasks/${task.id}`)).json()).task.status).toBe('awaiting_answer');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`/tasks/${task.id}`);
  const form = page.locator('.question-form');
  await expect(form.getByLabel('你的决定')).toBeVisible();
  await form.getByLabel('C · 我自己决定', { exact: true }).check();
  const original = '仅保留到下一次成功导出；超过七天清理，并在本产品内适用。';
  await form.getByLabel('你的决定').fill(original);
  await form.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已接纳的决定', exact: true })).toBeVisible();
  await expect(page.locator('.answer-receipt blockquote')).toHaveText(original);
  const result = await (await request.get(`/api/tasks/${task.id}`)).json();
  expect(result.question.answer.text).toBe(original);
  expect(result.question.status).toBe('answered');
  await context.close();
});

test('project creation accepts repository service, trusted CI identities and optional source directory', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const originalProject = state.projects[0];
  const marker = Date.now();
  const name = `配置验收 ${marker}`;
  const sourceDir = `/tmp/patrick-e2e-source-${marker}`;
  await page.goto(`/settings?project=${originalProject.id}#projects`);
  const form = page.locator('#projects .project-form');
  await form.getByLabel('项目名称', { exact: true }).fill(name);
  await form.getByRole('combobox', { name: '仓库服务', exact: true }).selectOption('gitlab');
  await form.getByRole('combobox', { name: /^执行首选/ }).selectOption('dsh');
  await form.getByLabel('目标仓库').fill('team/subgroup/notes');
  await form.getByLabel('PRD 路径', { exact: true }).fill('docs/PRD.md');
  await form.getByLabel('允许修改的路径').fill('docs/PRD.md');
  await form.getByLabel('可信必需检查').fill('validate-prd');
  await form.getByLabel('可信 CI 身份 ID').fill('101, 202\n303');
  await form.getByLabel('同步目录（可选）').fill(sourceDir);
  await expect(form.getByLabel('结果复核间隔（天）')).toHaveValue('7');
  await form.getByLabel('结果复核间隔（天）').fill('30');
  await expect(form.getByLabel('允许在全部门禁通过后自动合并')).not.toBeChecked();
  await form.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.locator('.project-switcher summary')).toContainText(name);
  const updated = await (await request.get('/api/state')).json();
  const created = updated.projects.find((project: { name: string }) => project.name === name);
  expect(created).toMatchObject({ repositoryProvider: 'gitlab', repository: 'team/subgroup/notes', executionRunner: 'dsh', trustedAppIds: [101, 202, 303], sourceDir, autoMerge: false, reviewIntervalDays: 30 });
  await page.goto(`/settings?project=${created.id}`);
  await expect(page.locator('.key-value > div').filter({ has: page.getByText('结果复核间隔', { exact: true }) })).toHaveText('结果复核间隔30 天');
  await page.reload();
  await expect(page.locator('.key-value > div').filter({ has: page.getByText('结果复核间隔', { exact: true }) })).toHaveText('结果复核间隔30 天');
  await page.locator('.project-switcher summary').click();
  await page.locator('.project-menu a').filter({ hasText: originalProject.name }).click();
  await expect(page.locator('.project-switcher summary')).toContainText(originalProject.name);
});

test('project creation persists the default zero-dollar spending cap after settings reload', async ({ page, request }) => {
  const name = `零预算验收 ${Date.now()}`;
  await page.goto('/settings#projects');
  const form = page.locator('#projects .project-form');
  const budget = form.locator('input[name="budgetUsd"]');
  await expect(budget).toHaveAttribute('min', '0');
  await expect(budget).toHaveValue('0');
  await expect(form).toContainText('0 将阻止需要费用预留的运行器；订阅权限仍需单独核验。');
  await form.getByLabel('项目名称', { exact: true }).fill(name);
  await form.getByLabel('目标仓库').fill('owner/zero-cap');
  await form.getByLabel('允许修改的路径').fill('docs/PRD.md');
  expect(await budget.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  expect(await form.evaluate((element: HTMLFormElement) => element.checkValidity())).toBe(true);
  await form.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.locator('.project-switcher summary')).toContainText(name);
  const state = await (await request.get('/api/state')).json();
  const created = state.projects.find((project: { name: string }) => project.name === name);
  expect(created).toMatchObject({ budgetUsd: 0, repository: 'owner/zero-cap' });
  await page.goto(`/settings?project=${created.id}`);
  await page.reload();
  await expect(page.locator('.project-switcher summary')).toContainText(name);
  await expect(page.locator('.key-value > div').filter({ has: page.getByText('单任务预算', { exact: true }) })).toHaveText('单任务预算$0.00');
});

test('weekly reflection uses the scoped owner decision and keeps budget and connection labels qualified', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const project = state.projects[0];
  const report = await (await request.get(`/api/reports/weekly?project=${project.id}`)).json();
  expect(report.focus).not.toBeNull();
  await page.goto(`/?project=${project.id}`);
  const weekly = page.getByRole('region', { name: '每周回看' });
  await expect(weekly).toBeVisible();
  await expect(weekly).toContainText('本周维护时间尚未记录');
  await expect(weekly.getByRole('heading', { name: '当时依据的规则', exact: true })).toBeVisible();
  await expect(weekly.getByRole('heading', { name: '下次可以这样判断', exact: true })).toBeVisible();
  await page.goto(`/standards?project=${project.id}`);
  const reflection = page.getByRole('region', { name: '每周回看' });
  await expect(reflection).toBeVisible();
  await expect(reflection.locator('blockquote')).toHaveText(report.focus.case.originalWords);
  await expect(reflection).toContainText(report.focus.outcome || '待观察');
  for (const rule of report.focus.rules) await expect(reflection).toContainText(`${rule.title} · v${rule.version}`);
  await page.goto(`/settings?project=${project.id}`);
  await expect(page.locator('.readiness-list')).not.toContainText('未就绪');
  await expect(page.locator('.readiness-list')).toContainText('已配置');
  const delivered = state.tasks.find((task: { status: string }) => task.status === 'delivered');
  await page.goto(`/tasks/${delivered.id}`);
  await expect(page.getByText('额外支出记账（保守预留）', { exact: true })).toBeVisible();
  await expect(page.getByText('每次调用仍须通过当前费用与运行边界复核；保守预留不代表提供方账单，0 美元不会自动准入。', { exact: true })).toBeVisible();
  await expect(page.getByText('实际尝试与费用', { exact: false })).toHaveCount(0);
});


test('standards show real demo judgments as scheduled reviews with business results observing', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  const project = state.projects[0];
  const response = await request.get(`/api/reviews?project=${project.id}&domain=${project.domain}`);
  expect(response.ok()).toBe(true);
  const { reviews } = await response.json();
  expect(reviews.length).toBeGreaterThan(0);
  await page.goto(`/standards?project=${project.id}`);
  const section = page.getByRole('region', { name: '结果复核', exact: true });
  await expect(section).toBeVisible();
  await expect(section).toContainText('不代表预测准确，也不证明业务改善');
  for (const review of reviews) {
    const taskHref = `/tasks/${review.taskId}?${new URLSearchParams({ project: project.id })}`;
    const subject = section.locator(`article[id="outcome-review-${review.snapshotId}"]`).filter({ has: page.getByRole('link', { name: '查看原始任务', exact: true }).and(page.locator(`a[href="${taskHref}"]`)) });
    await expect(subject).toHaveCount(1);
    await expect(subject.getByRole('link', { name: '查看原始任务', exact: true })).toHaveAttribute('href', taskHref);
    await expect(subject.getByRole('heading', { name: review.snapshot.goal.title, exact: true })).toBeVisible();
    await expect(subject.getByText('待观察', { exact: true })).toBeVisible();
    const scheduleRow = subject.locator('p.metadata').filter({ hasText: /^初判记录于/ });
    await expect(scheduleRow.locator(`time[datetime="${review.scheduledAt}"]`)).toBeVisible();
    await expect(subject).toContainText(`每 ${review.reviewIntervalDays} 天`);
    await expect(subject.getByText('已关联结果依据', { exact: true })).toHaveCount(0);
  }
});
