/* Salon Vine multi-tenant staff portal — client.
   URL scheme: /p/<slug>, /p/<slug>/welcome?invite=..&email=.., /p/<slug>/reset?code=..&email=..
   (200 rewrites keep those URLs in the address bar, so slug + view are parsed
   from location.pathname first, with ?s= / ?view= as fallbacks.) */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.classList.toggle('hidden', !on); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function msg(id, text, ok) {
    var m = $(id);
    if (!m) return;
    m.textContent = text;
    m.className = 'msg ' + (ok ? 'ok' : 'err');
    m.style.display = 'block';
  }
  function hideMsg(id) { var m = $(id); if (m) m.style.display = 'none'; }

  /* ---------------- slug + view from URL ---------------- */
  var qs = new URLSearchParams(location.search);
  var slug = null, view = null, pm = location.pathname.match(/^\/p\/([^\/]+)(?:\/(welcome|reset))?\/?$/);
  if (pm) { slug = pm[1]; view = pm[2] || null; }
  if (!slug) slug = qs.get('s');
  if (!view) view = qs.get('view');
  slug = (slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) slug = null;

  var inviteCode = qs.get('invite') || '';
  var resetCode = qs.get('code') || '';
  var urlEmail = qs.get('email') || '';

  var me = null;
  var salon = { name: 'Salon Vine', accent: '', plan: '' };

  /* ---------------- API helper (same-origin, cookie session) ---------------- */
  function api(path, method, body) {
    return fetch('/api/' + path, {
      method: method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { status: r.status, data: j };
      });
    }).catch(function () {
      return { status: 0, data: { error: 'No connection — check your signal and try again.' } };
    });
  }

  /* ---------------- theming ---------------- */
  function darken(hex, amt) {
    var m2 = String(hex).match(/^#([0-9a-f]{6})$/i);
    if (!m2) return hex;
    var n = parseInt(m2[1], 16);
    var r = Math.max(0, (n >> 16 & 255) - amt), g = Math.max(0, (n >> 8 & 255) - amt), b = Math.max(0, (n & 255) - amt);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
  function applySalon(cfg) {
    if (!cfg) return;
    salon = cfg;
    var name = cfg.name || slug;
    document.title = name + ' — Staff Portal';
    $('topLogo').innerHTML = esc(name) + ' <span class="badge">Portal</span>';
    var wt = $('welcomeTitle'); if (wt) wt.textContent = 'Welcome to ' + name;
    var lt = $('loginTitle'); if (lt) lt.textContent = name + ' — Staff Sign In';
    if (/^#[0-9a-f]{6}$/i.test(cfg.accent || '')) {
      document.documentElement.style.setProperty('--accent', cfg.accent);
      document.documentElement.style.setProperty('--accent-dark', darken(cfg.accent, 26));
      var tc = document.querySelector('meta[name="theme-color"]');
      if (tc) tc.setAttribute('content', cfg.accent);
    }
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = '/api/manifest?slug=' + encodeURIComponent(slug);
    document.head.appendChild(link);
  }

  /* ---------------- view switching ---------------- */
  var CARDS = ['noSalonCard', 'loginCard', 'welcomeCard', 'forgotCard', 'resetCard', 'app'];
  function showOnly(id) {
    CARDS.forEach(function (c) { show($(c), c === id); });
    show($('who'), id === 'app');
  }

  function showApp() {
    showOnly('app');
    /* Honesty banner: if a founder is inside this salon on a support session,
       the salon sees it the whole time. Never hide this. */
    if (me.impersonatedBy) {
      var bar = document.getElementById('impBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'impBar';
        bar.style.cssText = 'position:sticky;top:0;z-index:99;background:#8a2b2b;color:#fff;' +
          'padding:10px 14px;font-size:.85rem;line-height:1.4;text-align:center';
        document.body.insertBefore(bar, document.body.firstChild);
      }
      bar.textContent = 'Salon Vine support (' + me.impersonatedBy +
        ') is signed in to this account to help. This session ends automatically within the hour.';
    }
    $('whoName').textContent = me.name + (me.role === 'admin' ? ' · Owner' : '');
    show($('adminTab'), me.role === 'admin');
    loadBookings();
    if (me.role === 'admin') { loadTeam(); loadPayments(); }
    loadBilling();
    setupInstallCard();
  }

  function boot() {
    api('me').then(function (r) {
      if (r.status === 200 && r.data.ok && r.data.slug === slug) {
        me = r.data;
        showApp();
      } else {
        showOnly('loginCard');
      }
    });
  }

  /* ---------------- flows ---------------- */
  function doLogin() {
    hideMsg('loginMsg');
    var btn = $('loginBtn'); btn.disabled = true;
    api('login', 'POST', { slug: slug, email: $('li-email').value.trim(), password: $('li-pass').value })
      .then(function (r) {
        btn.disabled = false;
        if (r.data.ok) { me = { slug: slug, email: $('li-email').value.trim().toLowerCase(), role: r.data.role, name: r.data.name }; showApp(); }
        else msg('loginMsg', r.data.error || 'Sign-in failed.');
      });
  }

  function doWelcome() {
    hideMsg('welcomeMsg');
    var p1 = $('wl-pass').value, p2 = $('wl-pass2').value;
    if (p1.length < 8) return msg('welcomeMsg', 'Password needs at least 8 characters.');
    if (p1 !== p2) return msg('welcomeMsg', "Those passwords don't match.");
    var btn = $('welcomeBtn'); btn.disabled = true;
    api('set-password', 'POST', { slug: slug, email: $('wl-email').value.trim(), invite: inviteCode, password: p1 })
      .then(function (r) {
        btn.disabled = false;
        if (r.data.ok) {
          history.replaceState({}, '', '/p/' + slug);
          me = { slug: slug, email: $('wl-email').value.trim().toLowerCase(), role: r.data.role, name: r.data.name };
          showApp();
        } else msg('welcomeMsg', r.data.error || 'That link did not work.');
      });
  }

  function doForgot() {
    hideMsg('forgotMsg');
    var email = $('fg-email').value.trim();
    if (!email) return msg('forgotMsg', 'Enter your email first.');
    var btn = $('forgotBtn'); btn.disabled = true;
    api('forgot-password', 'POST', { slug: slug, email: email })
      .then(function (r) {
        btn.disabled = false;
        if (r.status === 0) return msg('forgotMsg', r.data.error);
        msg('forgotMsg', "If that email has an account here, a reset link is on its way. Check your inbox (and spam).", true);
      });
  }

  function doReset() {
    hideMsg('resetMsg');
    var p1 = $('rs-pass').value, p2 = $('rs-pass2').value;
    if (p1.length < 8) return msg('resetMsg', 'Password needs at least 8 characters.');
    if (p1 !== p2) return msg('resetMsg', "Those passwords don't match.");
    var btn = $('resetBtn'); btn.disabled = true;
    api('set-password', 'POST', { slug: slug, email: $('rs-email').value.trim(), invite: resetCode, password: p1 })
      .then(function (r) {
        btn.disabled = false;
        if (r.data.ok) {
          history.replaceState({}, '', '/p/' + slug);
          me = { slug: slug, email: $('rs-email').value.trim().toLowerCase(), role: r.data.role, name: r.data.name };
          showApp();
        } else msg('resetMsg', r.data.error || 'That link expired or was already used. Request a new one from the sign-in page.');
      });
  }

  /* ---------------- bookings ---------------- */
  function bkCard(b) {
    var d = document.createElement('div');
    d.className = 'bk';
    var status = String(b.status || 'new').toLowerCase();
    var phoneDigits = String(b.phone || '').replace(/[^\d+]/g, '');
    d.innerHTML =
      '<div>' +
        '<div class="when">' + esc(b.when || 'Time TBD') + '</div>' +
        '<div class="meta"><b>' + esc(b.service || 'Appointment') + '</b>' + (b.stylist ? ' · with <b>' + esc(b.stylist) + '</b>' : '') + '</div>' +
        '<div class="meta">' + esc(b.name || 'Client') +
          (phoneDigits ? ' · <a href="tel:' + esc(phoneDigits) + '">' + esc(b.phone) + '</a>' : '') +
          (b.email ? ' · ' + esc(b.email) : '') + '</div>' +
      '</div>' +
      '<span class="tag ' + esc(status) + '">' + esc(status) + '</span>' +
      '<div class="acts">' +
        '<button data-s="confirmed" type="button">Confirm</button>' +
        '<button data-s="done" type="button">Done</button>' +
        '<button data-s="canceled" type="button">Cancel</button>' +
        (me && me.role === 'admin' ? '<button data-s="delete" class="danger" type="button">Delete</button>' : '') +
      '</div>';
    d.querySelectorAll('.acts button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.s === 'delete' && !confirm('Permanently delete this booking?')) return;
        api('booking-status', 'POST', { slug: slug, id: b.id, status: btn.dataset.s })
          .then(function (r) {
            if (!r.data.ok) alert(r.data.error || 'Could not update that booking.');
            loadBookings();
          });
      });
    });
    return d;
  }

  function loadBookings() {
    api('bookings?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (r.status !== 200) return;
      var up = $('view-upcoming'), past = $('view-past');
      up.innerHTML = ''; past.innerHTML = '';
      var bs = r.data.bookings || [];
      bs.forEach(function (b) {
        var st = String(b.status || '').toLowerCase();
        (st === 'done' || st === 'canceled' ? past : up).appendChild(bkCard(b));
      });
      if (!up.children.length) up.innerHTML = '<p class="empty">No bookings yet — they’ll appear here the moment a client books.</p>';
      if (!past.children.length) past.innerHTML = '<p class="empty">Nothing here yet.</p>';
    });
  }

  /* ---------------- team (admin) ---------------- */
  function renderSeats(seats) {
    var bar = $('seatBar');
    if (!seats) { bar.textContent = ''; return; }
    var planLabel = seats.plan ? seats.plan.charAt(0).toUpperCase() + seats.plan.slice(1) : '';
    if (seats.limit === null) {
      bar.innerHTML = '<b>' + seats.used + '</b> seat' + (seats.used === 1 ? '' : 's') + ' used · ' + esc(planLabel) + ' plan · unlimited seats';
    } else {
      bar.innerHTML = '<b>' + seats.used + ' of ' + seats.limit + '</b> seats used · ' + esc(planLabel) + ' plan' +
        (seats.used >= seats.limit ? ' · <b>full</b> — remove someone or upgrade to add more' : '');
    }
  }

  function renderTeam(payload) {
    renderSeats(payload.seats);
    var list = $('teamList');
    list.innerHTML = '';
    (payload.team || []).forEach(function (u) {
      var d = document.createElement('div');
      d.className = 'sty';
      var isSelf = me && u.email === me.email;
      d.innerHTML =
        '<div><b style="font-weight:600">' + esc(u.name) + '</b>' +
          (u.role === 'admin' ? '<span class="pill">Owner</span>' : '') +
          (u.active ? '<span class="pill on">Active</span>' : '<span class="pill wait">Invited</span>') +
          '<div class="em">' + esc(u.email) + (u.phone ? ' · ' + esc(u.phone) : '') + '</div></div>' +
        '<div class="btns">' +
          (!u.active ? '<button data-a="resend" type="button">Resend Invite</button>' : '') +
          (u.role !== 'admin' && !isSelf ? '<button data-a="rm" type="button">Remove</button>' : '') +
        '</div>';
      var rs = d.querySelector('[data-a="resend"]');
      if (rs) rs.addEventListener('click', function () {
        rs.disabled = true;
        api('stylists', 'POST', { slug: slug, action: 'resend', email: u.email }).then(function (r) {
          rs.disabled = false;
          if (r.data.ok) { rs.textContent = 'Sent!'; }
          else alert(r.data.error || 'Could not resend.');
        });
      });
      var rm = d.querySelector('[data-a="rm"]');
      if (rm) rm.addEventListener('click', function () {
        if (!confirm('Remove ' + u.name + ' from the portal? Her seat frees up immediately.')) return;
        api('stylists', 'POST', { slug: slug, action: 'remove', email: u.email }).then(function (r) {
          if (r.data.ok) renderTeam(r.data);
          else alert(r.data.error || 'Could not remove.');
        });
      });
      list.appendChild(d);
    });
    if (!list.children.length) list.innerHTML = '<p class="empty">No team members yet — add the first one above.</p>';
  }

  function loadTeam() {
    api('stylists?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (r.status === 200 && r.data.ok) renderTeam(r.data);
    });
  }

  /* ---------------- deposits & no-shows (Stripe Connect) ---------------- */
  var payState = null;

  function showPaySection(id) {
    ['payUpgrade', 'paySetup', 'payPending', 'payReady'].forEach(function (s) {
      show($(s), s === id);
    });
  }

  function renderPayments(p) {
    payState = p;
    if (!p.planAllows) { showPaySection('payUpgrade'); return; }
    if (!p.connected) { showPaySection('paySetup'); return; }
    if (!p.chargesEnabled) { showPaySection('payPending'); return; }

    showPaySection('payReady');
    $('pay-enabled').checked = !!p.depositEnabled;
    $('pay-type').value = p.depositType === 'percent' ? 'percent' : 'fixed';
    /* Amounts are cents on the wire and dollars on screen — a stylist should
       never have to think in cents. */
    $('pay-amount').value = p.depositAmount
      ? (p.depositType === 'percent' ? p.depositAmount : (p.depositAmount / 100))
      : '';
    syncPayAmountLabel();
    $('payStripeLink').textContent =
      'Payouts and payment history live in your own Stripe account. Deposits land there directly.';
  }

  function syncPayAmountLabel() {
    var isPct = $('pay-type').value === 'percent';
    $('pay-amount-lbl').textContent = isPct ? 'Percentage of the service (%)' : 'Amount ($)';
    $('pay-amount').setAttribute('max', isPct ? '100' : '1000');
  }

  function loadPayments() {
    if (!me || me.role !== 'admin') return;
    api('payments?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (r.status === 200 && r.data.ok) renderPayments(r.data.payments);
      else show($('payCard'), false);
    });
  }

  function doConnect(btnId) {
    var btn = $(btnId); btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'Opening Stripe…';
    api('connect-onboard', 'POST', { slug: slug }).then(function (r) {
      if (r.status === 200 && r.data.ok && r.data.url) { window.location.href = r.data.url; return; }
      btn.disabled = false; btn.textContent = original;
      msg('payMsg', r.data.error || 'Could not open Stripe setup.', false);
      if (r.data.upgrade) showPaySection('payUpgrade');
    });
  }

  function doSavePayments() {
    hideMsg('payMsg');
    var btn = $('paySaveBtn'); btn.disabled = true;
    var type = $('pay-type').value === 'percent' ? 'percent' : 'fixed';
    var raw = parseFloat($('pay-amount').value);
    if (!isFinite(raw) || raw < 0) raw = 0;
    var amount = type === 'percent' ? Math.round(raw) : Math.round(raw * 100);

    api('payments', 'POST', {
      slug: slug,
      depositEnabled: $('pay-enabled').checked,
      depositType: type,
      depositAmount: amount
    }).then(function (r) {
      btn.disabled = false;
      if (r.status === 200 && r.data.ok) {
        renderPayments(r.data.payments);
        msg('payMsg', 'Saved.', true);
      } else {
        msg('payMsg', r.data.error || 'Could not save that.', false);
        if (r.data.upgrade) showPaySection('payUpgrade');
      }
    });
  }

  function doAddStylist() {
    hideMsg('addMsg');
    var btn = $('addStylistBtn'); btn.disabled = true;
    api('stylists', 'POST', {
      slug: slug,
      name: $('ns-name').value.trim(),
      email: $('ns-email').value.trim(),
      phone: $('ns-phone').value.trim()
    }).then(function (r) {
      btn.disabled = false;
      if (r.data.ok) {
        var how = r.data.emailSent && r.data.textSent ? 'by email and text'
          : r.data.emailSent ? 'by email'
          : r.data.textSent ? 'by text'
          : '— sending hiccuped, use Resend Invite below';
        msg('addMsg', 'Added! Invite sent ' + how + '.', true);
        $('ns-name').value = ''; $('ns-email').value = ''; $('ns-phone').value = '';
        renderTeam(r.data);
      } else {
        msg('addMsg', r.data.error || 'Could not add her — try again.');
        if (r.data.seats) renderSeats(r.data.seats);
        // Seat limit hit — offer the next tier right in the error line.
        if (r.status === 409 && /upgrade/i.test(r.data.error || '')) {
          var curPlan = (r.data.seats && r.data.seats.plan) || salon.plan || 'studio';
          var nextPlan = { studio: 'pro', pro: 'elite' }[curPlan];
          if (nextPlan) {
            var m = $('addMsg');
            m.appendChild(document.createTextNode(' '));
            var up = document.createElement('a');
            up.href = '#';
            up.textContent = 'Upgrade now';
            up.addEventListener('click', function (e) {
              e.preventDefault();
              up.textContent = 'Opening…';
              /* Already subscribed? Plan changes go through the Stripe billing
                 portal (a fresh checkout would create a SECOND subscription).
                 No subscription yet -> new trial checkout on the higher tier. */
              api('billing-status?slug=' + encodeURIComponent(slug)).then(function (bs) {
                var hasSub = bs.ok && bs.data.billing &&
                  ['trialing', 'active', 'past_due'].indexOf(bs.data.billing.status) !== -1;
                if (hasSub) { openBillingPortal(); } else { startCheckout(nextPlan); }
              });
            });
            m.appendChild(up);
          }
        }
      }
    });
  }

  /* ---------------- billing ---------------- */
  var billingReturn = qs.get('billing') || '';
  if (billingReturn && slug) {
    // one-time flag from Stripe redirects — clean the URL so refresh stays quiet
    try { history.replaceState({}, '', '/p/' + slug); } catch (e) { /* ignore */ }
  }

  function billingDismissed() {
    try { return sessionStorage.getItem('sv-billing-dismissed-' + slug) === '1'; } catch (e) { return false; }
  }
  function showBillingCard(kind, title, text, btnLabel, onBtn, dismissible) {
    var card = $('billingCard');
    card.className = 'billing' + (kind ? ' ' + kind : '');
    $('billingTitle').textContent = title;
    $('billingText').textContent = text;
    var btn = $('billingBtn');
    show(btn, !!btnLabel);
    if (btnLabel) { btn.textContent = btnLabel; btn.disabled = false; btn.onclick = onBtn; }
    var dis = $('billingDismiss');
    show(dis, !!dismissible);
    dis.onclick = function () {
      try { sessionStorage.setItem('sv-billing-dismissed-' + slug, '1'); } catch (e) { /* private mode */ }
      show(card, false);
    };
    show(card, true);
  }
  function startCheckout(plan) {
    api('create-checkout-session', 'POST', { slug: slug, plan: plan }).then(function (r) {
      if (r.data.ok && r.data.url) { location.href = r.data.url; }
      else {
        alert(r.data.error || 'Could not start checkout — try again.');
        var btn = $('billingBtn'); if (btn) btn.disabled = false;
      }
    });
  }
  function openBillingPortal() {
    api('billing-portal', 'POST', { slug: slug }).then(function (r) {
      if (r.data.ok && r.data.url) { location.href = r.data.url; }
      else {
        alert(r.data.error || 'Could not open billing — try again.');
        var btn = $('billingBtn'); if (btn) btn.disabled = false;
      }
    });
  }
  function loadBilling() {
    show($('billingCard'), false);
    show($('manageBillingRow'), false);
    api('billing-status?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (r.status !== 200 || !r.data.ok || !r.data.configured) return;
      var b = r.data.billing;
      var status = b ? String(b.status || '') : '';
      var isAdmin = me && me.role === 'admin';

      if (billingReturn === 'success') {
        billingReturn = ''; // show the toast once per page load only
        showBillingCard('good', "You're all set",
          'Your 30-day free trial is active — no charge until it ends, cancel anytime.',
          null, null, true);
      } else if (!b) {
        /* No billing record yet — the owner still needs to start the trial.
           Not dismissible: this is the one step between a live site and a
           real account, and hiding it is why signups never converted.
           Wording stays honest — the site is already live and nothing here
           threatens to take it away. */
        if (isAdmin) {
          showBillingCard('', 'Start your 30-day free trial',
            (salon.name || 'Your salon') + ' is live. Add a card to start your 30 days free — ' +
            'nothing is charged until day 31, and cancelling before then costs you nothing.',
            'Start Free Trial',
            function () { $('billingBtn').disabled = true; startCheckout(salon.plan || ''); },
            false);
        }
      } else if (status === 'past_due' && isAdmin) {
        showBillingCard('issue', 'Payment issue — update your card',
          'Your last payment did not go through. Update your card to keep your booking site and portal running.',
          'Update Card',
          function () { $('billingBtn').disabled = true; openBillingPortal(); },
          false);
      }

      if (isAdmin && b && (status === 'active' || status === 'trialing')) {
        show($('manageBillingRow'), true);
      }
    });
  }

  /* ---------------- add-to-home-screen ---------------- */
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    var btn = $('androidInstallBtn');
    if (btn && me) { show($('installCard'), !installDismissed()); show(btn, true); show($('iosSteps'), false); }
  });

  function installDismissed() {
    try { return localStorage.getItem('sv-install-dismissed') === '1'; } catch (e) { return false; }
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function setupInstallCard() {
    if (isStandalone() || installDismissed()) { show($('installCard'), false); return; }
    var ua = navigator.userAgent || '';
    var isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
    if (isIOS) {
      show($('installCard'), true);
      show($('iosSteps'), true);
      show($('androidInstallBtn'), false);
    } else if (deferredInstall) {
      show($('installCard'), true);
      show($('iosSteps'), false);
      show($('androidInstallBtn'), true);
    } else {
      // Android/desktop without a captured prompt yet — stay quiet.
      show($('installCard'), false);
    }
  }
  $('androidInstallBtn').addEventListener('click', function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function () {
      deferredInstall = null;
      show($('installCard'), false);
    });
  });
  $('installDismiss').addEventListener('click', function () {
    try { localStorage.setItem('sv-install-dismissed', '1'); } catch (e) { /* private mode */ }
    show($('installCard'), false);
  });

  /* ---------------- tabs + wiring ---------------- */
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      ['upcoming', 'past', 'admin'].forEach(function (t) { show($('view-' + t), t === b.dataset.tab); });
      if (b.dataset.tab === 'admin') { loadTeam(); loadPayments(); }
      else loadBookings();
    });
  });

  $('payConnectBtn').addEventListener('click', function () { doConnect('payConnectBtn'); });
  $('payResumeBtn').addEventListener('click', function () { doConnect('payResumeBtn'); });
  $('paySaveBtn').addEventListener('click', doSavePayments);
  $('pay-type').addEventListener('change', syncPayAmountLabel);
  $('payUpgradeBtn').addEventListener('click', function () {
    /* Existing subscriber -> portal to change plan; otherwise start Pro. */
    api('billing-status?slug=' + encodeURIComponent(slug)).then(function (bs) {
      var hasSub = bs.ok !== false && bs.data && bs.data.billing &&
        ['trialing', 'active', 'past_due'].indexOf(bs.data.billing.status) !== -1;
      if (hasSub) openBillingPortal(); else startCheckout('pro');
    });
  });

  $('loginBtn').addEventListener('click', doLogin);
  $('li-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('welcomeBtn').addEventListener('click', doWelcome);
  $('wl-pass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') doWelcome(); });
  $('forgotBtn').addEventListener('click', doForgot);
  $('resetBtn').addEventListener('click', doReset);
  $('rs-pass2').addEventListener('keydown', function (e) { if (e.key === 'Enter') doReset(); });
  $('showForgot').addEventListener('click', function (e) { e.preventDefault(); showOnly('forgotCard'); });
  $('backToLogin').addEventListener('click', function (e) { e.preventDefault(); showOnly('loginCard'); });
  $('manageBillingLink').addEventListener('click', function (e) { e.preventDefault(); openBillingPortal(); });
  $('logoutBtn').addEventListener('click', function () {
    api('logout', 'POST').then(function () { me = null; showOnly('loginCard'); });
  });

  /* ---------------- start ---------------- */
  if (!slug) {
    showOnly('noSalonCard');
  } else {
    api('salon-config?slug=' + encodeURIComponent(slug)).then(function (r) {
      if (r.status === 200 && r.data.ok) applySalon(r.data);
      else if (r.status === 404) {
        $('topLogo').innerHTML = 'Salon Vine <span class="badge">Portal</span>';
      }
      if (view === 'welcome' && inviteCode) {
        $('wl-email').value = urlEmail;
        showOnly('welcomeCard');
      } else if (view === 'reset' && resetCode) {
        $('rs-email').value = urlEmail;
        showOnly('resetCard');
      } else if (view === 'reset') {
        showOnly('forgotCard');
      } else {
        boot();
      }
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* not fatal */ });
    }
  }
})();
