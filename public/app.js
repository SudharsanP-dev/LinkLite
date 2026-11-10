(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const authCard = $('#auth-card');
  const authForm = $('#auth-form');
  const authError = $('#auth-error');
  const nameField = $('#name-field');
  const authName = $('#auth-name');
  const authEmail = $('#auth-email');
  const authPassword = $('#auth-password');
  const authSubmit = $('#auth-submit');
  const form = $('#shorten-form');
  const urlInput = $('#url');
  const aliasInput = $('#alias');
  const submitBtn = $('#submit');
  const formError = $('#form-error');
  const resultBox = $('#result');
  const resultLink = $('#result-link');
  const resultCopy = $('#result-copy');
  const resultNote = $('#result-note');
  const historyList = $('#history');
  const historyCount = $('#history-count');
  const emptyState = $('#empty');
  const toast = $('#toast');

  $('#host-prefix').textContent = `${location.host}/`;

  function makeUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const CLIENT_KEY = 'linklite.clientId';
  let pageClientId = null;
  function getClientId() {
    try {
      let id = localStorage.getItem(CLIENT_KEY);
      if (!id) {
        id = makeUuid();
        localStorage.setItem(CLIENT_KEY, id);
      }
      return id;
    } catch {
      pageClientId = pageClientId || makeUuid();
      return pageClientId;
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': getClientId(),
        ...(options.headers || {}),
      },
    });
    if (response.status === 204) return null;
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* An empty response body is valid for some endpoints. */
    }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status}).`);
    return data;
  }

  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'sr-copy';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      area.remove();
      return copied;
    }
  }

  async function handleCopy(button, text) {
    const original = button.textContent;
    if (await copyText(text)) {
      button.textContent = 'Copied!';
      showToast('Link copied to clipboard');
      setTimeout(() => { button.textContent = original; }, 1400);
    } else {
      showToast('Could not copy. Select the link and copy it manually.');
    }
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? 'Recently'
      : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString();
  }

  function setFormError(element, message = '') {
    element.textContent = message;
  }

  let currentUser = null;
  let guestMode = false;
  let adminView = 'users';

  function updateAccountUI() {
    const showWorkspace = Boolean(currentUser) || guestMode;
    authCard.hidden = Boolean(currentUser) || guestMode;
    $('#welcome').hidden = !showWorkspace;
    $('#dashboard-stats').hidden = !showWorkspace;
    $('.workspace-grid').hidden = !showWorkspace;
    $('#account-actions').hidden = !currentUser;
    $('#profile-toggle').hidden = !currentUser;
    $('#admin-toggle').hidden = !currentUser || currentUser.role !== 'admin';
    $('#account-name').textContent = currentUser ? currentUser.name : '';
    $('#profile-panel').hidden = !currentUser;
    $('#welcome-title').textContent = currentUser
      ? `Welcome back, ${currentUser.name.split(/\s+/)[0]}.`
      : guestMode
        ? 'Short links, without the extra steps.'
        : 'Good links make a difference.';

    if (currentUser) {
      $('#profile-name').textContent = currentUser.name;
      $('#profile-email').textContent = currentUser.email;
      $('#profile-avatar').textContent = currentUser.name.trim().charAt(0).toUpperCase() || 'L';
      $('#profile-name-input').value = currentUser.name;
      $('#profile-email-input').value = currentUser.email;
    }
    if (!currentUser || currentUser.role !== 'admin') {
      $('#admin-panel').hidden = true;
      $('#admin-toggle').textContent = 'Admin';
    }
  }

  function showResult(link) {
    resultLink.textContent = link.shortUrl;
    resultLink.href = link.shortUrl;
    resultCopy.onclick = () => handleCopy(resultCopy, link.shortUrl);
    const saved = link.originalUrl.length - link.shortUrl.length;
    resultNote.textContent = saved > 0
      ? `A shorter share link, saving ${saved.toLocaleString()} characters.`
      : 'Your link is ready to share and track.';
    resultBox.hidden = false;
  }

  function buildLinkRow(link) {
    const item = document.createElement('li');
    item.className = 'link-row';

    const info = document.createElement('div');
    info.className = 'link-info';
    const short = document.createElement('a');
    short.className = 'link-short';
    short.href = link.shortUrl;
    short.target = '_blank';
    short.rel = 'noopener';
    short.textContent = link.shortUrl.replace(/^https?:\/\//, '');
    const destination = document.createElement('p');
    destination.className = 'link-destination';
    destination.title = link.originalUrl;
    destination.textContent = link.originalUrl;
    const date = document.createElement('span');
    date.className = 'link-date';
    date.textContent = `Created ${formatDate(link.createdAt)}`;
    info.append(short, destination, date);

    const clicks = document.createElement('div');
    clicks.className = 'link-clicks';
    const clickValue = document.createElement('strong');
    clickValue.textContent = formatCount(link.clicks);
    const clickLabel = document.createElement('span');
    clickLabel.textContent = Number(link.clicks) === 1 ? 'click' : 'clicks';
    clicks.append(clickValue, clickLabel);

    const actions = document.createElement('div');
    actions.className = 'link-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-outline btn-small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => handleCopy(copy, link.shortUrl));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button danger-action';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Delete ${link.shortUrl}`);
    remove.addEventListener('click', () => deleteLink(link, remove));
    actions.append(copy, remove);
    item.append(info, clicks, actions);
    return item;
  }

  let linkSnapshot = '';
  async function loadHistory(force = false) {
    try {
      const search = $('#link-search').value.trim();
      const query = search ? `?search=${encodeURIComponent(search)}` : '';
      const links = await api(`/api/urls${query}`);
      const snapshot = JSON.stringify(links);
      if (force || snapshot !== linkSnapshot) {
        linkSnapshot = snapshot;
        historyList.replaceChildren(...links.map(buildLinkRow));
        emptyState.hidden = links.length > 0;
        historyCount.textContent = links.length ? formatCount(links.length) : '';
      }
    } catch (error) {
      if (error.message === 'Sign in to continue.') showToast('Your session expired. Please sign in again.');
      else if (force) showToast(error.message);
    }
  }

  async function loadSummary() {
    try {
      const summary = await api('/api/urls/summary');
      $('#stat-links').textContent = formatCount(summary.links);
      $('#stat-clicks').textContent = formatCount(summary.clicks);
    } catch {
      $('#stat-links').textContent = '—';
      $('#stat-clicks').textContent = '—';
    }
  }

  async function deleteLink(link, button) {
    if (!window.confirm(`Delete ${link.shortUrl}?\n\nAnyone who opens this link afterwards will see a not found page.`)) return;
    button.disabled = true;
    try {
      await api(`/api/urls/${link.id}`, { method: 'DELETE' });
      if (resultLink.href === link.shortUrl) resultBox.hidden = true;
      showToast('Link deleted');
      await Promise.all([loadHistory(true), loadSummary()]);
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  }

  function setAuthMode(mode) {
    const registering = mode === 'register';
    $('#login-tab').classList.toggle('active', !registering);
    $('#register-tab').classList.toggle('active', registering);
    $('#login-tab').setAttribute('aria-selected', String(!registering));
    $('#register-tab').setAttribute('aria-selected', String(registering));
    nameField.hidden = !registering;
    $('#password-hint').hidden = !registering;
    authSubmit.textContent = registering ? 'Create account' : 'Sign in';
    authPassword.autocomplete = registering ? 'new-password' : 'current-password';
    authPassword.minLength = registering ? 10 : 1;
    setFormError(authError);
  }

  async function enterWorkspace(user) {
    currentUser = user;
    guestMode = false;
    updateAccountUI();
    await Promise.all([loadHistory(true), loadSummary()]);
    if (user.role === 'admin') loadAdminSummary();
  }

  $('#login-tab').addEventListener('click', () => setAuthMode('login'));
  $('#register-tab').addEventListener('click', () => setAuthMode('register'));

  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError(authError);
    authSubmit.disabled = true;
    const registering = !nameField.hidden;
    authSubmit.textContent = registering ? 'Creating account…' : 'Signing in…';
    const body = { email: authEmail.value.trim(), password: authPassword.value };
    if (registering) body.name = authName.value.trim();
    try {
      const result = await api(`/api/auth/${registering ? 'register' : 'login'}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      authForm.reset();
      setAuthMode('login');
      await enterWorkspace(result.user);
      showToast(registering ? 'Your account is ready. Welcome to LinkLite!' : 'You are signed in.');
    } catch (error) {
      setFormError(authError, error.message);
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = registering ? 'Create account' : 'Sign in';
    }
  });

  $('#guest-button').addEventListener('click', async () => {
    guestMode = true;
    updateAccountUI();
    await Promise.all([loadHistory(true), loadSummary()]);
    showToast('You are browsing as a guest. Sign in to save links to your account.');
  });

  $('#logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      showToast(error.message);
      return;
    }
    currentUser = null;
    guestMode = false;
    $('#profile-panel').hidden = true;
    updateAccountUI();
    await Promise.all([loadHistory(true), loadSummary()]);
    showToast('You have signed out.');
  });

  $('#profile-toggle').addEventListener('click', () => {
    $('#profile-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#profile-name-input').focus({ preventScroll: true });
  });

  $('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError($('#profile-error'));
    try {
      const result = await api('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('#profile-name-input').value.trim(),
          email: $('#profile-email-input').value.trim(),
        }),
      });
      currentUser = result.user;
      updateAccountUI();
      showToast('Profile updated.');
    } catch (error) {
      setFormError($('#profile-error'), error.message);
    }
  });

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError($('#password-error'));
    const values = new FormData(event.currentTarget);
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: values.get('currentPassword'),
          newPassword: values.get('newPassword'),
        }),
      });
      currentUser = null;
      guestMode = false;
      event.currentTarget.reset();
      updateAccountUI();
      showToast('Password changed. Sign in again with your new password.');
    } catch (error) {
      setFormError($('#password-error'), error.message);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError(formError);
    submitBtn.disabled = true;
    submitBtn.querySelector('span').textContent = 'Creating link…';
    try {
      const body = { url: urlInput.value };
      const alias = aliasInput.value.trim();
      if (alias) body.alias = alias;
      const link = await api('/api/urls', { method: 'POST', body: JSON.stringify(body) });
      showResult(link);
      urlInput.value = '';
      aliasInput.value = '';
      await Promise.all([loadHistory(true), loadSummary()]);
    } catch (error) {
      setFormError(formError, error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.querySelector('span').textContent = 'Shorten link';
    }
  });

  let linkSearchTimer;
  $('#link-search').addEventListener('input', () => {
    clearTimeout(linkSearchTimer);
    linkSearchTimer = setTimeout(() => loadHistory(true), 250);
  });

  async function loadAdminSummary() {
    try {
      const summary = await api('/api/admin/summary');
      $('#admin-users-total').textContent = formatCount(summary.users);
      $('#admin-links-total').textContent = formatCount(summary.links);
      $('#admin-clicks-total').textContent = formatCount(summary.clicks);
      if (!$('#admin-panel').hidden) await loadAdminTable();
    } catch (error) {
      setFormError($('#admin-error'), error.message);
    }
  }

  function tableCell(value, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value == null ? '—' : String(value);
    return cell;
  }

  async function loadAdminTable() {
    setFormError($('#admin-error'));
    const search = $('#admin-search').value.trim();
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const head = $('#admin-table-head');
    const body = $('#admin-table-body');
    head.replaceChildren();
    body.replaceChildren();

    if (adminView === 'users') {
      const result = await api(`/api/admin/users${query}`);
      const header = document.createElement('tr');
      ['Name', 'Email', 'Role', 'Joined', 'Status', 'Action'].forEach((label) => {
        const cell = document.createElement('th');
        cell.textContent = label;
        header.appendChild(cell);
      });
      head.appendChild(header);
      for (const user of result) {
        const row = document.createElement('tr');
        row.append(
          tableCell(user.display_name),
          tableCell(user.email),
          tableCell(user.role, 'role-cell'),
          tableCell(formatDate(user.created_at)),
          tableCell(user.is_active ? 'Active' : 'Disabled', user.is_active ? 'active-cell' : 'disabled-cell')
        );
        const actionCell = document.createElement('td');
        if (user.role === 'user') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-outline btn-small';
          button.textContent = user.is_active ? 'Disable' : 'Enable';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await api(`/api/admin/users/${user.id}/status`, {
                method: 'PATCH',
                body: JSON.stringify({ isActive: !user.is_active }),
              });
              await Promise.all([loadAdminTable(), loadAdminSummary()]);
            } catch (error) {
              setFormError($('#admin-error'), error.message);
              button.disabled = false;
            }
          });
          actionCell.appendChild(button);
        } else {
          actionCell.textContent = 'Protected';
        }
        row.appendChild(actionCell);
        body.appendChild(row);
      }
      if (!result.length) body.appendChild(emptyTableRow('No users match your search.', 6));
    } else {
      const result = await api(`/api/admin/links${query}`);
      const header = document.createElement('tr');
      ['Short link', 'Destination', 'Owner', 'Clicks', 'Created', 'Action'].forEach((label) => {
        const cell = document.createElement('th');
        cell.textContent = label;
        header.appendChild(cell);
      });
      head.appendChild(header);
      for (const link of result) {
        const row = document.createElement('tr');
        const linkCell = document.createElement('td');
        const anchor = document.createElement('a');
        anchor.href = link.shortUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        anchor.textContent = link.shortUrl.replace(/^https?:\/\//, '');
        linkCell.appendChild(anchor);
        row.append(linkCell, tableCell(link.originalUrl, 'truncate-cell'), tableCell(link.ownerEmail || 'Guest'), tableCell(formatCount(link.clicks)), tableCell(formatDate(link.createdAt)));
        const actionCell = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-outline btn-small';
        button.textContent = 'Remove';
        button.addEventListener('click', async () => {
          if (!window.confirm(`Remove ${link.shortUrl}?`)) return;
          button.disabled = true;
          try {
            await api(`/api/admin/links/${link.id}`, { method: 'DELETE' });
            await Promise.all([loadAdminTable(), loadAdminSummary()]);
          } catch (error) {
            setFormError($('#admin-error'), error.message);
            button.disabled = false;
          }
        });
        actionCell.appendChild(button);
        row.appendChild(actionCell);
        body.appendChild(row);
      }
      if (!result.length) body.appendChild(emptyTableRow('No links match your search.', 6));
    }
  }

  function emptyTableRow(message, columns) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns;
    cell.className = 'empty-table';
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  $('#admin-toggle').addEventListener('click', async () => {
    const panel = $('#admin-panel');
    panel.hidden = !panel.hidden;
    $('#admin-toggle').textContent = panel.hidden ? 'Admin' : 'Close admin';
    if (!panel.hidden) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await loadAdminSummary();
    }
  });

  $('#admin-users-tab').addEventListener('click', async () => {
    adminView = 'users';
    $('#admin-users-tab').classList.add('active');
    $('#admin-links-tab').classList.remove('active');
    await loadAdminTable();
  });
  $('#admin-links-tab').addEventListener('click', async () => {
    adminView = 'links';
    $('#admin-links-tab').classList.add('active');
    $('#admin-users-tab').classList.remove('active');
    await loadAdminTable();
  });

  let adminSearchTimer;
  $('#admin-search').addEventListener('input', () => {
    clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(() => loadAdminTable().catch((error) => setFormError($('#admin-error'), error.message)), 250);
  });

  async function initialize() {
    try {
      const result = await api('/api/auth/me');
      if (result.user) {
        currentUser = result.user;
        updateAccountUI();
        if (currentUser.role === 'admin') loadAdminSummary();
      }
    } catch (error) {
      showToast(error.message);
    }
    updateAccountUI();
    await Promise.all([loadHistory(true), loadSummary()]);
  }

  initialize();
  setInterval(() => {
    if (!document.hidden) {
      loadHistory();
      loadSummary();
    }
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      loadHistory();
      loadSummary();
    }
  });
})();
