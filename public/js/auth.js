// Страница /auth: вход и регистрация через Supabase.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const panes = document.querySelectorAll('.auth-pane');
  const show = (view) => panes.forEach((p) => { p.hidden = p.dataset.view !== view; });

  const urlParams = new URLSearchParams(location.search);
  const nextParam = urlParams.get('next') || '/signals';
  const safeNext = /^\/[^/]/.test(nextParam) ? nextParam : '/signals';
  const initialMode = urlParams.get('mode') === 'signup' ? 'signup' : 'signin';

  // Переводы ошибок Supabase на русский
  const ERR_MAP = {
    'Invalid login credentials': 'Неверный email или пароль',
    'Email not confirmed': 'Email не подтверждён — проверьте почту',
    'User already registered': 'Аккаунт с этим email уже существует',
    'Password should be at least 6 characters': 'Пароль должен быть не короче 6 символов',
    'Signup requires a valid password': 'Введите пароль',
    'For security purposes, you can only request this once every 60 seconds':
      'Слишком часто. Подождите минуту и попробуйте снова.',
    'Unable to validate email address: invalid format': 'Неверный формат email',
  };
  function friendlyError(err) {
    if (!err) return 'Что-то пошло не так';
    const msg = typeof err === 'string' ? err : (err.message || String(err));
    return ERR_MAP[msg] || msg;
  }

  let mode = 'signin'; // 'signin' | 'signup'
  const form = $('auth-form');
  const resetForm = $('reset-form');
  const msgEl = $('auth-msg');
  const resetMsgEl = $('reset-msg');
  const submitBtn = $('auth-submit');
  const submitText = submitBtn.querySelector('.auth-submit-text');
  const submitSpin = submitBtn.querySelector('.auth-spinner');
  const resetSpin = resetForm.querySelector('.auth-spinner');
  const resetText = resetForm.querySelector('.auth-submit-text');
  const nameField = $('auth-name-field');
  const tosField = $('auth-tos');
  const switchQ = $('auth-switch-q');
  const switchLink = $('auth-switch');

  function setMode(next) {
    mode = next;
    document.querySelectorAll('#auth-tabs button').forEach((b) => {
      const on = b.dataset.tab === next;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (next === 'signin') {
      $('auth-title').textContent = 'С возвращением';
      $('auth-sub').textContent = 'Войдите, чтобы открыть терминал и получить доступ к рынкам.';
      submitText.textContent = 'Войти';
      $('auth-pw-label').textContent = 'Пароль';
      form.password.autocomplete = 'current-password';
      nameField.hidden = true;
      tosField.hidden = true;
      $('auth-forgot').hidden = false;
      switchQ.textContent = 'Ещё нет аккаунта?';
      switchLink.textContent = 'Создать';
    } else {
      $('auth-title').textContent = 'Создать аккаунт';
      $('auth-sub').textContent = 'Регистрация занимает меньше минуты. Email подтверждается ссылкой.';
      submitText.textContent = 'Создать аккаунт';
      $('auth-pw-label').textContent = 'Пароль (минимум 6 символов)';
      form.password.autocomplete = 'new-password';
      nameField.hidden = false;
      tosField.hidden = false;
      $('auth-forgot').hidden = true;
      switchQ.textContent = 'Уже есть аккаунт?';
      switchLink.textContent = 'Войти';
    }
    hideMsg();
  }

  function hideMsg() { msgEl.hidden = true; msgEl.className = 'auth-msg'; msgEl.textContent = ''; }
  function flashMsg(el, text, kind) {
    el.hidden = false;
    el.className = 'auth-msg ' + (kind || '');
    el.textContent = text;
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitSpin.hidden = !busy;
    submitText.hidden = busy;
  }
  function setResetBusy(busy) {
    resetForm.querySelector('button[type="submit"]').disabled = busy;
    resetSpin.hidden = !busy;
    resetText.hidden = busy;
  }

  // Переключение табов
  $('auth-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) setMode(b.dataset.tab);
  });
  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    setMode(mode === 'signin' ? 'signup' : 'signin');
  });

  // Показ/скрытие пароля
  $('auth-pw-toggle').addEventListener('click', () => {
    const input = form.password;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('auth-pw-toggle').querySelector('.eye-show').hidden = show;
    $('auth-pw-toggle').querySelector('.eye-hide').hidden = !show;
  });

  // Переход на экран восстановления
  $('auth-forgot').addEventListener('click', (e) => {
    e.preventDefault();
    show('reset');
    const email = form.email.value;
    if (email) resetForm.email.value = email;
    resetForm.email.focus();
  });
  $('reset-back').addEventListener('click', (e) => { e.preventDefault(); show('form'); });
  $('sent-back').addEventListener('click', (e) => { e.preventDefault(); show('form'); });

  // Обработка форм
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg();
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) return flashMsg(msgEl, 'Заполните email и пароль', 'err');

    const sb = await IH.getSupabase();
    if (!sb) { show('offline'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.session) {
          flashMsg(msgEl, 'Вход выполнен — перенаправляем…', 'ok');
          setTimeout(() => location.replace(safeNext), 300);
        }
      } else {
        if (!form.querySelector('.auth-check input').checked) {
          setBusy(false);
          return flashMsg(msgEl, 'Нужно согласие с условиями', 'err');
        }
        const name = (form.name && form.name.value.trim()) || '';
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: {
            data: name ? { full_name: name } : undefined,
            emailRedirectTo: location.origin + '/auth?next=' + encodeURIComponent(safeNext),
          },
        });
        if (error) throw error;
        if (data.session) {
          // Email-подтверждение выключено в проекте — заходим сразу
          flashMsg(msgEl, 'Аккаунт создан — перенаправляем…', 'ok');
          setTimeout(() => location.replace(safeNext), 300);
        } else {
          $('sent-email').textContent = email;
          show('sent');
        }
      }
    } catch (err) {
      flashMsg(msgEl, friendlyError(err), 'err');
    } finally {
      setBusy(false);
    }
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = resetForm.email.value.trim();
    if (!email) return flashMsg(resetMsgEl, 'Укажите email', 'err');
    const sb = await IH.getSupabase();
    if (!sb) { show('offline'); return; }
    setResetBusy(true);
    try {
      const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin + '/auth',
      });
      if (error) throw error;
      flashMsg(resetMsgEl, 'Если такой email зарегистрирован — письмо отправлено.', 'ok');
    } catch (err) {
      flashMsg(resetMsgEl, friendlyError(err), 'err');
    } finally {
      setResetBusy(false);
    }
  });

  // Инициализация: если уже авторизован — сразу редирект; если Supabase не настроен — показать баннер.
  (async () => {
    setMode(initialMode);
    const sb = await IH.getSupabase();
    if (!sb) { show('offline'); return; }
    const { data } = await sb.auth.getSession();
    if (data.session) {
      // Пришёл по /auth, уже залогинен — отправляем дальше
      location.replace(safeNext);
    }
  })();
})();
