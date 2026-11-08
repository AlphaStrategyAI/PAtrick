(() => {
  'use strict';
  const $ = (selector, parent = document) => parent.querySelector(selector);
  let activeTaskUrl = null;
  let opener = null;
  let pollFingerprint = null;
  let refreshing = false;
  let hasDraft = false;
  let toastTimeout;

  function toast(message) {
    const element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { element.hidden = true; }, 6000);
  }
  function showDialog(dialog, source) {
    if (!dialog || typeof dialog.showModal !== 'function') return false;
    if (dialog.open) return true;
    opener = source || document.activeElement;
    document.querySelectorAll('dialog[open]').forEach(other => other.close());
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    const focus = dialog.querySelector('[autofocus]') || dialog.querySelector('input:not([type=hidden]):not([type=radio]):not(:disabled),textarea:not(:disabled)') || dialog.querySelector('button,a');
    if (focus) focus.focus();
    return true;
  }
  function closeDialog(dialog) {
    if (dialog?.open) dialog.close();
  }
  function setNav(open) {
    document.body.classList.toggle('nav-is-open', open);
    const toggle = $('[data-toggle-nav]');
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    if (open) $('#sidebar a[aria-current=page]')?.focus();
    else toggle?.focus();
  }
  function updateChoices(form) {
    const field = $('[data-custom-decision]', form);
    const custom = $('input[name=choice]:checked', form)?.value === 'C';
    if (!field) return;
    field.hidden = !custom;
    const textarea = $('textarea', field);
    if (textarea) {
      textarea.required = custom;
      textarea.disabled = !custom;
    }
  }
  function initForms(parent = document) {
    parent.querySelectorAll('[data-question-form]').forEach(updateChoices);
  }
  initForms();

  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
      document.body.style.overflow = '';
      if (dialog.id === 'task-drawer') activeTaskUrl = null;
      if (opener?.isConnected) opener.focus();
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(dialog);
    });
  });

  async function openTask(url, source, refresh = false) {
    const drawer = $('#task-drawer');
    const body = $('#task-drawer-body');
    if (!drawer || !body) { window.location.assign(url); return; }
    if (!refresh && !showDialog(drawer, source)) { window.location.assign(url); return; }
    activeTaskUrl = url;
    const fullLink = $('#open-task-page');
    if (fullLink) fullLink.href = url;
    if (!refresh) {
      const loading = document.createElement('p');
      loading.className = 'drawer-loading';
      loading.textContent = '正在读取任务记录…';
      body.replaceChildren(loading);
    }
    try {
      const response = await fetch(url, { headers: { Accept: 'text/html' }, credentials: 'same-origin' });
      if (!response.ok) throw new Error('暂时无法读取任务。请重试或打开完整页面。');
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      const detail = parsed.querySelector('#task-detail-content');
      if (!detail) {
        if (parsed.querySelector('input[name=token]')) { window.location.assign('/login'); return; }
        throw new Error('任务不在当前项目中，或已不存在。');
      }
      body.replaceChildren(document.importNode(detail, true));
      initForms(body);
    } catch (error) {
      if (refresh) { toast(error.message || '暂时无法更新任务'); return; }
      const panel = document.createElement('div');
      panel.className = 'drawer-error';
      const message = document.createElement('p');
      message.textContent = error.message || '暂时无法读取任务。';
      const link = document.createElement('a');
      link.className = 'button button-secondary';
      link.href = url;
      link.textContent = '打开完整任务页面';
      panel.append(message, link);
      body.replaceChildren(panel);
    }
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const open = target.closest('[data-open]');
    if (open) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      if (showDialog(document.getElementById(open.dataset.open), open)) event.preventDefault();
      return;
    }
    const close = target.closest('[data-close-dialog]');
    if (close) { closeDialog(close.closest('dialog')); return; }
    if (target.closest('[data-toggle-nav]')) { setNav(!document.body.classList.contains('nav-is-open')); return; }
    if (target.closest('[data-close-nav]')) { setNav(false); return; }
    const task = target.closest('a[data-task-link]');
    if (task && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
      event.preventDefault();
      openTask(task.href, task);
      return;
    }
    if (document.body.classList.contains('nav-is-open') && target.closest('#sidebar nav a')) setNav(false);
    const project = $('.project-switcher');
    if (project?.open && !target.closest('.project-switcher')) project.open = false;
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      showDialog($('#search-dialog'), document.activeElement);
      $('#global-search-input')?.focus();
    }
    if (event.key === 'Escape' && document.body.classList.contains('nav-is-open')) setNav(false);
  });
  async function setProbeStatus(targetId, message, ok) {
    const status = targetId ? document.getElementById(targetId) : null;
    if (!status) return;
    status.textContent = message;
    status.dataset.state = ok === true ? 'ok' : ok === false ? 'error' : 'pending';
  }
  async function probeRepositoryField(input) {
    if (!(input instanceof HTMLInputElement)) return;
    const provider = input.dataset.probeProvider;
    const repository = input.value.trim();
    const target = input.dataset.probeTarget;
    if (!provider) return;
    if (!repository) {
      await setProbeStatus(target, provider === 'gitlab' ? '可稍后在设置页补填。' : '填写 owner/repo，失焦后自动检查。', null);
      return;
    }
    await setProbeStatus(target, '正在检查访问…', null);
    try {
      const response = await fetch('/api/setup/probe-repository', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ provider, repository }),
      });
      const result = await response.json();
      await setProbeStatus(target, result.detail || (result.ok ? '可访问' : '无法访问'), !!result.ok);
    } catch {
      await setProbeStatus(target, '暂时无法检查，请稍后重试。', false);
    }
  }
  async function probeRootField(input) {
    if (!(input instanceof HTMLInputElement)) return;
    const provider = input.dataset.rootProvider;
    const root = input.value.trim();
    const target = input.dataset.probeTarget;
    if (!provider) return;
    if (!root) {
      await setProbeStatus(target, provider === 'gitlab' ? '可稍后在设置页补填。' : '填写组织或用户名，失焦后统计可导入仓库数。', null);
      return;
    }
    await setProbeStatus(target, '正在扫描根目录…', null);
    try {
      const response = await fetch('/api/setup/scan-root', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ provider, root }),
      });
      const result = await response.json();
      if (!response.ok || result.ok === false) {
        await setProbeStatus(target, result.detail || result.error || '扫描失败', false);
        return;
      }
      const count = Array.isArray(result.repositories) ? result.repositories.length : 0;
      await setProbeStatus(target, result.detail || `发现 ${count} 个项目。`, true);
    } catch {
      await setProbeStatus(target, '暂时无法扫描，请稍后重试。', false);
    }
  }
  document.addEventListener('focusout', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.probeProvider) probeRepositoryField(target);
    if (target.dataset.rootProvider) probeRootField(target);
  });
  document.addEventListener('input', event => {
    if (event.target instanceof Element && event.target.closest('[data-api-form]')) hasDraft = true;
  });
  document.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches('[data-autosubmit]')) target.closest('form')?.requestSubmit();
    const question = target.closest('[data-question-form]');
    if (question && target.matches('input[name=choice]')) {
      updateChoices(question);
      hasDraft = true;
      if (target.value === 'C') $('[data-custom-decision] textarea', question)?.focus();
    }
  });
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-api-form]')) return;
    event.preventDefault();
    if (!form.reportValidity() || form.dataset.submitting === 'true') return;
    form.dataset.submitting = 'true';
    const errorBox = $('.form-error', form);
    if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
    const submit = event.submitter || $('button[type=submit]', form);
    const oldText = submit?.textContent;
    const submitWasDisabled = submit?.disabled;
    if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); }
    try {
      const response = await fetch(form.action, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: new URLSearchParams(new FormData(form)) });
      const contentType = response.headers.get('content-type') || '';
      const result = contentType.includes('application/json') ? await response.json() : {};
      if (!response.ok) {
        const detail = typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求未能完成（${response.status}），请重试。`;
        throw new Error(detail);
      }
      hasDraft = false;
      if (form.dataset.successUrl) { window.location.assign(form.dataset.successUrl); return; }
      const redirect = result.redirect || result.redirectTo;
      if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')) { window.location.assign(redirect); return; }
      const currentDialog = form.closest('dialog');
      if (currentDialog?.id === 'task-drawer' && activeTaskUrl) {
        await openTask(activeTaskUrl, null, true);
        toast(result.message || '已更新任务记录');
      } else {
        if (currentDialog) closeDialog(currentDialog);
        window.location.reload();
      }
    } catch (error) {
      const message = error.message || '暂时无法连接服务。你的输入仍然保留，请重试。';
      if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else toast(message);
    } finally {
      form.dataset.submitting = 'false';
      if (submit) { submit.disabled = Boolean(submitWasDisabled); submit.removeAttribute('aria-busy'); if (oldText && !submit.textContent) submit.textContent = oldText; }
    }
  });

  async function poll() {
    if (document.hidden || refreshing || hasDraft || document.querySelector('dialog[open]') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    try {
      const query = new URLSearchParams();
      if (document.body.dataset.project) query.set('project', document.body.dataset.project);
      const response = await fetch(`/api/state?${query}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (response.status === 401) { toast('会话已过期，请重新登录。'); return; }
      if (!response.ok) return;
      const state = await response.json();
      const fingerprint = JSON.stringify(state);
      if (pollFingerprint && pollFingerprint !== fingerprint) {
        refreshing = true;
        window.location.reload();
      }
      pollFingerprint = fingerprint;
    } catch { /* The current ledger remains visible; a later poll can recover. */ }
  }
  if (['workbench', 'task', 'activity'].includes(document.body.dataset.page)) {
    poll();
    setInterval(poll, 6000);
  }
  window.addEventListener('pageshow', () => { refreshing = false; });
})();
