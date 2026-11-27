/* Admin page: users and the shared masters. Talks only to /api/auth and /api/admin. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, text, attrs) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    return e;
  };
  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-flow-request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('Request failed (' + r.status + ').')); e.status = r.status; e.code = j.code; throw e; }
        return j;
      });
    });
  }
  function show(id, on) { $(id).classList.toggle('hidden', !on); }
  function say(id, text, good) { $(id).textContent = text || ''; $(id).className = 'msg ' + (good ? 'good' : 'bad'); }

  var meta = null, me = null;
  var VIEWS = {
    users: { title: 'Users', cols: [['username', 'Login'], ['name', 'Name'], ['role', 'Role'], ['psName', 'Purchase System name'], ['active', 'Active'], ['lastLogin', 'Last login']] },
    items: { title: 'Items (PM / RM)' }, fg: { title: 'Finished goods' }, vendors: { title: 'Vendors' }
  };
  var state = { view: 'users', page: 0, q: '', rows: [], total: 0, editing: null };

  /* ── login ── */
  function start() {
    api('GET', '/api/auth/me').then(function (j) { signedIn(j.user); }, function () { loginScreen(false); });
  }
  function loginScreen(change) {
    show('app', false); show('login', true); show('logout', !!change);
    show('loginForm', !change); show('changeForm', change);
    $('loginTitle').textContent = change ? 'New password' : 'Log in';
  }
  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    api('POST', '/api/auth/login', { username: f.username.value.trim(), password: f.password.value })
      .then(function (j) { f.reset(); say('loginMsg', ''); signedIn(j.user); }, function (e) { say('loginMsg', e.message); });
  });
  $('changeForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target;
    api('POST', '/api/auth/change-password', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value })
      .then(function (j) { f.reset(); say('loginMsg', ''); signedIn(j.user); }, function (e) { say('loginMsg', e.message); });
  });
  $('logout').addEventListener('click', function () { api('POST', '/api/auth/logout').then(function () { location.reload(); }); });

  function signedIn(user) {
    me = user;
    $('who').textContent = (user.name || user.username) + ' · ' + user.label;
    show('logout', true);
    if (user.mustChangePassword) return loginScreen(true);
    if (user.role !== 'admin') { loginScreen(false); show('loginForm', false); say('loginMsg', 'This page is for the admin login only.'); return; }
    show('login', false); show('app', true);
    api('GET', '/api/admin/meta').then(function (m) { meta = m; tabs(); load(); });
  }

  /* ── list ── */
  function tabs() {
    var nav = $('tabs'); nav.textContent = '';
    Object.keys(VIEWS).forEach(function (k) {
      var b = el('button', VIEWS[k].title, { type: 'button' });
      if (k === state.view) b.className = 'on';
      b.addEventListener('click', function () { state.view = k; state.page = 0; state.q = ''; $('search').value = ''; closeEditor(); tabs(); load(); });
      nav.appendChild(b);
    });
  }
  function columns() {
    if (state.view === 'users') return VIEWS.users.cols;
    return meta.masters[state.view].slice(0, 6).map(function (f) { return [f.col, f.label]; });
  }
  function load() {
    var path = state.view === 'users' ? '/api/admin/users'
      : '/api/admin/' + state.view + '?q=' + encodeURIComponent(state.q) + '&page=' + state.page;
    api('GET', path).then(function (j) {
      if (state.view === 'users') {
        var q = state.q.toLowerCase();
        state.rows = j.users.filter(function (u) { return !q || JSON.stringify(u).toLowerCase().indexOf(q) >= 0; });
        state.total = state.rows.length;
      } else { state.rows = j.rows; state.total = j.total; }
      render();
    }, function (e) { if (e.status === 401) loginScreen(false); else alert(e.message); });
  }
  function render() {
    var cols = columns(), head = $('head'), body = $('body');
    head.textContent = ''; body.textContent = '';
    var tr = el('tr'); cols.forEach(function (c) { tr.appendChild(el('th', c[1])); }); head.appendChild(tr);
    state.rows.forEach(function (r) {
      var row = el('tr');
      cols.forEach(function (c) {
        var v = r[c[0]];
        if (c[0] === 'active') v = (v === true || v === '1') ? 'yes' : 'no';
        row.appendChild(el('td', v));
      });
      row.addEventListener('click', function () { openEditor(r); });
      body.appendChild(row);
    });
    var paged = state.view !== 'users';
    $('count').textContent = state.total + ' found' + (paged && state.total > 100 ? ' · page ' + (state.page + 1) + ' of ' + Math.ceil(state.total / 100) : '');
    show('prev', paged && state.page > 0); show('next', paged && (state.page + 1) * 100 < state.total);
  }
  var timer = null;
  $('search').addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { state.q = $('search').value.trim(); state.page = 0; load(); }, 250);
  });
  $('prev').addEventListener('click', function () { state.page--; load(); });
  $('next').addEventListener('click', function () { state.page++; load(); });
  $('add').addEventListener('click', function () { openEditor(null); });
  $('cancel').addEventListener('click', closeEditor);

  /* ── editor ── */
  function closeEditor() { state.editing = null; show('editor', false); }
  function input(name, label, value, opts) {
    opts = opts || {};
    var lab = el('label', label), f;
    if (opts.options) {
      f = el('select', null, { name: name });
      if (!opts.required) f.appendChild(el('option', '', { value: '' }));
      opts.options.forEach(function (o) { var op = el('option', o.label || o, { value: o.value || o }); f.appendChild(op); });
    } else {
      f = el(opts.max > 200 ? 'textarea' : 'input', null, { name: name });
      if (opts.type) f.type = opts.type;
      if (opts.max) f.maxLength = opts.max;
    }
    f.value = value === undefined || value === null ? '' : String(value);
    if (opts.readOnly) f.readOnly = true;
    if (opts.required) f.required = true;
    lab.appendChild(f);
    $('fields').appendChild(lab);
    return f;
  }
  function openEditor(r) {
    state.editing = r;
    $('fields').textContent = ''; $('extra').textContent = ''; say('editMsg', '');
    show('rates', false);
    var isNew = !r;
    $('editTitle').textContent = (isNew ? 'Add to ' : 'Edit · ') + VIEWS[state.view].title;
    if (state.view === 'users') userFields(r || {}, isNew);
    else meta.masters[state.view].forEach(function (f) {
      var box = input(f.col, f.label + (f.required ? ' *' : ''), r ? r[f.col] : (f.col === 'active' ? '1' : ''), { options: f.options, max: f.max, required: f.required, readOnly: !isNew && f.key });
      if (f.photo) photoPreview(box);
    });
    if (state.view === 'items' && !isNew) loadRates(r.code);
    show('editor', true);
    $('editor').scrollIntoView({ behavior: 'smooth' });
  }
  /* item photo: our stored file (F…) or a Google Drive file (must be shared "anyone with the link") */
  function photoUrl(v) {
    v = String(v || '').trim();
    if (/^F[0-9a-f]{18}$/.test(v)) return '/api/ps/file/' + v;
    var m = /\/d\/([-\w]{20,})/.exec(v) || /[?&]id=([-\w]{20,})/.exec(v) || /^([-\w]{20,})$/.exec(v);
    return m ? 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(m[1]) + '&sz=w400' : '';
  }
  function photoPreview(box) {
    var img = el('img', null, { alt: 'Item photo', referrerpolicy: 'no-referrer' });
    img.style.cssText = 'max-width:200px;max-height:200px;margin-top:6px;border:1px solid var(--line);border-radius:6px;object-fit:contain';
    var note = el('span', '', { class: 'mute' });
    var show = function () {
      var u = photoUrl(box.value);
      img.classList.toggle('hidden', !u);
      note.textContent = box.value.trim() && !u ? 'not a Google Drive link' : '';
      if (u) img.src = u;
    };
    img.addEventListener('error', function () { img.classList.add('hidden'); note.textContent = 'photo not visible — is the Drive file shared "anyone with the link"?'; });
    box.addEventListener('input', show);
    box.parentNode.appendChild(img); box.parentNode.appendChild(note);
    show();
  }
  function userFields(u, isNew) {
    var login = input('username', 'Login *', u.username, { required: true, readOnly: !isNew, max: 40 });
    if (isNew) {
      var hint = el('span', '', { class: 'mute' }); login.parentNode.appendChild(hint);
      login.addEventListener('input', function () {
        var v = login.value.trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,40}$/.test(v)) { hint.textContent = '3–40 of a-z 0-9 . _ -'; hint.className = 'bad'; return; }
        api('GET', '/api/admin/users/check?username=' + encodeURIComponent(v)).then(function (j) {
          if (login.value.trim().toLowerCase() !== v) return;
          hint.textContent = j.taken ? 'taken' : 'available'; hint.className = j.taken ? 'bad' : 'good';
        });
      });
    }
    input('name', 'Name (the person) *', u.name, { required: true, max: 80 });
    input('role', 'Role *', u.role || 'purchase', { required: true, options: meta.roles.map(function (x) { return { value: x.role, label: x.label }; }) });
    input('label', 'Label (the job) *', u.label, { required: true, max: 80 });
    if (isNew) input('password', 'Starting password * (they change it at first login)', '', { required: true, type: 'password', max: 128 });
    input('psName', 'Purchase System name', u.psName, { max: 120 });
    input('psAccess', 'Purchase System steps (ALL or STEP 1,STEP 2 …)', u.psAccess, { max: 120 });
    input('psTypes', 'Purchase System item types (Chemical / Other)', u.psTypes, { max: 120 });
    input('psEmail', 'Email', u.psEmail, { max: 255 });
    if (!isNew) {
      var act = el('button', u.active ? 'Disable login' : 'Enable login', { type: 'button' });
      act.addEventListener('click', function () {
        api('POST', '/api/admin/users/' + encodeURIComponent(u.username) + '/active', { active: !u.active })
          .then(function () { closeEditor(); load(); }, function (e) { say('editMsg', e.message); });
      });
      var pw = el('button', 'New starting password', { type: 'button' });
      pw.addEventListener('click', function () {
        var p = prompt('New starting password for ' + u.username + ' (they must change it at next login):');
        if (!p) return;
        api('POST', '/api/admin/users/' + encodeURIComponent(u.username) + '/password', { password: p })
          .then(function () { say('editMsg', 'Password set. ' + u.username + ' was signed out.', true); }, function (e) { say('editMsg', e.message); });
      });
      $('extra').appendChild(act); $('extra').appendChild(document.createTextNode(' ')); $('extra').appendChild(pw);
    }
  }
  $('editForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var data = {}, r = state.editing;
    Array.prototype.forEach.call(ev.target.elements, function (f) { if (f.name && !f.readOnly) data[f.name] = f.value; });
    var call;
    if (state.view === 'users') {
      call = r ? api('PUT', '/api/admin/users/' + encodeURIComponent(r.username), data) : api('POST', '/api/admin/users', data);
    } else {
      call = r ? api('PUT', '/api/admin/' + state.view + '/' + encodeURIComponent(r._key), data) : api('POST', '/api/admin/' + state.view, data);
    }
    call.then(function () { say('editMsg', 'Saved.', true); load(); if (!r) closeEditor(); }, function (e) { say('editMsg', e.message); });
  });

  /* ── item ↔ vendor ── */
  var vendorHits = {};
  function loadRates(code) {
    show('rates', true);
    api('GET', '/api/admin/rates?code=' + encodeURIComponent(code)).then(function (j) {
      var body = $('rateBody'); body.textContent = '';
      j.rates.forEach(function (x) {
        var tr = el('tr');
        [x.vendor, x.vendorCode, x.vendorItem, x.rate || '—'].forEach(function (v) { tr.appendChild(el('td', v)); });
        var td = el('td'), rm = el('button', 'Remove', { type: 'button' });
        rm.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!confirm('Remove ' + x.vendor + ' for this item?')) return;
          api('DELETE', '/api/admin/rates/' + x.supplierId + '/' + encodeURIComponent(code)).then(function () { loadRates(code); }, function (e) { say('editMsg', e.message); });
        });
        td.appendChild(rm); tr.appendChild(td); body.appendChild(tr);
      });
    });
  }
  $('rateForm').vendor.addEventListener('input', function (ev) {
    var v = ev.target.value.trim();
    if (v.length < 2 || vendorHits[v]) return;
    api('GET', '/api/admin/vendors?q=' + encodeURIComponent(v)).then(function (j) {
      var list = $('vendorList'); list.textContent = '';
      j.rows.slice(0, 30).forEach(function (s) {
        var label = s.name + (s.vendor_code ? ' · ' + s.vendor_code : '');
        vendorHits[label] = Number(s._key);
        list.appendChild(el('option', null, { value: label }));
      });
    });
  });
  $('rateForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = ev.target, id = vendorHits[f.vendor.value.trim()], code = state.editing && state.editing.code;
    if (!id) return say('editMsg', 'Pick the vendor from the list.');
    api('PUT', '/api/admin/rates', { code: code, supplierId: id, rate: f.rate.value.trim(), vendorItem: f.vendorItem.value.trim() })
      .then(function () { f.reset(); say('editMsg', 'Vendor saved.', true); loadRates(code); }, function (e) { say('editMsg', e.message); });
  });

  start();
})();
