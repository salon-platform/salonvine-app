/* Salon Vine — salon owner & staff portal (client).
   URL scheme: /p/<slug>, /p/<slug>/welcome?invite=..&email=.., /p/<slug>/reset?code=..&email=..

   Design ported from Zack's 11 Aug owner-portal prototype. Every screen here
   is backed by a real endpoint — the prototype's Calendar, Clients, Reports,
   Inventory and Marketing screens are deliberately NOT shipped, because no
   backend exists for them and a tab that looks finished but does nothing is
   worse than no tab at all. */
(function () {
  'use strict';

  function $(id){ return document.getElementById(id); }
  function show(el,on){ if(el) el.classList.toggle('hidden', !on); }
  function esc(s){ return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function money(n){ return '$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0}); }
  function initials(n){ return String(n||'?').trim().split(/\s+/).slice(0,2)
    .map(function(w){return w[0];}).join('').toUpperCase(); }
  function msg(id,text,ok){
    var m=$(id); if(!m) return;
    m.textContent=text; m.className='msg '+(ok?'ok':'err'); m.style.display='block';
  }
  function hideMsg(id){ var m=$(id); if(m) m.style.display='none'; }

  function toast(text,kind){
    var d=document.createElement('div');
    d.className='toast '+(kind||'');
    d.innerHTML='<span>'+(kind==='ok'?'✓':kind==='err'?'⚠':'ℹ')+'</span><span>'+esc(text)+'</span>';
    $('toasts').appendChild(d);
    setTimeout(function(){ d.style.opacity='0'; d.style.transition='opacity .3s';
      setTimeout(function(){ d.remove(); },320); },2600);
  }
  function openModal(html){ $('modal').innerHTML=html; $('scrim').classList.add('open'); }
  function closeModal(){ $('scrim').classList.remove('open'); }
  window.closeModal=closeModal;
  $('scrim').addEventListener('click',function(e){ if(e.target===this) closeModal(); });

  /* ---------------- slug + view from URL ---------------- */
  var qs = new URLSearchParams(location.search);
  var slug=null, view=null, pm=location.pathname.match(/^\/p\/([^\/]+)(?:\/(welcome|reset))?\/?$/);
  if(pm){ slug=pm[1]; view=pm[2]||null; }
  if(!slug) slug=qs.get('s');
  if(!view) view=qs.get('view');
  slug=(slug||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) slug=null;

  var inviteCode=qs.get('invite')||'', resetCode=qs.get('code')||'', urlEmail=qs.get('email')||'';

  var me=null;
  var S={ salon:{name:'Salon Vine',accent:'',plan:'',url:''},
          bookings:[], team:null, seats:null, pay:null, billing:null, cfg:null,
          route:'today', tab:'upcoming' };

  /* ---------------- API ---------------- */
  function api(path,method,body){
    return fetch('/api/'+path,{
      method:method||'GET',
      headers:{'Content-Type':'application/json'},
      body: body?JSON.stringify(body):undefined,
      credentials:'same-origin'
    }).then(function(r){
      return r.json().catch(function(){return {};}).then(function(j){ return {status:r.status,data:j}; });
    }).catch(function(){
      return {status:0,data:{error:'No connection — check your signal and try again.'}};
    });
  }

  /* ---------------- theming ---------------- */
  function darken(hex,amt){
    var m2=String(hex).match(/^#([0-9a-f]{6})$/i); if(!m2) return hex;
    var n=parseInt(m2[1],16);
    var r=Math.max(0,(n>>16&255)-amt), g=Math.max(0,(n>>8&255)-amt), b=Math.max(0,(n&255)-amt);
    return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
  }
  function applySalon(cfg){
    if(!cfg) return;
    S.cfg=cfg;
    S.salon.name=cfg.name||slug;
    S.salon.url='https://salonvine.com/s/'+slug;
    document.title=S.salon.name+' — Portal';
    $('authName').textContent=S.salon.name;
    $('authMark').textContent=(S.salon.name[0]||'S').toUpperCase();
    $('brandName').textContent=S.salon.name;
    $('brandMark').textContent=(S.salon.name[0]||'S').toUpperCase();
    var lt=$('loginTitle'); if(lt) lt.textContent='Sign in';
    var wt=$('welcomeTitle'); if(wt) wt.textContent='Welcome to '+S.salon.name;
    if(/^#[0-9a-f]{6}$/i.test(cfg.accent||'')){
      document.documentElement.style.setProperty('--accent',cfg.accent);
      document.documentElement.style.setProperty('--accent-dark',darken(cfg.accent,26));
      var tc=document.querySelector('meta[name="theme-color"]');
      if(tc) tc.setAttribute('content',cfg.accent);
    }
    var link=document.createElement('link');
    link.rel='manifest'; link.href='/api/manifest?slug='+encodeURIComponent(slug);
    document.head.appendChild(link);
  }

  /* ---------------- screens (all backed by real endpoints) ---------------- */
  var SCREENS={
    today   :{t:'Today',      ic:'☀', grp:'Run the day'},
    bookings:{t:'Bookings',   ic:'✓', grp:'Run the day'},
    payments:{t:'Payments',   ic:'$',      grp:'Money',       admin:true},
    billing :{t:'My plan',    ic:'⚑', grp:'Money',       admin:true},
    staff   :{t:'Staff',      ic:'⚬', grp:'My business', admin:true},
    services:{t:'Services',   ic:'✂', grp:'My business'},
    site    :{t:'My website', ic:'⌂', grp:'My business'}
  };
  var BOT=['today','bookings','payments','more'];

  function visible(k){ return !(SCREENS[k].admin && !(me && me.role==='admin')); }

  function buildNav(){
    var groups={}, order=[];
    Object.keys(SCREENS).forEach(function(k){
      if(!visible(k)) return;
      var g=SCREENS[k].grp;
      if(!groups[g]){ groups[g]=[]; order.push(g); }
      groups[g].push(k);
    });
    var h='';
    order.forEach(function(g){
      h+='<div class="navsec">'+esc(g)+'</div>';
      groups[g].forEach(function(k){
        var s=SCREENS[k];
        var n = k==='bookings' ? S.bookings.filter(function(b){return String(b.status||'new').toLowerCase()==='new';}).length : 0;
        h+='<button class="navitem" data-r="'+k+'" '+(S.route===k?'aria-current="page"':'')+'>'
         + '<span class="ic">'+s.ic+'</span><span>'+esc(s.t)+'</span>'
         + (n?'<span class="cnt">'+n+'</span>':'')
         + '</button>';
      });
    });
    $('navMain').innerHTML=h;

    var b='';
    BOT.forEach(function(k){
      if(k==='more'){ b+='<button data-r="more"><span class="ic">⋯</span><span>More</span></button>'; return; }
      if(!visible(k)) return;
      var s=SCREENS[k];
      b+='<button data-r="'+k+'" '+(S.route===k?'aria-current="page"':'')+'><span class="ic">'+s.ic+'</span><span>'+esc(s.t)+'</span></button>';
    });
    $('navBot').innerHTML=b;
  }

  document.addEventListener('click',function(e){
    var t=e.target.closest && e.target.closest('[data-r]'); if(!t) return;
    var r=t.getAttribute('data-r');
    if(r==='more') return showMore();
    go(r);
  });
  function showMore(){
    var h='<h3>Everything else</h3><p class="msub">Jump to any part of your portal.</p><div class="sheetnav">';
    Object.keys(SCREENS).forEach(function(k){
      if(BOT.indexOf(k)!==-1 || !visible(k)) return;
      h+='<button data-r="'+k+'" onclick="closeModal()"><span class="ic">'+SCREENS[k].ic+'</span><span>'+esc(SCREENS[k].t)+'</span></button>';
    });
    h+='</div><div class="mact"><button class="btn ghost" onclick="closeModal()">Close</button></div>';
    openModal(h);
  }
  function go(r){ if(!SCREENS[r]||!visible(r)) return; S.route=r; closeModal(); window.scrollTo(0,0); render(); }
  window.go=go;

  function tile(l,v,d){ return '<div class="tile"><div class="lb">'+esc(l)+'</div><div class="vl">'+esc(v)+'</div><div class="dl">'+esc(d)+'</div></div>'; }
  function empty(icon,text){ return '<div class="empty"><div class="big">'+icon+'</div>'+esc(text)+'</div>'; }

  function render(){
    var s=SCREENS[S.route]||SCREENS.today;
    $('pgTitle').textContent=s.t;
    $('pgChip').innerHTML='';
    buildNav();
    $('view').innerHTML=(VIEWS[S.route]||VIEWS.today)();
  }
  window.render=render;

  /* ---------------- views ---------------- */
  var VIEWS={};

  function bookingRow(b){
    var st=String(b.status||'new').toLowerCase();
    var cls = st==='new'?'warnc':st==='done'?'live':st==='canceled'?'critc':'neut';
    return '<button class="li" onclick="openBooking(\''+esc(b.id)+'\')">'
     + '<div class="av">'+esc(initials(b.name))+'</div>'
     + '<div class="bd"><div class="t1">'+esc(b.name||'Client')+'</div>'
     + '<div class="t2">'+esc(b.when||'Time TBD')+' · '+esc(b.service||'Appointment')
     + (b.stylist?' · '+esc(b.stylist):'')+'</div></div>'
     + '<span class="chip '+cls+'">'+esc(st)+'</span></button>';
  }

  VIEWS.today=function(){
    var news=S.bookings.filter(function(b){return String(b.status||'new').toLowerCase()==='new';});
    var open=S.bookings.filter(function(b){var s=String(b.status||'').toLowerCase();return s!=='done'&&s!=='canceled';});
    var h='';

    if(S.billing && S.billing.status==='trialing'){
      h+='<div class="banner trial"><span class="bi">⚑</span><div><b>Free trial active</b>'
       + '<p>Nothing is charged until day 31. Cancel any time from My plan.</p></div></div>';
    } else if(S.billing && S.billing.status==='past_due'){
      h+='<div class="banner crit"><span class="bi">⚠</span><div><b>Payment issue — update your card</b>'
       + '<p>Your last payment did not go through. Update it to keep your site and portal running.</p></div></div>';
    } else if(me && me.role==='admin' && S.billing===null){
      h+='<div class="banner todo"><span class="bi">⚑</span><div><b>Start your 30-day free trial</b>'
       + '<p>'+esc(S.salon.name)+' is live. Add a card to start — nothing charged until day 31.</p></div></div>';
    }

    if(me && me.role==='admin' && S.pay && !S.pay.connected && S.pay.planAllows){
      h+='<div class="banner todo"><span class="bi">$</span><div><b>Deposits are not switched on</b>'
       + '<p>Turn them on so a no-show costs them instead of you.</p></div></div>';
    }

    h+='<div class="tiles">'
     + tile('Open bookings',String(open.length),open.length?'Upcoming and unconfirmed':'All clear')
     + tile('Needs a reply',String(news.length),news.length?'Tap to confirm':'All caught up')
     + tile('Team',S.seats?String(S.seats.used):'—',S.seats?(S.seats.limit===null?'Unlimited seats':(S.seats.limit-S.seats.used)+' seat(s) free'):'')
     + tile('Deposits',S.pay?(S.pay.chargesEnabled?(S.pay.depositEnabled?'On':'Off'):'Setup'):'—',
            S.pay?(S.pay.connected?(S.pay.chargesEnabled?'Stripe connected':'Finish Stripe setup'):'Not switched on'):'')
     + '</div>';

    h+='<div class="card"><div class="rowbtw"><div><h2>Upcoming</h2><p class="sub">Everything not yet finished.</p></div>'
     + '<button class="btn sm" onclick="go(\'bookings\')">All bookings</button></div>';
    h+= open.length ? '<div class="lst">'+open.slice(0,8).map(bookingRow).join('')+'</div>'
                    : empty('☀','Nothing booked yet — requests land here the moment a client books.');
    h+='</div>';

    if(news.length){
      h+='<div class="card"><h2>Waiting on you</h2><p class="sub">These clients requested a time and haven’t heard back.</p>'
       + '<div class="lst">'+news.map(bookingRow).join('')+'</div></div>';
    }
    return h;
  };

  VIEWS.bookings=function(){
    var up=[],past=[];
    S.bookings.forEach(function(b){
      var s=String(b.status||'').toLowerCase();
      (s==='done'||s==='canceled'?past:up).push(b);
    });
    var list = S.tab==='past'?past:up;
    var h='<div class="card"><div class="rowbtw"><div><h2>Bookings</h2><p class="sub">Tap any booking to confirm, complete or cancel.</p></div>'
     + '<div class="seg"><button class="'+(S.tab==='upcoming'?'on':'')+'" onclick="setTab(\'upcoming\')">Upcoming ('+up.length+')</button>'
     + '<button class="'+(S.tab==='past'?'on':'')+'" onclick="setTab(\'past\')">Past ('+past.length+')</button></div></div>';
    h+= list.length ? '<div class="lst">'+list.map(bookingRow).join('')+'</div>'
                    : empty('✓', S.tab==='past'?'Nothing here yet.':'No upcoming bookings.');
    return h+'</div>';
  };
  window.setTab=function(t){ S.tab=t; render(); };

  VIEWS.staff=function(){
    var h='<div class="card"><h2>Add a stylist</h2><p class="sub">She gets an invite by email and text — she taps it, sets a password, done. Use the same name that shows on your booking site.</p>'
     + '<div class="fld"><label for="ns-name">Full name</label><input id="ns-name" type="text" placeholder="e.g. Alexis Morris"></div>'
     + '<div class="fld"><label for="ns-email">Email</label><input id="ns-email" type="email" inputmode="email"></div>'
     + '<div class="fld"><label for="ns-phone">Cell number (for the text invite)</label><input id="ns-phone" type="tel" inputmode="tel" placeholder="optional"></div>'
     + '<button class="btn" onclick="addStylist()">Add &amp; send invite</button><p class="msg" id="addMsg"></p></div>';

    h+='<div class="card"><h2>Team</h2>';
    if(S.seats){
      var pl=S.seats.plan?S.seats.plan.charAt(0).toUpperCase()+S.seats.plan.slice(1):'';
      h+='<p class="hint">'+(S.seats.limit===null
        ? '<b>'+S.seats.used+'</b> seat'+(S.seats.used===1?'':'s')+' used · '+esc(pl)+' plan · unlimited'
        : '<b>'+S.seats.used+' of '+S.seats.limit+'</b> seats used · '+esc(pl)+' plan'
          +(S.seats.used>=S.seats.limit?' · <b>full</b> — remove someone or upgrade':''))+'</p>';
    }
    var team=S.team||[];
    if(!team.length){ h+=empty('⚬','No team members yet — add the first one above.'); }
    else{
      h+='<div class="lst">';
      team.forEach(function(u){
        var isSelf = me && u.email===me.email;
        h+='<div class="li static"><div class="av">'+esc(initials(u.name))+'</div><div class="bd">'
         + '<div class="t1">'+esc(u.name)+(u.role==='admin'?' <span class="chip neut">Owner</span>':'')
         + (u.active?' <span class="chip live">Active</span>':' <span class="chip warnc">Invited</span>')+'</div>'
         + '<div class="t2">'+esc(u.email)+(u.phone?' · '+esc(u.phone):'')+'</div></div>'
         + '<div class="vacts">'
         + (!u.active?'<button class="btn ghost sm" onclick="resendInvite(\''+esc(u.email)+'\',this)">Resend</button>':'')
         + (u.role!=='admin'&&!isSelf?'<button class="btn ghost sm" onclick="removeStylist(\''+esc(u.email)+'\',\''+esc(u.name)+'\')">Remove</button>':'')
         + '</div></div>';
      });
      h+='</div>';
    }
    return h+'</div>';
  };

  VIEWS.payments=function(){
    var p=S.pay;
    var h='<div class="card"><h2>Deposits &amp; no-shows</h2>'
     + '<p class="sub">Ask for a deposit when someone books, so a no-show costs them instead of you. The money goes straight into your own Stripe account — Salon Vine never touches it and never takes a percentage.</p>';
    if(!p){ return h+empty('$','Loading…')+'</div>'; }

    if(!p.planAllows){
      h+='<p class="hint">Deposits come with <b>Studio Pro</b>. Your booking page keeps working exactly as it does now — this just adds the part that protects your time.</p>'
       + '<button class="btn" onclick="upgradePlan()">See Studio Pro</button>';
    } else if(!p.connected){
      h+='<p class="hint">Stripe handles the signup and the payouts. It takes a few minutes and you’ll need your bank details and a photo ID — that goes to Stripe, not to us.</p>'
       + '<button class="btn" id="payConnectBtn" onclick="doConnect(this)">Set up deposits with Stripe</button><p class="msg" id="payMsg"></p>';
    } else if(!p.chargesEnabled){
      h+='<p class="hint">Stripe still needs a few details before you can take payments. Pick up where you left off — it saves your progress.</p>'
       + '<button class="btn" id="payConnectBtn" onclick="doConnect(this)">Finish Stripe setup</button><p class="msg" id="payMsg"></p>';
    } else {
      h+='<div class="fld"><label class="chkrow"><input type="checkbox" id="pay-enabled" '+(p.depositEnabled?'checked':'')+'> Ask for a deposit on new booking requests</label></div>'
       + '<div class="fld"><label for="pay-type">Deposit type</label><select id="pay-type" onchange="syncAmt()">'
       + '<option value="fixed"'+(p.depositType!=='percent'?' selected':'')+'>A set amount</option>'
       + '<option value="percent"'+(p.depositType==='percent'?' selected':'')+'>A percentage of the service</option></select></div>'
       + '<div class="fld"><label for="pay-amount" id="pay-amount-lbl">'+(p.depositType==='percent'?'Percentage of the service (%)':'Amount ($)')+'</label>'
       + '<input id="pay-amount" type="number" inputmode="decimal" min="0" step="1" value="'
       + (p.depositAmount?(p.depositType==='percent'?p.depositAmount:(p.depositAmount/100)):'')+'"></div>'
       + '<button class="btn" onclick="savePayments(this)">Save deposit settings</button><p class="msg" id="payMsg"></p>'
       + '<p class="hint">Payouts and payment history live in your own Stripe account. Deposits land there directly.</p>';
    }
    return h+'</div>';
  };
  window.syncAmt=function(){
    var pct=$('pay-type').value==='percent';
    $('pay-amount-lbl').textContent=pct?'Percentage of the service (%)':'Amount ($)';
    $('pay-amount').setAttribute('max',pct?'100':'1000');
  };

  VIEWS.billing=function(){
    var b=S.billing;
    var h='<div class="card"><h2>My plan</h2><p class="sub">30 days free, then your plan’s monthly price. Cancel any time.</p>';
    if(b===undefined){ return h+empty('⚑','Loading…')+'</div>'; }
    if(!b){
      h+='<p class="hint">'+esc(S.salon.name)+' is live. Add a card to start your 30 days free — nothing is charged until day 31, and cancelling before then costs you nothing.</p>'
       + '<button class="btn" onclick="startTrial(this)">Start free trial</button>';
    } else {
      var st=String(b.status||'');
      var cls = st==='active'||st==='trialing' ? 'live' : st==='past_due' ? 'critc' : 'neut';
      h+='<div class="fgrid"><dt>Status</dt><dd><span class="chip '+cls+'">'+esc(st||'unknown')+'</span></dd>'
       + '<dt>Plan</dt><dd>'+esc((S.pay&&S.pay.plan)||S.salon.plan||'—')+'</dd></div>';
      if(st==='past_due'){
        h+='<p class="hint">Your last payment did not go through. Update your card to keep your booking site and portal running.</p>';
      }
      h+='<div class="vacts"><button class="btn" onclick="openBillingPortal(this)">Manage billing</button></div>'
       + '<p class="hint">Card, plan changes and invoices all live in the Stripe billing portal.</p>';
    }
    return h+'</div>';
  };

  VIEWS.services=function(){
    var svc=(S.cfg&&S.cfg.services)||[];
    var h='<div class="card"><div class="rowbtw"><div><h2>Services &amp; prices</h2>'
     + '<p class="sub">This is the menu clients see on your booking page.</p></div>'
     + '<button class="btn ghost sm" onclick="window.open(\''+esc(S.salon.url)+'\',\'_blank\')">View my site</button></div>'
     + '<div id="svcRows">'+svc.map(svcRow).join('')+'</div>'
     + '<div class="vacts"><button class="btn ghost" onclick="addSvcRow()">+ Add a service</button>'
     + '<button class="btn" onclick="saveServices(this)">Save services</button></div>'
     + '<p class="msg" id="svcMsg"></p>'
     + '<p class="hint">Leave a price blank if it varies — the menu just shows the name. Changes go live on your site straight away.</p>';
    return h+'</div>';
  };
  function svcRow(s){
    s=s||{name:'',price:''};
    return '<div class="svcrow">'
     + '<input class="svc-n" type="text" placeholder="e.g. Balayage" value="'+esc(s.name||'')+'">'
     + '<input class="svc-p" type="text" placeholder="$180" value="'+esc(s.price||'')+'">'
     + '<button class="btn ghost sm" onclick="this.parentNode.remove()" title="Remove">&times;</button></div>';
  }
  window.addSvcRow=function(){
    var d=document.createElement('div'); d.innerHTML=svcRow(null);
    $('svcRows').appendChild(d.firstChild);
  };
  window.saveServices=function(btn){
    hideMsg('svcMsg'); btn.disabled=true;
    var rows=[].slice.call(document.querySelectorAll('#svcRows .svcrow'));
    var services=rows.map(function(r){
      return {name:r.querySelector('.svc-n').value.trim(), price:r.querySelector('.svc-p').value.trim()};
    }).filter(function(x){ return x.name; });
    saveSite({services:services}, btn, 'svcMsg', 'Menu saved — it is live on your site now.');
  };

  VIEWS.site=function(){
    var c=S.cfg||{};
    var cur=c.theme||'classic-cream';
    var h='<div class="card"><div class="rowbtw"><div><h2>My website</h2>'
     + '<p class="sub">Make it yours. Everything here updates your live booking page.</p></div>'
     + '<button class="btn sm" onclick="window.open(\''+esc(S.salon.url)+'\',\'_blank\')">Open site</button></div>'
     + '<p class="hint">Your address: <a href="'+esc(S.salon.url)+'" target="_blank" rel="noopener">'+esc(S.salon.url)+'</a> '
     + '<button class="btn ghost sm" onclick="copyLink()">Copy</button></p>'
     + '<div class="fld"><label for="st-name">Salon name</label><input id="st-name" type="text" maxlength="120" value="'+esc(c.name||S.salon.name)+'"></div>'
     + '<div class="fld"><label for="st-tag">Tagline</label><input id="st-tag" type="text" maxlength="200" placeholder="e.g. Colour, balayage &amp; care" value="'+esc(c.tagline||'')+'"></div>'
     + '<div class="fld"><label for="st-theme">Theme</label><select id="st-theme">'+'<option value="classic-cream"'+(cur==='classic-cream'?' selected':'')+'>Classic Cream</option>'+'<option value="midnight"'+(cur==='midnight'?' selected':'')+'>Midnight</option>'+'<option value="rose-gold"'+(cur==='rose-gold'?' selected':'')+'>Rose Gold</option>'+'<option value="sage-spa"'+(cur==='sage-spa'?' selected':'')+'>Sage Spa</option>'+'<option value="bold-noir"'+(cur==='bold-noir'?' selected':'')+'>Bold Noir</option>'+'<option value="ocean"'+(cur==='ocean'?' selected':'')+'>Ocean</option>'+'</select></div>'
     + '<div class="fld"><label for="st-accent">Accent colour</label>'
     + '<div class="accentrow"><input id="st-accent" type="color" value="'+esc(/^#[0-9a-fA-F]{6}$/.test(c.accent||'')?c.accent:'#a8836a')+'">'
     + '<span class="hint" style="margin:0">Buttons, links and highlights on your site.</span></div></div>'
     + '<div class="fld"><label for="st-hours">Hours</label><input id="st-hours" type="text" maxlength="200" placeholder="e.g. Tue–Sat 9–5, closed Sun &amp; Mon" value="'+esc(c.hours||'')+'"></div>'
     + '<div class="fld"><label for="st-insta">Instagram</label><input id="st-insta" type="text" maxlength="60" placeholder="yoursalon" value="'+esc(String(c.instagram||'').replace(/^@+/,''))+'"></div>'
     + '<div class="vacts"><button class="btn" onclick="saveSiteBasics(this)">Save changes</button>'
     + '<button class="btn ghost" onclick="go(\'services\')">Edit services</button></div>'
     + '<p class="msg" id="siteMsg"></p>';
    h+='</div>';

    /* ----- Header & logo (Google Sites-style header controls) ----- */
    h+='<div class="card"><h2>Header &amp; logo</h2>'
     + '<p class="sub">The top of your site — your logo, the big headline, and the photo behind it.</p>'
     + '<div class="fld"><label for="st-herotitle">Headline</label>'
     + '<input id="st-herotitle" type="text" maxlength="120" placeholder="Defaults to your salon name" value="'+esc(c.heroTitle||'')+'">'
     + '<span class="hint">The large text at the top of your homepage. Leave blank to show your salon name.</span></div>'
     + '<div class="fld"><label>Logo</label><div class="mediarow">'
     + (c.logo ? '<img class="mthumb" src="'+esc(c.logo)+'" alt="Your logo">' : '<span class="hint" style="margin:0">No logo yet — your salon name shows instead.</span>')
     + '<label class="btn ghost sm upl">'+(c.logo?'Replace logo':'Upload logo')+'<input type="file" accept="image/*" style="display:none" onchange="svMediaUpload(this,\'logo\')"></label>'
     + (c.logo ? '<button class="btn ghost sm" onclick="svMediaRemove(this,\'logo\')">Remove</button>' : '')
     + '</div><span class="hint">Shows in the header next to your name. PNG with a transparent background looks best.</span></div>'
     + '<div class="fld"><label>Header photo</label><div class="mediarow">'
     + (c.heroImage ? '<img class="mthumb wide" src="'+esc(c.heroImage)+'" alt="Header photo">' : '<span class="hint" style="margin:0">No header photo — your theme colour shows instead.</span>')
     + '<label class="btn ghost sm upl">'+(c.heroImage?'Replace photo':'Upload photo')+'<input type="file" accept="image/*" style="display:none" onchange="svMediaUpload(this,\'hero\')"></label>'
     + (c.heroImage ? '<button class="btn ghost sm" onclick="svMediaRemove(this,\'hero\')">Remove</button>' : '')
     + '</div><span class="hint">A wide shot of your space or your best work, shown full-width behind your headline.</span></div>'
     + '<div class="vacts"><button class="btn" onclick="saveHeader(this)">Save header</button></div>'
     + '<p class="msg" id="hdrMsg"></p></div>';

    /* ----- Photos: full gallery manager ----- */
    var ph=(c.photos||[]).filter(function(u){return /^https:\/\//.test(String(u));});
    h+='<div class="card"><div class="rowbtw"><div><h2>Photos</h2>'
     + '<p class="sub">Your gallery — up to eight shots of your work or your space.</p></div>'
     + '<span class="hint" style="margin:0">'+ph.length+' of 8</span></div>'
     + '<div class="pgrid" id="pGrid">'
     + ph.map(function(u,i){
         return '<div class="pcell"><img src="'+esc(u)+'" alt="Photo '+(i+1)+'" loading="lazy">'
          + '<div class="pacts">'
          + '<button class="pbtn" title="Move earlier" '+(i===0?'disabled':'')+' onclick="svPhotoMove('+i+',-1)">&#8592;</button>'
          + '<button class="pbtn" title="Move later" '+(i===ph.length-1?'disabled':'')+' onclick="svPhotoMove('+i+',1)">&#8594;</button>'
          + '<button class="pbtn del" title="Remove" onclick="svPhotoDel('+i+')">&times;</button>'
          + '</div></div>';
       }).join('')
     + (ph.length<8 ? '<label class="pcell padd"><span>+</span>Add photos<input type="file" accept="image/*" multiple style="display:none" onchange="svPhotoAdd(this)"></label>' : '')
     + '</div>'
     + '<p class="msg" id="phMsg"></p>'
     + '<p class="hint">The first photo leads your gallery. Changes go live on your site straight away.</p></div>';
    return h;
  };

  /* ---------------- website media: resize + upload + manage ---------------- */
  /* Client-side resize keeps uploads fast: gallery/hero -> 1600px JPEG,
     logo -> 600px (PNG kept so transparency survives). */
  function svResize(file, maxW, keepPng, cb){
    var rd=new FileReader();
    rd.onload=function(){
      var img=new Image();
      img.onload=function(){
        var w=img.width,hh=img.height;
        if(w>maxW){ hh=Math.round(hh*maxW/w); w=maxW; }
        var cv=document.createElement('canvas'); cv.width=w; cv.height=hh;
        cv.getContext('2d').drawImage(img,0,0,w,hh);
        var png=keepPng&&/png$/i.test(file.type);
        cb(cv.toDataURL(png?'image/png':'image/jpeg',png?undefined:0.85));
      };
      img.onerror=function(){ cb(null); };
      img.src=rd.result;
    };
    rd.onerror=function(){ cb(null); };
    rd.readAsDataURL(file);
  }
  function svUpload(kind,dataUrl){
    return api('site-photo','POST',{slug:slug,data:dataUrl,kind:kind});
  }
  function svPhotos(){ return ((S.cfg&&S.cfg.photos)||[]).filter(function(u){return /^https:\/\//.test(String(u));}); }
  function svSavePhotos(arr,msgId){
    return api('site-edit','POST',{slug:slug,fields:{photos:arr}}).then(function(r){
      if(r.status===200&&r.data&&r.data.ok){ S.cfg=Object.assign({},S.cfg||{},{photos:arr}); render(); }
      else { msg(msgId,(r.data&&r.data.error)||'Could not save. Try again.'); }
      return r;
    });
  }
  window.svPhotoDel=function(i){
    var arr=svPhotos(); arr.splice(i,1);
    svSavePhotos(arr,'phMsg');
  };
  window.svPhotoMove=function(i,dir){
    var arr=svPhotos(); var j=i+dir;
    if(j<0||j>=arr.length) return;
    var t=arr[i]; arr[i]=arr[j]; arr[j]=t;
    svSavePhotos(arr,'phMsg');
  };
  window.svPhotoAdd=function(input){
    var files=[].slice.call(input.files||[]); input.value='';
    if(!files.length) return;
    var room=8-svPhotos().length;
    if(room<=0){ return msg('phMsg','Photo limit reached (8). Remove one first.'); }
    files=files.slice(0,room);
    msg('phMsg','Uploading '+files.length+' photo(s)…',true);
    var done=0,fail=0;
    (function next(){
      var f=files.shift();
      if(!f){
        if(fail){ msg('phMsg',done+' uploaded, '+fail+' failed — try those again.'); } else { hideMsg('phMsg'); }
        render(); return;
      }
      svResize(f,1600,false,function(du){
        if(!du){ fail++; return next(); }
        svUpload('gallery',du).then(function(r){
          if(r.status===200&&r.data&&r.data.ok&&r.data.url){
            done++;
            var arr=svPhotos(); arr.push(r.data.url);
            S.cfg=Object.assign({},S.cfg||{},{photos:arr});
          } else { fail++; }
          msg('phMsg','Uploading… '+done+' done'+(fail?', '+fail+' failed':''),true);
          next();
        });
      });
    })();
  };
  window.saveHeader=function(btn){
    hideMsg('hdrMsg'); btn.disabled=true;
    api('site-edit','POST',{slug:slug,fields:{heroTitle:$('st-herotitle').value.trim()}}).then(function(r){
      btn.disabled=false;
      if(r.status===200&&r.data&&r.data.ok){
        S.cfg=Object.assign({},S.cfg||{},{heroTitle:$('st-herotitle').value.trim()});
        msg('hdrMsg','Saved — your header is updated.',true);
      } else {
        msg('hdrMsg',(r.data&&r.data.error)||'Could not save. Try again.');
      }
    });
  };
  window.svMediaUpload=function(input,kind){
    var f=(input.files||[])[0]; input.value='';
    if(!f) return;
    msg('hdrMsg','Uploading…',true);
    svResize(f, kind==='logo'?600:1800, kind==='logo', function(du){
      if(!du){ return msg('hdrMsg','Could not read that image — try another file.'); }
      svUpload(kind,du).then(function(r){
        if(r.status===200&&r.data&&r.data.ok&&r.data.url){
          var patch={}; patch[kind==='logo'?'logo':'heroImage']=r.data.url;
          S.cfg=Object.assign({},S.cfg||{},patch);
          hideMsg('hdrMsg'); render();
        } else {
          msg('hdrMsg',(r.data&&r.data.error)||'Upload failed. Try again.');
        }
      });
    });
  };
  window.svMediaRemove=function(btn,kind){
    btn.disabled=true;
    var key=kind==='logo'?'logo':'heroImage';
    var fields={}; fields[key]='';
    api('site-edit','POST',{slug:slug,fields:fields}).then(function(r){
      if(r.status===200&&r.data&&r.data.ok){
        var patch={}; patch[key]='';
        S.cfg=Object.assign({},S.cfg||{},patch); render();
      } else {
        btn.disabled=false;
        msg('hdrMsg',(r.data&&r.data.error)||'Could not remove. Try again.');
      }
    });
  };
  window.saveSiteBasics=function(btn){
    hideMsg('siteMsg');
    var name=$('st-name').value.trim();
    if(!name){ return msg('siteMsg','Your salon needs a name.'); }
    btn.disabled=true;
    var fields={
      name:name,
      tagline:$('st-tag').value.trim(),
      theme:$('st-theme').value,
      accent:$('st-accent').value,
      hours:$('st-hours').value.trim(),
      instagram:$('st-insta').value.trim().replace(/^@+/,'')
    };
    /* header card fields save with the same button when present */
    var ht=$('st-herotitle'); if(ht){ fields.heroTitle=ht.value.trim(); }
    saveSite(fields, btn, 'siteMsg', 'Saved — your site is updated.');
  };
  /* Shared save: writes through /api/site-edit, which checks the session,
     allow-lists the fields and adds the registry token server-side. */
  function saveSite(fields, btn, msgId, okText){
    api('site-edit','POST',{slug:slug,fields:fields}).then(function(r){
      if(btn) btn.disabled=false;
      if(r.status===200&&r.data.ok){
        S.cfg=Object.assign({},S.cfg||{},r.data.fields||fields);
        applySalon(S.cfg);
        toast(okText,'ok');
        render();
      } else {
        msg(msgId, r.data.error||'Could not save that — try again.');
      }
    });
  }
  window.copyLink=function(){
    try{ navigator.clipboard.writeText(S.salon.url); toast('Link copied','ok'); }
    catch(e){ toast('Copy failed — select the link instead','err'); }
  };

  /* ---------------- booking actions ---------------- */
  window.openBooking=function(id){
    var b=S.bookings.filter(function(x){return String(x.id)===String(id);})[0];
    if(!b) return;
    var phone=String(b.phone||'').replace(/[^\d+]/g,'');
    var h='<h3>'+esc(b.name||'Client')+'</h3><p class="msub">'+esc(b.when||'Time TBD')+'</p>'
     + '<div class="fgrid">'
     + '<dt>Service</dt><dd>'+esc(b.service||'Appointment')+'</dd>'
     + (b.stylist?'<dt>Stylist</dt><dd>'+esc(b.stylist)+'</dd>':'')
     + (b.phone?'<dt>Phone</dt><dd><a href="tel:'+esc(phone)+'">'+esc(b.phone)+'</a></dd>':'')
     + (b.email?'<dt>Email</dt><dd><a href="mailto:'+esc(b.email)+'">'+esc(b.email)+'</a></dd>':'')
     + (b.message?'<dt>Note</dt><dd>'+esc(b.message)+'</dd>':'')
     + '<dt>Status</dt><dd>'+esc(b.status||'new')+'</dd>'
     + '</div><div class="mact">'
     + '<button class="btn" onclick="setBooking(\''+esc(b.id)+'\',\'confirmed\')">Confirm</button>'
     + '<button class="btn ghost" onclick="setBooking(\''+esc(b.id)+'\',\'done\')">Done</button>'
     + '<button class="btn ghost" onclick="setBooking(\''+esc(b.id)+'\',\'canceled\')">Cancel</button>'
     + (me&&me.role==='admin'?'<button class="btn ghost danger" onclick="setBooking(\''+esc(b.id)+'\',\'delete\')">Delete</button>':'')
     + '<button class="btn ghost" onclick="closeModal()">Close</button></div>';
    openModal(h);
  };
  window.setBooking=function(id,status){
    if(status==='delete' && !confirm('Permanently delete this booking?')) return;
    api('booking-status','POST',{slug:slug,id:id,status:status}).then(function(r){
      closeModal();
      if(!r.data.ok) return toast(r.data.error||'Could not update that booking','err');
      toast('Booking updated','ok');
      loadBookings();
    });
  };

  /* ---------------- staff actions ---------------- */
  window.addStylist=function(){
    hideMsg('addMsg');
    api('stylists','POST',{slug:slug,name:$('ns-name').value.trim(),
      email:$('ns-email').value.trim(),phone:$('ns-phone').value.trim()}).then(function(r){
      if(r.data.ok){
        var how = r.data.emailSent&&r.data.textSent?'by email and text'
          : r.data.emailSent?'by email' : r.data.textSent?'by text' : '— sending hiccuped, use Resend below';
        toast('Added! Invite sent '+how,'ok');
        S.team=r.data.team||S.team; S.seats=r.data.seats||S.seats;
        render();
      } else {
        msg('addMsg', r.data.error||'Could not add her — try again.');
        if(r.data.seats){ S.seats=r.data.seats; }
      }
    });
  };
  window.resendInvite=function(email,btn){
    btn.disabled=true;
    api('stylists','POST',{slug:slug,action:'resend',email:email}).then(function(r){
      btn.disabled=false;
      toast(r.data.ok?'Invite resent':(r.data.error||'Could not resend'), r.data.ok?'ok':'err');
    });
  };
  window.removeStylist=function(email,name){
    if(!confirm('Remove '+name+' from the portal? Her seat frees up immediately.')) return;
    api('stylists','POST',{slug:slug,action:'remove',email:email}).then(function(r){
      if(!r.data.ok) return toast(r.data.error||'Could not remove','err');
      S.team=r.data.team||S.team; S.seats=r.data.seats||S.seats;
      toast('Removed','ok'); render();
    });
  };

  /* ---------------- payments actions ---------------- */
  window.doConnect=function(btn){
    hideMsg('payMsg');
    var original=btn.textContent;
    btn.disabled=true; btn.textContent='Opening Stripe…';
    /* The endpoint can hang; never leave the button stuck with no explanation. */
    var done=false;
    var timer=setTimeout(function(){
      if(done) return;
      done=true; btn.disabled=false; btn.textContent=original;
      msg('payMsg','Stripe did not respond. This usually means payments are not switched on for the platform yet — we are on it.',false);
    },20000);
    api('connect-onboard','POST',{slug:slug}).then(function(r){
      if(done) return;
      done=true; clearTimeout(timer);
      if(r.status===200 && r.data.ok && r.data.url){ location.href=r.data.url; return; }
      btn.disabled=false; btn.textContent=original;
      msg('payMsg', r.data.error||'Could not open Stripe setup.', false);
    });
  };
  window.savePayments=function(btn){
    hideMsg('payMsg'); btn.disabled=true;
    var type=$('pay-type').value==='percent'?'percent':'fixed';
    var raw=parseFloat($('pay-amount').value); if(!isFinite(raw)||raw<0) raw=0;
    var amount = type==='percent'?Math.round(raw):Math.round(raw*100);
    api('payments','POST',{slug:slug,depositEnabled:$('pay-enabled').checked,
      depositType:type,depositAmount:amount}).then(function(r){
      btn.disabled=false;
      if(r.status===200&&r.data.ok){ S.pay=r.data.payments; toast('Saved','ok'); render(); }
      else msg('payMsg', r.data.error||'Could not save that.', false);
    });
  };

  /* ---------------- billing actions ---------------- */
  window.startTrial=function(btn){
    btn.disabled=true;
    api('create-checkout-session','POST',{slug:slug,plan:(S.pay&&S.pay.plan)||''}).then(function(r){
      if(r.data.ok&&r.data.url){ location.href=r.data.url; return; }
      btn.disabled=false; toast(r.data.error||'Could not start checkout','err');
    });
  };
  window.openBillingPortal=function(btn){
    if(btn) btn.disabled=true;
    api('billing-portal','POST',{slug:slug}).then(function(r){
      if(r.data.ok&&r.data.url){ location.href=r.data.url; return; }
      if(btn) btn.disabled=false; toast(r.data.error||'Could not open billing','err');
    });
  };
  window.upgradePlan=function(){
    api('billing-status?slug='+encodeURIComponent(slug)).then(function(bs){
      var b=bs.data&&bs.data.billing;
      var has=b&&['trialing','active','past_due'].indexOf(b.status)!==-1;
      if(has) openBillingPortal(null); else window.startTrial({disabled:false});
    });
  };

  /* ---------------- loaders ---------------- */
  function loadBookings(){
    return api('bookings?slug='+encodeURIComponent(slug)).then(function(r){
      if(r.status===200) S.bookings=r.data.bookings||[];
      render();
    });
  }
  function loadTeam(){
    return api('stylists?slug='+encodeURIComponent(slug)).then(function(r){
      if(r.status===200&&r.data.ok){ S.team=r.data.team||[]; S.seats=r.data.seats||null; }
      render();
    });
  }
  function loadPayments(){
    return api('payments?slug='+encodeURIComponent(slug)).then(function(r){
      if(r.status===200&&r.data.ok) S.pay=r.data.payments;
      render();
    });
  }
  function loadBilling(){
    return api('billing-status?slug='+encodeURIComponent(slug)).then(function(r){
      S.billing = (r.status===200&&r.data.ok&&r.data.configured) ? (r.data.billing||null) : null;
      render();
    });
  }

  /* ---------------- auth flows ---------------- */
  var CARDS=['noSalonCard','loginCard','welcomeCard','forgotCard','resetCard'];
  function showAuth(id){
    show($('auth'),true); show($('app'),false); show($('botnav'),false);
    CARDS.forEach(function(c){ show($(c), c===id); });
  }
  function showApp(){
    show($('auth'),false); show($('app'),true); show($('botnav'),true);
    $('avatar').textContent=initials(me.name); $('avatar').title=me.name;
    $('brandSub').textContent = me.role==='admin' ? 'Owner Portal' : 'Staff Portal';
    $('viewSiteBtn').onclick=function(){ window.open(S.salon.url,'_blank'); };
    if(!SCREENS[S.route] || !visible(S.route)) S.route='today';
    render();
    loadBookings();
    if(me.role==='admin'){ loadTeam(); loadPayments(); loadBilling(); }
    setupInstall();
  }

  function doLogin(){
    hideMsg('loginMsg');
    var btn=$('loginBtn'); btn.disabled=true;
    api('login','POST',{slug:slug,email:$('li-email').value.trim(),password:$('li-pass').value})
      .then(function(r){
        btn.disabled=false;
        if(r.data.ok){ me={slug:slug,email:$('li-email').value.trim().toLowerCase(),role:r.data.role,name:r.data.name}; showApp(); }
        else msg('loginMsg', r.data.error||'Sign-in failed.');
      });
  }
  function doWelcome(){
    hideMsg('welcomeMsg');
    var p1=$('wl-pass').value, p2=$('wl-pass2').value;
    if(p1.length<8) return msg('welcomeMsg','Password needs at least 8 characters.');
    if(p1!==p2) return msg('welcomeMsg',"Those passwords don't match.");
    var btn=$('welcomeBtn'); btn.disabled=true;
    api('set-password','POST',{slug:slug,email:$('wl-email').value.trim(),invite:inviteCode,password:p1})
      .then(function(r){
        btn.disabled=false;
        if(r.data.ok){ history.replaceState({},'','/p/'+slug);
          me={slug:slug,email:$('wl-email').value.trim().toLowerCase(),role:r.data.role,name:r.data.name}; showApp(); }
        else msg('welcomeMsg', r.data.error||'That link did not work.');
      });
  }
  function doForgot(){
    hideMsg('forgotMsg');
    var email=$('fg-email').value.trim();
    if(!email) return msg('forgotMsg','Enter your email first.');
    var btn=$('forgotBtn'); btn.disabled=true;
    api('forgot-password','POST',{slug:slug,email:email}).then(function(r){
      btn.disabled=false;
      if(r.status===0) return msg('forgotMsg', r.data.error);
      msg('forgotMsg',"If that email has an account here, a reset link is on its way. Check your inbox (and spam).",true);
    });
  }
  function doReset(){
    hideMsg('resetMsg');
    var p1=$('rs-pass').value, p2=$('rs-pass2').value;
    if(p1.length<8) return msg('resetMsg','Password needs at least 8 characters.');
    if(p1!==p2) return msg('resetMsg',"Those passwords don't match.");
    var btn=$('resetBtn'); btn.disabled=true;
    api('set-password','POST',{slug:slug,email:$('rs-email').value.trim(),invite:resetCode,password:p1})
      .then(function(r){
        btn.disabled=false;
        if(r.data.ok){ history.replaceState({},'','/p/'+slug);
          me={slug:slug,email:$('rs-email').value.trim().toLowerCase(),role:r.data.role,name:r.data.name}; showApp(); }
        else msg('resetMsg', r.data.error||'That link expired or was already used. Request a new one from the sign-in page.');
      });
  }

  $('loginBtn').addEventListener('click',doLogin);
  $('li-pass').addEventListener('keydown',function(e){ if(e.key==='Enter') doLogin(); });
  $('welcomeBtn').addEventListener('click',doWelcome);
  $('wl-pass2').addEventListener('keydown',function(e){ if(e.key==='Enter') doWelcome(); });
  $('forgotBtn').addEventListener('click',doForgot);
  $('resetBtn').addEventListener('click',doReset);
  $('rs-pass2').addEventListener('keydown',function(e){ if(e.key==='Enter') doReset(); });
  $('showForgot').addEventListener('click',function(e){ e.preventDefault(); showAuth('forgotCard'); });
  $('backToLogin').addEventListener('click',function(e){ e.preventDefault(); showAuth('loginCard'); });
  $('logoutBtn').addEventListener('click',function(){
    api('logout','POST').then(function(){ me=null; showAuth('loginCard'); });
  });

  /* ---------------- add to home screen ---------------- */
  var deferredInstall=null;
  window.addEventListener('beforeinstallprompt',function(e){ e.preventDefault(); deferredInstall=e; });
  function installDismissed(){ try{ return localStorage.getItem('sv-install-dismissed')==='1'; }catch(e){ return false; } }
  function isStandalone(){ return (window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches)||window.navigator.standalone===true; }
  function setupInstall(){
    if(isStandalone()||installDismissed()) return;
    var ua=navigator.userAgent||'';
    var isIOS=/iphone|ipad|ipod/i.test(ua)&&!window.MSStream;
    if(!isIOS && !deferredInstall) return;
    setTimeout(function(){
      var h='<h3>Put this on your home screen</h3><p class="msub">Then it opens like an app — one tap, full screen, always signed in.</p>';
      if(isIOS){
        h+='<div class="instw"><ol>'
         + '<li><span class="ic"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 11v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9"/></svg></span><span>Tap the <b>Share</b> button in Safari</span></li>'
         + '<li><span class="ic"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg></span><span>Scroll down and tap <b>Add to Home Screen</b></span></li>'
         + '<li><span class="ic"><svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg></span><span>Tap <b>Add</b> — done</span></li>'
         + '</ol></div>';
      }
      h+='<div class="mact">'
       + (deferredInstall?'<button class="btn" onclick="androidInstall()">Install app</button>':'')
       + '<button class="btn ghost" onclick="dismissInstall()">Maybe later</button></div>';
      openModal(h);
    },1200);
  }
  window.androidInstall=function(){
    if(!deferredInstall) return closeModal();
    deferredInstall.prompt();
    deferredInstall.userChoice.then(function(){ deferredInstall=null; closeModal(); });
  };
  window.dismissInstall=function(){
    try{ localStorage.setItem('sv-install-dismissed','1'); }catch(e){}
    closeModal();
  };

  /* ---------------- start ---------------- */
  var billingReturn=qs.get('billing')||'';
  if(billingReturn && slug){ try{ history.replaceState({},'','/p/'+slug); }catch(e){} }

  if(!slug){ showAuth('noSalonCard'); }
  else{
    api('salon-config?slug='+encodeURIComponent(slug)).then(function(r){
      if(r.status===200&&r.data.ok) applySalon(r.data);
      if(view==='welcome'&&inviteCode){ $('wl-email').value=urlEmail; showAuth('welcomeCard'); }
      else if(view==='reset'&&resetCode){ $('rs-email').value=urlEmail; showAuth('resetCard'); }
      else if(view==='reset'){ showAuth('forgotCard'); }
      else{
        api('me').then(function(r2){
          if(r2.status===200&&r2.data.ok&&r2.data.slug===slug){ me=r2.data; showApp(); }
          else showAuth('loginCard');
        });
      }
      if(billingReturn==='success') setTimeout(function(){ toast('You’re all set — trial active','ok'); },600);
    });
    if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(function(){}); }
  }
})();
