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
  function centsFmt(c){ return '$'+(Number(c||0)/100).toFixed(2); }
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
          bookings:[], team:null, seats:null, pay:null, billing:null, cfg:null, extra:null,
          sales:undefined, salesMore:false,
          route:'today', tab:'upcoming' };

  /* Back from Stripe onboarding. A stylist starts hers from the Checkout
     tab, so put her back on it instead of Today — otherwise finishing at
     Stripe looks like it did nothing. */
  if(qs.get('to')==='checkout') S.route='checkout';

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
    calendar:{t:'Calendar',   ic:'▦', grp:'Run the day'},
    availability:{t:'My profile', ic:'◐', grp:'Run the day'},
    checkout:{t:'Checkout',   ic:'$', grp:'Run the day'},
    payments:{t:'Payments',   ic:'⇄', grp:'Money',       admin:true},
    insights:{t:'Insights',   ic:'◔', grp:'Money',       admin:true},
    billing :{t:'My plan',    ic:'⚑', grp:'Money',       admin:true},
    account :{t:'Account',    ic:'⚙', grp:'Money',       admin:true},
    staff   :{t:'Staff',      ic:'⚬', grp:'My business', admin:true},
    clients :{t:'Clients',    ic:'☺', grp:'My business', admin:true},
    import  :{t:'Import data', ic:'⇪', grp:'My business'},
    inventory:{t:'Inventory', ic:'◫', grp:'My business', admin:true},
    services:{t:'Services',   ic:'✂', grp:'My business', admin:true},
    site    :{t:'My website', ic:'⌂', grp:'My business', admin:true}
  };
  var BOT=['today','calendar','checkout','more'];

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
        var n = k==='calendar' ? S.bookings.filter(function(b){return String(b.status||'new').toLowerCase()==='new';}).length : 0;
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
    if(r==='import'){ closeModal(); window.location.href='/import.html'; return; }
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
  function go(r){ if(r==='bookings'){ r='calendar'; calState().mode='list'; }
    if(!SCREENS[r]||!visible(r)) return; S.route=r; closeModal(); window.scrollTo(0,0);
    if(r==='availability'&&S.avail===undefined) loadAvailability();
    if(r==='staff'&&S.owners===undefined) loadOwners();
    if(r==='account'&&S.account===undefined) loadAccount();
    if(r==='payments'&&S.sales===undefined) loadSales();
    if(r==='clients'&&S.clients===undefined) loadClients();
    if(r==='inventory'&&S.products===undefined) loadProducts();
    if(r==='insights'){ if(S.sales===undefined) loadSales(); if(S.clients===undefined) loadClients(); }
    render(); }
  window.go=go;
  window.dismissImportNudge=function(){ try{localStorage.setItem('sv_import_dismissed_'+slug,'1');}catch(e){} var n=document.getElementById('importNudge'); if(n) n.remove(); };

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
     + (b.posPaid?'<span class="chip live">paid</span>':'')
     + '<span class="chip '+cls+'">'+esc(st)+'</span></button>';
  }

  VIEWS.today=function(){
    var news=S.bookings.filter(function(b){return String(b.status||'new').toLowerCase()==='new';});
    var open=S.bookings.filter(function(b){var s=String(b.status||'').toLowerCase();return s!=='done'&&s!=='canceled';});
    var h='';

    /* A new stylist's one-time nudge to bring their own book over. Dismissible;
       they can always get back to it from the Import data menu. */
    if(me && me.role!=='admin'){
      var impDone=false; try{ impDone=localStorage.getItem('sv_import_dismissed_'+slug)==='1'; }catch(e){}
      if(!impDone){
        h+='<div class="banner todo" id="importNudge"><span class="bi">⇪</span><div><b>New here? Bring your clients over</b>'
         + '<p>Move your client list and your own calendar from Vagaro, Square, GlossGenius, StyleSeat or Booksy — it takes a few minutes and nothing is shared with the rest of the team.</p>'
         + '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" data-r="import">Bring my clients over</button>'
         + '<button class="btn ghost sm" onclick="dismissImportNudge()">Not now</button></div></div></div>';
      }
    }

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

    /* Go-Live setup checklist — owner only, shown until the essentials are set. */
    if(me && me.role==='admin'){
      var _cfg=S.cfg||{};
      var _svcN=((_cfg.services)||[]).length;
      var _photoN=((_cfg.photos)||[]).filter(function(u){return /^https:\/\//.test(String(u));}).length;
      var _steps=[
        {t:'Add your services & prices', ok:_svcN>0, r:'services'},
        {t:'Add photos of your work', ok:_photoN>0, r:'site'},
        {t:'Set your opening hours', ok:!!String(_cfg.hours||'').trim(), r:'site'},
        {t:'Add your address', ok:!!String(_cfg.address||'').trim(), r:'site'},
        {t:'Turn on payments (Stripe)', ok:!!(S.pay&&S.pay.connected&&S.pay.chargesEnabled), r:'payments'}
      ];
      var _doneN=_steps.filter(function(s){return s.ok;}).length;
      if(_doneN<_steps.length){
        h+='<div class="card"><div class="rowbtw"><div><h2>Finish setting up</h2>'
         + '<p class="sub">'+_doneN+' of '+_steps.length+' done — knock these out and your booking page is ready to share.</p></div>'
         + '<button class="btn sm" onclick="window.open(\''+esc(S.salon.url||('https://salonvine.com/s/'+slug))+'\',\'_blank\')">Preview my site</button></div>'
         + '<div style="margin-top:6px">'
         + _steps.map(function(s){
             return '<div style="display:flex;align-items:center;gap:11px;padding:11px 0;border-top:1px solid var(--line,#e3d9cf)">'
              + '<span style="width:22px;height:22px;border-radius:50%;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:.8rem;'+(s.ok?'background:var(--good,#2e7d5b);color:#fff':'border:1px solid var(--line,#e3d9cf);color:var(--soft,#8a8078)')+'">'+(s.ok?'✓':'')+'</span>'
              + '<span style="flex:1;font-size:.95rem;'+(s.ok?'color:var(--soft,#8a8078);text-decoration:line-through':'')+'">'+esc(s.t)+'</span>'
              + (s.ok?'<span class="hint" style="margin:0">Done</span>':'<button class="btn ghost sm" onclick="go(\''+s.r+'\')">Do this</button>')
              + '</div>';
           }).join('')
         + '</div></div>';
      }
    }

    h+='<div class="card"><div class="rowbtw"><div><h2>Upcoming</h2><p class="sub">Everything not yet finished.</p></div>'
     + '<button class="btn sm" onclick="go(\'bookings\')">All requests</button></div>';
    h+= open.length ? '<div class="lst">'+open.slice(0,8).map(bookingRow).join('')+'</div>'
                    : empty('☀','Nothing booked yet — requests land here the moment a client books.');
    h+='</div>';

    if(news.length){
      h+='<div class="card"><h2>Waiting on you</h2><p class="sub">These clients requested a time and haven’t heard back.</p>'
       + '<div class="lst">'+news.map(bookingRow).join('')+'</div></div>';
    }
    return h;
  };


  /* ---------------- checkout (the register) ----------------
     amount -> hand the phone over for the tip -> pay (this phone or the
     customer's own via QR) -> paid. The card-processing fee (2.9% + 30c)
     is always added as its own line so the salon nets service + tip.     */
  function newSale(pre){
    return Object.assign({
      step:'amount', amountCents:0, tipCents:0, tipLabel:'',
      bookingId:'', service:'', client:'',
      saleId:'sl'+Date.now().toString(36)+Math.random().toString(36).slice(2,8),
      sessionId:'', url:'', baseCents:0, feeCents:0, totalCents:0, waiting:false
    }, pre||{});
  }
  function feeCentsFor(c){ return Math.ceil((c+30)/(1-0.029))-c; }

  VIEWS.checkout=function(){
    if(!S.pos) S.pos=newSale();
    if(S.posReady===undefined){
      S.posReady=null;
      api('pos-checkout?slug='+encodeURIComponent(slug)).then(function(r){
        S.posReady=(r.status===200&&r.data.ok)?r.data:{ready:false};
        if(S.route==='checkout') render();
      });
    }
    var p=S.pos;

    if(S.posReady && !S.posReady.ready){
      var isAdmin=me&&me.role==='admin';
      /* own === the salon marked this stylist independent (booth rent), so
         the money is hers and the Stripe account has to be hers too. */
      var own=!!S.posReady.own, hint, act;
      if(own){
        hint = S.posReady.connected
          ? 'Stripe still needs a few details from you before you can take cards. Pick up where you left off — it saves your progress.'
          : 'You take your own payments, so this is your own Stripe account and the money lands in your bank, not the salon\'s. Stripe asks for your bank details and a photo ID — that goes to Stripe, not to us.';
        act = '<button class="btn" id="payConnectBtn" onclick="doConnect(this)">'
            + (S.posReady.connected?'Finish my Stripe setup':'Set up my Stripe')
            + '</button><p class="msg" id="payMsg"></p>';
      } else if(isAdmin){
        hint = 'Connect your Stripe account first — it takes a few minutes and then this screen becomes your register.';
        act = '<button class="btn" onclick="go(\'payments\')">Set up payments</button>';
      } else {
        hint = 'Checkout is not set up yet. Ask the owner to finish Stripe setup on the Payments screen.';
        act = '';
      }
      return '<div class="card"><h2>Checkout</h2>'
       + '<p class="sub">Ring up a sale right here — type the card in, or let the customer pay on their own phone.</p>'
       + '<p class="hint">'+hint+'</p>'
       + act
       + '</div>';
    }

    if(p.step==='amount'){
      return '<div class="card"><h2>New sale</h2>'
       + '<p class="sub">'+(p.client?esc(p.client)+(p.service?' · '+esc(p.service):''):'Enter the amount for the service.')+'</p>'
       + '<div class="posamt"><span>$</span><input id="pos-amt" type="number" inputmode="decimal" min="0.5" step="0.01" placeholder="0.00" value="'+(p.amountCents?(p.amountCents/100).toFixed(2):'')+'"></div>'
       + (p.service?'':'<div class="fld"><label for="pos-svc">What was it for? (shows on their receipt)</label><input id="pos-svc" type="text" maxlength="80" placeholder="e.g. Cut &amp; style" value="'+esc(p.service)+'"></div>')
       + '<div class="fld"><label for="pos-phone">Customer\'s phone (texts them a receipt)</label><input id="pos-phone" type="tel" inputmode="tel" maxlength="16" placeholder="(555) 555-5555" value="'+esc(p.custPhone||'')+'"></div>'
       + '<div class="fld"><label for="pos-email">Customer\'s email (emails the receipt)</label><input id="pos-email" type="email" inputmode="email" maxlength="120" placeholder="them@example.com" value="'+esc(p.custEmail||'')+'"></div>'
       + '<p class="hint" style="margin-top:2px">Both optional — the receipt ends with a link to book their next appointment.</p>'
       + '<button class="btn wide" onclick="posToTip()">Continue to tip</button>'
       + '<p class="msg" id="posMsg"></p>'
       + '<p class="hint">The card-processing fee (2.9% + 30&cent;) is added automatically at the end, so you keep the full amount.</p>'
       + '</div>';
    }

    if(p.step==='tip'){
      function tipBtn(pct){
        var t=Math.round(p.amountCents*pct/100);
        return '<button class="tipbtn" onclick="posTip('+t+',\''+pct+'%\')"><b>'+pct+'%</b><span>'+centsFmt(t)+'</span></button>';
      }
      return '<div class="card poscust"><h2>Add a tip?</h2>'
       + '<p class="sub">'+esc(p.service||'Service')+' — '+centsFmt(p.amountCents)+'</p>'
       + '<div class="tipgrid">'+tipBtn(15)+tipBtn(20)+tipBtn(25)
       + '<button class="tipbtn" onclick="posTipCustom()"><b>Custom</b><span>you choose</span></button></div>'
       + '<div id="posTipCustom" class="hidden"><div class="posamt sm"><span>$</span><input id="pos-tip" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00"></div>'
       + '<button class="btn wide" onclick="posTipCustomGo()">Add tip</button></div>'
       + '<button class="btn ghost wide" onclick="posTip(0,\'\')">No tip</button>'
       + '<p class="hint" style="text-align:center">Hand the phone to your client for this part.</p>'
       + '</div>';
    }

    if(p.step==='pay'){
      var rows='<div class="totline"><span>'+esc(p.service||'Service')+'</span><span>'+centsFmt(p.baseCents||p.amountCents)+'</span></div>'
       + (p.tipCents?'<div class="totline"><span>Tip'+(p.tipLabel?' ('+esc(p.tipLabel)+')':'')+'</span><span>'+centsFmt(p.tipCents)+'</span></div>':'')
       + '<div class="totline"><span>Card processing fee</span><span>'+centsFmt(p.feeCents||feeCentsFor(p.amountCents+p.tipCents))+'</span></div>'
       + '<div class="totline grand"><span>Total</span><span>'+centsFmt(p.totalCents||(p.amountCents+p.tipCents+feeCentsFor(p.amountCents+p.tipCents)))+'</span></div>';
      var h='<div class="card"><h2>Take the payment</h2>'
       + '<p class="sub">'+(p.client?esc(p.client)+' · ':'')+'either phone works — the money lands in your Stripe account.</p>'
       + '<div class="totbox">'+rows+'</div>';
      if(!p.sessionId){
        h+='<p class="msg" id="posMsg"></p><div class="empty"><div class="big">…</div>Getting the card reader ready…</div>';
      } else {
        h+='<div class="vacts">'
         + '<button class="btn wide" onclick="posOpen()">Type the card on this phone</button>'
         + '<button class="btn ghost wide" onclick="posShowQR()">Customer pays on their phone</button></div>'
         + '<div id="posqrwrap" class="hidden"><div class="qrbox" id="posqr"></div>'
         + '<p class="hint" style="text-align:center">They scan this with their camera, then pay with Apple&nbsp;Pay, Google&nbsp;Pay or their card — that\'s their tap-to-pay.</p></div>'
         + (p.waiting?'<div class="waitline"><span class="spin"></span> Waiting for the payment&hellip; this updates by itself.</div>':'')
         + '<p class="msg" id="posMsg"></p>';
      }
      h+='<button class="btn ghost wide" onclick="posReset()">Cancel this sale</button></div>';
      return h;
    }

    /* paid */
    return '<div class="card poscust"><div class="paydone">✓</div>'
     + '<h2 style="text-align:center">Paid — '+centsFmt(p.totalCents)+'</h2>'
     + '<p class="sub" style="text-align:center">'+esc(p.service||'Service')+' '+centsFmt(p.baseCents)
     + (p.tipCents?' + '+centsFmt(p.tipCents)+' tip':'')+' + '+centsFmt(p.feeCents)+' card fee</p>'
     + '<div class="vacts"><button class="btn wide" onclick="posReset()">New sale</button>'
     + (p.bookingId?'<button class="btn ghost wide" onclick="posReset();go(\'calendar\')">Back to calendar</button>':'')
     + '</div></div>';
  };

  window.posFromBooking=function(id){
    var b=S.bookings.filter(function(x){return String(x.id)===String(id);})[0]||{};
    var pre={bookingId:String(id),service:b.service||'',client:b.name||''};
    /* Best-effort prefill from the service menu ("$45" -> 4500). */
    var svc=((S.cfg&&S.cfg.services)||[]).filter(function(s){return s&&s.name===b.service;})[0];
    if(svc&&svc.price){
      var m=String(svc.price).replace(/,/g,'').match(/(\d+(?:\.\d{1,2})?)/);
      if(m) pre.amountCents=Math.round(parseFloat(m[1])*100);
    }
    S.pos=newSale(pre);
    closeModal(); go('checkout');
  };
  window.posToTip=function(){
    hideMsg('posMsg');
    var raw=parseFloat($('pos-amt').value);
    if(!isFinite(raw)||raw<0.5) return msg('posMsg','Enter an amount of at least $0.50.');
    if(raw>10000) return msg('posMsg','That amount is over the $10,000 per-sale limit.');
    S.pos.amountCents=Math.round(raw*100);
    var sv=$('pos-svc'); if(sv&&sv.value.trim()) S.pos.service=sv.value.trim();
    var ph=$('pos-phone'); if(ph) S.pos.custPhone=ph.value.trim();
    var em=$('pos-email'); if(em) S.pos.custEmail=em.value.trim();
    if(S.pos.custEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(S.pos.custEmail)){
      return msg('posMsg','That email does not look right - fix it or clear it.');
    }
    /* Fresh sale id each pass through this step: the id guards double-taps on
       one attempt, but an edited amount is a NEW attempt — reusing the id
       would trip Stripe's idempotency check. */
    S.pos.saleId='sl'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
    S.pos.step='tip'; render();
  };
  window.posTip=function(tipCents,label){
    S.pos.tipCents=tipCents; S.pos.tipLabel=label;
    S.pos.step='pay'; render(); posCreate();
  };
  window.posTipCustom=function(){ show($('posTipCustom'),true); $('pos-tip').focus(); };
  window.posTipCustomGo=function(){
    var raw=parseFloat($('pos-tip').value); if(!isFinite(raw)||raw<0) raw=0;
    posTip(Math.round(raw*100),'custom');
  };
  function posCreate(){
    var p=S.pos;
    api('pos-checkout','POST',{slug:slug,amountCents:p.amountCents,tipCents:p.tipCents,
      bookingId:p.bookingId,service:p.service,client:p.client,saleId:p.saleId,
      customerPhone:p.custPhone||'',customerEmail:p.custEmail||''}).then(function(r){
      if(S.pos!==p||p.step!=='pay') return;
      if(r.status===200&&r.data.ok){
        p.sessionId=r.data.sessionId; p.url=r.data.url;
        p.baseCents=r.data.baseCents; p.feeCents=r.data.feeCents; p.totalCents=r.data.totalCents;
        render(); posPoll(p);
      } else {
        p.step='amount'; render();
        setTimeout(function(){ msg('posMsg', r.data.error||'Could not start the checkout.'); },0);
      }
    });
  }
  window.posOpen=function(){
    var p=S.pos; if(!p.url) return;
    p.waiting=true; render();
    window.open(p.url,'_blank');
  };
  window.posShowQR=function(){
    var p=S.pos; if(!p.url) return;
    p.waiting=true; render();
    var w=$('posqrwrap'), box=$('posqr');
    if(!w||!box) return;
    show(w,true);
    if(typeof qrcode==='function'){
      try{
        var q=qrcode(0,'M'); q.addData(p.url); q.make();
        box.innerHTML=q.createSvgTag({cellSize:5,margin:2,scalable:true});
      }catch(e){ box.innerHTML=''; }
    }
    if(!box.innerHTML){
      box.innerHTML='<button class="btn sm" onclick="posCopyLink()">Copy payment link</button>';
    }
  };
  window.posCopyLink=function(){
    try{ navigator.clipboard.writeText(S.pos.url); toast('Payment link copied — text it to them','ok'); }
    catch(e){ toast('Could not copy — use "Type the card on this phone" instead','err'); }
  };
  function posPoll(p){
    if(S.pos!==p||p.step!=='pay'||!p.sessionId) return;
    api('pos-confirm','POST',{slug:slug,sessionId:p.sessionId}).then(function(r){
      if(S.pos!==p||p.step!=='pay') return;
      if(r.status===200&&r.data.ok&&r.data.paid){
        p.totalCents=r.data.amountCents||p.totalCents;
        p.step='paid';
        toast('Payment received — '+centsFmt(p.totalCents),'ok');
        if(p.bookingId) loadBookings(); else render();
        if(S.route==='checkout') render();
        return;
      }
      setTimeout(function(){ posPoll(p); },3000);
    });
  }
  window.posReset=function(){ S.pos=newSale(); if(S.route==='checkout') render(); };

  /* How this person gets paid, in words the owner can act on. The Stripe
     part only matters for independents — a commission stylist has nothing
     of her own to set up. */
  function payTypeNote(u){
    if(u.payType!=='independent') return 'Commission — sales go to the salon';
    if(u.ownStripeReady)     return 'Independent — own Stripe ready';
    if(u.ownStripeConnected) return 'Independent — Stripe not finished';
    return 'Independent — no Stripe set up yet';
  }
  function payTypePicker(u){
    var ind = u.payType==='independent';
    return '<select style="width:auto;padding:6px 8px;font-size:13px" '
         + 'onchange="setPayType(\''+esc(u.email)+'\',this)">'
         + '<option value="commission"'+(ind?'':' selected')+'>Commission</option>'
         + '<option value="independent"'+(ind?' selected':'')+'>Independent</option>'
         + '</select>';
  }

  /* ---------------- managers ---------------- */
  function ownersCard(){
    var o=S.owners;
    var h='<div class="card"><div class="rowbtw"><div><h2>Owners &amp; managers</h2>'
      + '<p class="sub">Owner-level logins for this salon. A manager works alongside you with the full owner portal; you can remove them any time. Handing the whole salon to a new owner is done from <a href="#" onclick="go(\'account\');return false">Account</a>.</p></div>'
      + '<div class="vacts"><button class="btn ghost sm" onclick="openOwnerInvite()">+ Add a manager</button></div></div>';
    if(o===undefined) return h+empty('⚑','Loading…')+'</div>';
    if(o===null) return h+'<p class="hint">Could not load owners right now.</p></div>';
    h+='<div class="lst">';
    (o.owners||[]).forEach(function(u){
      h+='<div class="li static"><div class="av">'+esc(initials(u.name||u.email))+'</div><div class="bd"><div class="t1">'+esc(u.name||u.email)+' <span class="chip neut">Owner</span>'+(u.me?' <span class="chip live">You</span>':'')+'</div><div class="t2">'+esc(u.email)+'</div></div>'
        + (!u.me?'<div class="vacts"><button class="btn ghost sm" onclick="ownerRevoke(\''+esc(u.email)+'\',\''+esc(u.name||u.email)+'\')">Remove</button></div>':'')+'</div>';
    });
    (o.pending||[]).forEach(function(u){
      h+='<div class="li static"><div class="av">'+esc(initials(u.name||u.email))+'</div><div class="bd"><div class="t1">'+esc(u.name||u.email)+' <span class="chip warnc">Manager invited</span></div><div class="t2">'+esc(u.email)+' · waiting for them to set a password</div></div>'
        + '<div class="vacts"><button class="btn ghost sm" onclick="ownerAction(\'resend\',\''+esc(u.email)+'\',this)">Resend</button><button class="btn ghost sm" onclick="ownerAction(\'cancel\',\''+esc(u.email)+'\',this)">Cancel</button></div></div>';
    });
    return h+'</div></div>';
  }
  window.openOwnerInvite=function(){
    openModal('<h3>Add a manager</h3>'
      + '<p class="msub">They get an email to set a password and then have the full owner portal alongside you. You can remove them any time.</p>'
      + '<div class="fld"><label for="oi-name">Full name</label><input id="oi-name"></div>'
      + '<div class="fld"><label for="oi-email">Email</label><input id="oi-email" type="email" inputmode="email"></div>'
      + '<div class="mact"><button class="btn" onclick="ownerInvite(this)">Send the invite</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div><p class="msg" id="oiMsg"></p>');
  };
  window.ownerInvite=function(btn){
    hideMsg('oiMsg'); btn.disabled=true;
    api('ownership','POST',{slug:slug,action:'invite',name:$('oi-name').value.trim(),email:$('oi-email').value.trim()}).then(function(r){
      btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return msg('oiMsg',(r.data&&r.data.error)||'Could not send that.');
      S.owners={owners:r.data.owners||[],pending:r.data.pending||[]};
      closeModal(); render();
      if(r.data.emailSent) toast('Invite sent','ok');
      else openModal('<h3>Email didn\'t go out</h3><p class="msub">Send them this link yourself:</p><p style="word-break:break-all;font-size:.85rem">'+esc(r.data.link||'')+'</p><div class="mact"><button class="btn ghost" onclick="closeModal()">Close</button></div>');
    });
  };
  window.ownerAction=function(action,email,btn){
    if(btn) btn.disabled=true;
    api('ownership','POST',{slug:slug,action:action,email:email}).then(function(r){
      if(btn) btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return toast((r.data&&r.data.error)||'Could not do that','err');
      S.owners={owners:r.data.owners||[],pending:r.data.pending||[]}; render();
      toast(action==='cancel'?'Invite cancelled':action==='resend'?(r.data.emailSent?'Sent again':'Could not email — try again'):'Removed','ok');
    });
  };
  window.ownerRevoke=function(email,name){
    openModal('<h3>Remove '+esc(name)+'?</h3><p class="msub">Their owner login stops working right away. Nothing else changes.</p><div class="mact"><button class="btn danger" onclick="closeModal();ownerAction(\'revoke\',\''+esc(email)+'\')">Remove</button><button class="btn ghost" onclick="closeModal()">Keep</button></div>');
  };
  function loadOwners(){
    return api('ownership?slug='+encodeURIComponent(slug)).then(function(r){
      S.owners=(r.status===200&&r.data.ok)?{owners:r.data.owners||[],pending:r.data.pending||[]}:null;
      if(S.route==='staff') render();
    });
  }

  /* ---------------- account (the owner's own settings) ---------------- */
  VIEWS.account=function(){
    var a=S.account;
    if(a===undefined) return '<div class="card"><h2>Account</h2>'+empty('⚙','Loading…')+'</div>';
    if(a===null) return '<div class="card"><h2>Account</h2>'+empty('⚙','Could not load this right now.')+'</div>';
    var h='<div class="card"><h2>Owner</h2><p class="sub">The person who owns this salon on SalonVine. Selling or handing the salon over? Put the new owner\'s email here — they get a "set your password" email, your password stops working the moment they set theirs, and everything else (bookings, clients, team, menu, website) stays exactly as it is.</p>'
      + '<div class="frow"><div class="fld"><label for="ac-name">Name</label><input id="ac-name" value="'+esc(a.owner.name)+'"></div>'
      + '<div class="fld"><label for="ac-email">Email (this is your login)</label><input id="ac-email" type="email" inputmode="email" value="'+esc(a.owner.email)+'"></div></div>'
      + '<div class="vacts"><button class="btn" onclick="accountOwner(this)">Save</button></div><p class="msg" id="acMsg"></p></div>';
    h+='<div class="card"><h2>Password</h2>'
      + '<div class="frow"><div class="fld"><label for="ac-cur">Current password</label><input id="ac-cur" type="password" autocomplete="current-password"></div>'
      + '<div class="fld"><label for="ac-new">New password (8+ characters)</label><input id="ac-new" type="password" autocomplete="new-password"></div></div>'
      + '<div class="vacts"><button class="btn" onclick="accountPassword(this)">Change password</button></div><p class="msg" id="acPwMsg"></p></div>';
    h+='<div class="card"><h2>Stripe — deposits &amp; checkout</h2>'
      + (a.stripe.connected
          ? '<p class="sub">Connected (account ending <b>'+esc(a.stripe.accountId)+'</b>)'+(a.stripe.chargesEnabled?' and taking payments.':' — setup not finished yet.')+' Deposits and checkout money land in this Stripe account. New owner? Disconnect it and connect your own under Payments.</p>'
            + '<div class="vacts"><button class="btn ghost danger" onclick="accountStripeDisconnect()">Disconnect this Stripe account</button><button class="btn ghost" onclick="go(\'payments\')">Open Payments</button></div>'
          : '<p class="sub">No Stripe account connected. Connect one under Payments to take deposits and checkout payments.</p><div class="vacts"><button class="btn" onclick="go(\'payments\')">Set up in Payments</button></div>')
      + '</div>';
    h+='<div class="card"><h2>SalonVine subscription</h2>'
      + '<p class="sub">Status: <b>'+esc(a.billing.status||'—')+'</b>'+(a.billing.ownerEmail?' · billed to '+esc(a.billing.ownerEmail):'')+'. Change the card, the plan, or the billing email on Stripe\'s billing page — a new owner puts their own card there and the plan carries on with no gap.</p>'
      + (a.billing.hasPortal
          ? '<div class="vacts"><button class="btn" onclick="openBillingPortal(this)">Change card / manage billing</button></div>'
          : '<div class="vacts"><button class="btn" onclick="go(\'billing\')">Set up the plan</button></div>')
      + '</div>';
    return h;
  };
  window.accountOwner=function(btn){
    hideMsg('acMsg');
    var email=$('ac-email').value.trim().toLowerCase(), name=$('ac-name').value.trim();
    var changing = S.account && email!==S.account.owner.email;
    var go2=function(){
      btn.disabled=true;
      api('account','POST',{slug:slug,action:'owner',name:name,email:email}).then(function(r){
        btn.disabled=false;
        if(!(r.status===200&&r.data.ok)) return msg('acMsg',(r.data&&r.data.error)||'Could not save.');
        if(r.data.handedOver){
          openModal('<h3>Owner changed</h3><p class="msub">'+(r.data.emailSent?'<b>'+esc(r.data.email)+'</b> has been emailed a link to set a password. Your login stops working now.':'The email could not be sent. Pass this link to <b>'+esc(r.data.email)+'</b>: <span style="word-break:break-all">'+esc(r.data.link||'')+'</span>')+'</p><div class="mact"><button class="btn" onclick="closeModal();api(\'logout\',\'POST\').then(function(){location.reload();})">Sign out</button></div>');
          return;
        }
        S.account={owner:r.data.owner,stripe:r.data.stripe,billing:r.data.billing}; me.name=name; toast('Saved','ok'); render();
      });
    };
    if(changing){
      openModal('<h3>Hand this salon to '+esc(email)+'?</h3><p class="msub">They\'ll get an email to set a password. <b>Your login closes as soon as you press Yes</b> — you won\'t be able to get back in unless they add you as a manager. Bookings, clients, team, menu and website are untouched. The Stripe account and the SalonVine subscription card stay as they are until someone changes them on this screen.</p><div class="mact"><button class="btn danger" id="ac-yes">Yes, hand it over</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>');
      $('ac-yes').onclick=function(){ closeModal(); go2(); };
    } else go2();
  };
  window.accountPassword=function(btn){
    hideMsg('acPwMsg'); btn.disabled=true;
    api('account','POST',{slug:slug,action:'password',current:$('ac-cur').value,next:$('ac-new').value}).then(function(r){
      btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return msg('acPwMsg',(r.data&&r.data.error)||'Could not change it.');
      $('ac-cur').value=''; $('ac-new').value=''; msg('acPwMsg','Password changed',true);
    });
  };
  window.accountStripeDisconnect=function(){
    openModal('<h3>Disconnect Stripe?</h3><p class="msub">Deposits and checkout stop until a new Stripe account is connected under Payments. Money already in the old account stays there — this only unlinks it from the salon.</p><div class="mact"><button class="btn danger" onclick="closeModal();accountStripeDo()">Disconnect</button><button class="btn ghost" onclick="closeModal()">Keep</button></div>');
  };
  window.accountStripeDo=function(){
    api('account','POST',{slug:slug,action:'stripe-disconnect'}).then(function(r){
      if(!(r.status===200&&r.data.ok)) return toast((r.data&&r.data.error)||'Could not disconnect','err');
      S.account={owner:r.data.owner,stripe:r.data.stripe,billing:r.data.billing}; S.pay=undefined; toast('Stripe disconnected','ok'); render(); if(typeof loadPayments==='function') loadPayments();
    });
  };
  function loadAccount(){
    return api('account?slug='+encodeURIComponent(slug)).then(function(r){
      S.account=(r.status===200&&r.data.ok)?{owner:r.data.owner,stripe:r.data.stripe,billing:r.data.billing}:null;
      if(S.route==='account') render();
    });
  }

  VIEWS.staff=function(){
    var h=ownersCard();
    h+='<div class="card"><h2>Add a stylist</h2><p class="sub">She gets an invite by email and text — she taps it, sets a password, done. Use the same name that shows on your booking site.</p>'
     + '<div class="fld"><label for="ns-name">Full name</label><input id="ns-name" type="text" placeholder="e.g. Alexis Morris"></div>'
     + '<div class="fld"><label for="ns-email">Email</label><input id="ns-email" type="email" inputmode="email"></div>'
     + '<div class="fld"><label for="ns-phone">Cell number (for the text invite)</label><input id="ns-phone" type="tel" inputmode="tel" placeholder="optional"></div>'
     + '<button class="btn" onclick="addStylist()">Add &amp; send invite</button><p class="msg" id="addMsg"></p></div>';

    h+='<div class="card"><h2>Team</h2>'
     + '<p class="sub">Set how each person gets paid. <b>Commission</b> means their card sales go into the salon\'s Stripe account — yours. <b>Independent</b> (booth or chair rent) means they connect their own Stripe and the money goes straight to them; they do that themselves from their Checkout tab.</p>';
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
      var removable=team.filter(function(u){ return u.role!=='admin' && !(me&&u.email===me.email); });
      if(removable.length) h+=bulkBar('staff');
      h+='<div class="lst">';
      team.forEach(function(u){
        var isSelf = me && u.email===me.email;
        var canRemove = u.role!=='admin' && !isSelf;
        h+='<div class="li static">'
         + (canRemove?'<input type="checkbox" class="bchk-staff" data-id="'+esc(u.email)+'" onclick="bulkSync(\'staff\')" style="margin-right:10px;flex:none">':'<span style="width:23px;flex:none"></span>')
         + '<div class="av">'+esc(initials(u.name))+'</div><div class="bd">'
         + '<div class="t1">'+esc(u.name)+(u.role==='admin'?' <span class="chip neut">Owner</span>':'')
         + (u.active?' <span class="chip live">Active</span>':' <span class="chip warnc">Invited</span>')+'</div>'
         + '<div class="t2">'+esc(u.email)+(u.phone?' · '+esc(u.phone):'')+'</div>'
         + (u.role==='admin'?'':'<div class="t2">'+payTypeNote(u)+'</div>')
         + '</div>'
         + '<div class="vacts">'
         + (u.role==='admin'?'':payTypePicker(u))
         + (!u.active?'<button class="btn ghost sm" onclick="resendInvite(\''+esc(u.email)+'\',this)">Resend</button>':'')
         + (canRemove?'<button class="btn ghost sm" onclick="removeStylist(\''+esc(u.email)+'\',\''+esc(u.name)+'\')">Remove</button>':'')
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
       + '<p class="hint">Payouts land in your bank automatically. Every sale and deposit shows in the Sales list below.</p>';
    }
    h+='</div>';

    /* ----- Sales: every charge on this salon's account, with refunds -----
       Owners never need the Stripe dashboard: the list and the refund
       button live here, and the server only ever talks to THIS salon's
       own account. */
    h+='<div class="card"><h2>Sales</h2>'
     + '<p class="sub">Every payment your salon has taken — checkout sales and booking deposits. Refunds go back to the client\'s card in 5–10 days.</p>';
    if(S.sales===undefined){
      h+=empty('$','Loading your sales…');
    } else if(!S.sales.length){
      h+=empty('$','No sales yet — your first checkout or deposit will show up here.');
    } else {
      h+='<div class="salelist">'+S.sales.map(function(x){
        var d=new Date(x.created);
        var when=d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '
                +d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
        var state = x.refunded ? '<span class="chip mock">Refunded</span>'
                  : (x.status==='succeeded' ? '<span class="chip live">Paid</span>'
                  : '<span class="chip warnc">'+esc(x.status)+'</span>');
        var act='';
        if(!x.refunded && x.status==='succeeded' && me && me.role==='admin'){
          act='<button class="btn ghost sm" onclick="askRefund(\''+esc(x.id)+'\','+x.amountCents+',\''+esc(x.description).replace(/'/g,'')+'\')">Refund</button>';
        }
        return '<div class="salerow">'
          + '<div class="salemain"><b>'+centsFmt(x.amountCents)+'</b> <span class="saledesc">'+esc(x.description)+'</span></div>'
          + '<div class="salemeta">'+esc(when)+' '+state+' '+act+'</div>'
          + '</div>';
      }).join('')+'</div>';
      if(S.salesMore){
        h+='<button class="btn ghost" onclick="moreSales(this)">Show older sales</button>';
      }
    }
    h+='<p class="msg" id="salesMsg"></p></div>';
    return h;
  };

  function loadSales(after){
    var q='pos-history?slug='+encodeURIComponent(slug);
    if(after) q+='&starting_after='+encodeURIComponent(after);
    return api(q).then(function(r){
      if(r.status===200&&r.data.ok){
        S.sales=(after&&S.sales?S.sales:[]).concat(r.data.sales||[]);
        S.salesMore=Boolean(r.data.hasMore);
      } else if(S.sales===undefined){
        S.sales=[]; S.salesMore=false;
      }
      if(S.route==='payments'||S.route==='insights') render();
    });
  }
  window.moreSales=function(btn){
    btn.disabled=true; btn.textContent='Loading…';
    var last=S.sales&&S.sales.length?S.sales[S.sales.length-1].id:'';
    loadSales(last);
  };
  window.askRefund=function(chargeId,amountCents,desc){
    openModal('<h3>Refund this sale?</h3>'
      + '<p class="msub">'+centsFmt(amountCents)+' — '+esc(desc||'Payment')+'<br>'
      + 'The full amount goes back to the client\'s card in 5–10 days. This cannot be undone.</p>'
      + '<div class="mact"><button class="btn danger" onclick="doRefund(this,\''+esc(chargeId)+'\')">Refund '+centsFmt(amountCents)+'</button>'
      + '<button class="btn ghost" onclick="closeModal()">Keep the sale</button></div>'
      + '<p class="msg" id="refundMsg"></p>');
  };
  window.doRefund=function(btn,chargeId){
    btn.disabled=true; btn.textContent='Refunding…';
    api('pos-refund','POST',{slug:slug,chargeId:chargeId}).then(function(r){
      if(r.status===200&&r.data.ok){
        closeModal();
        toast('Refunded — money is on its way back','ok');
        S.sales=undefined; loadSales();
      } else {
        btn.disabled=false; btn.textContent='Try again';
        msg('refundMsg',r.data.error||'Could not issue the refund.');
      }
    });
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

  /* ---------------- calendar (time grid, like GlossGenius) ----------------
     Day view: one column per team member, appointments drawn as blocks on a
     6am–9pm time grid. Week view: seven day columns. Month view: a wall
     calendar. List view: the old upcoming / past list. Tap an empty slot to
     add an appointment or block time off; tap a block to act on it. */
  var CAL_START=6*60, CAL_END=21*60, CAL_PX=1.4;          /* px per minute */
  function calState(){
    if(!S.cal){ var d=new Date(); d.setHours(0,0,0,0); S.cal={mode:'day',date:d.getTime(),staff:'all'}; }
    return S.cal;
  }
  function calDay(ms){ var d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
  function calFmtT(min){ var h=Math.floor(min/60), m=min%60, ap=h>=12?'pm':'am'; h=h%12||12; return h+(m?':'+(m<10?'0':'')+m:'')+ap; }
  function calISO(ms){ var d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function calHM(min){ return String(Math.floor(min/60)).padStart(2,'0')+':'+String(min%60).padStart(2,'0'); }
  function calStatusCls(b){
    var st=String(b.status||'new').toLowerCase();
    return st==='new'?'req':st==='done'?'done':st==='canceled'?'cxl':'ok';
  }
  /* team members: the stylist table when we have it, else whoever has bookings */
  function calStaff(){
    var out=[], seen={};
    ((S.calx&&S.calx.stylists)||[]).forEach(function(t){ var n=String(t.name||'').trim(); if(n&&!seen[n]){ seen[n]=1; out.push({id:t.id,name:n}); } });
    (S.bookings||[]).forEach(function(b){ var n=String(b.stylist||'').trim(); if(n&&!seen[n]){ seen[n]=1; out.push({id:null,name:n}); } });
    if(!out.length) out.push({id:null,name:me&&me.name?me.name:'Team'});
    return out;
  }
  function calOffFor(name, dayMs){
    var x=S.calx||{}, list=[], dayEnd=dayMs+86400000;
    (x.closures||[]).concat((x.timeOff||[]).filter(function(t){return !name||t.stylist===name;})).forEach(function(t){
      var s=Date.parse(t.startsAt), e=Date.parse(t.endsAt);
      if(e>dayMs && s<dayEnd) list.push(t);
    });
    return list;
  }
  function calOffBlocks(list, dayMs){
    return list.map(function(t){
      var s=Math.max(CAL_START,(Date.parse(t.startsAt)-dayMs)/60000), e=Math.min(CAL_END,(Date.parse(t.endsAt)-dayMs)/60000);
      if(e<=s) return '';
      var lab=t.kind==='salon'?'Salon closed':'Time off';
      return '<button class="caloff" style="top:'+((s-CAL_START)*CAL_PX)+'px;height:'+((e-s)*CAL_PX-2)+'px" onclick="openTimeOff(\''+esc(t.id)+'\',\''+esc(t.kind)+'\')" title="'+esc(lab+(t.reason?' · '+t.reason:''))+'"><span>'+esc(lab)+(t.reason?' · '+esc(t.reason):'')+'</span></button>';
    }).join('');
  }
  /* blocks for one column, side by side when two overlap */
  function calBlocks(list, dayMs){
    var out=[];
    list.forEach(function(b){
      var s=new Date(b.startsAt), e=b.endsAt?new Date(b.endsAt):new Date(s.getTime()+60*60000);
      var sm=(s.getHours()*60+s.getMinutes()), em=(e.getTime()-dayMs)/60000;
      if(calDay(s.getTime())!==dayMs) sm=0;
      sm=Math.max(CAL_START,sm); em=Math.min(CAL_END,Math.max(em,sm+15));
      if(em<=CAL_START||sm>=CAL_END) return;
      out.push({b:b,s:sm,e:em,lane:0,lanes:1});
    });
    out.sort(function(a,b){return a.s-b.s;});
    for(var i=0;i<out.length;i++){
      var used={};
      for(var j=0;j<i;j++){ if(out[j].e>out[i].s && out[j].s<out[i].e) used[out[j].lane]=1; }
      var l=0; while(used[l]) l++; out[i].lane=l;
    }
    for(var k=0;k<out.length;k++){ var mx=out[k].lane+1;
      for(var q=0;q<out.length;q++){ if(q!==k && out[q].e>out[k].s && out[q].s<out[k].e) mx=Math.max(mx,out[q].lane+1); }
      out[k].lanes=mx; }
    return out.map(function(x){
      var b=x.b, w=100/x.lanes, left=x.lane*w;
      var s=new Date(b.startsAt), e=b.endsAt?new Date(b.endsAt):null;
      var when=calFmtT(s.getHours()*60+s.getMinutes())+(e?' – '+calFmtT(e.getHours()*60+e.getMinutes()):'');
      return '<button class="calblk '+calStatusCls(b)+'" style="top:'+((x.s-CAL_START)*CAL_PX)+'px;height:'+((x.e-x.s)*CAL_PX-2)+'px;left:'+left+'%;width:calc('+w+'% - 3px)" onclick="event.stopPropagation();openBooking(\''+esc(b.id)+'\')" title="'+esc(when+' · '+(b.name||'Client')+' · '+(b.service||''))+'">'
        + '<span class="cbt">'+esc(when)+'</span><span class="cbn">'+esc(b.name||'Client')+'</span><span class="cbs">'+esc(b.service||'')+'</span></button>';
    }).join('');
  }
  function calGridCols(cols){
    /* cols: [{head, blocks(html), today, day(ms), staff(name)}] */
    var hours='';
    for(var m=CAL_START;m<CAL_END;m+=60) hours+='<div class="calh" style="top:'+((m-CAL_START)*CAL_PX)+'px'+(m===CAL_START?';transform:none':'')+'">'+calFmtT(m)+'</div>';
    var lines='';
    for(var m2=CAL_START;m2<=CAL_END;m2+=30) lines+='<div class="calln'+(m2%60?' half':'')+'" style="top:'+((m2-CAL_START)*CAL_PX)+'px"></div>';
    var h='<div class="calwrap"><div class="calgrid" style="grid-template-columns:56px repeat('+cols.length+',minmax(150px,1fr))">'
      + '<div class="calcorner"></div>'+cols.map(function(c){return '<div class="calhead'+(c.today?' today':'')+'">'+c.head+'</div>';}).join('')
      + '<div class="caltimes" style="height:'+((CAL_END-CAL_START)*CAL_PX)+'px">'+hours+'</div>'
      + cols.map(function(c){return '<div class="calcol'+(c.today?' today':'')+'" style="height:'+((CAL_END-CAL_START)*CAL_PX)+'px" data-day="'+c.day+'" data-staff="'+esc(c.staff||'')+'" onclick="calSlotClick(event,this)" title="Tap an empty spot to add">'+lines+c.blocks+'</div>';}).join('')
      + '</div></div>';
    return h;
  }
  function calNowLine(dayMs){
    var n=new Date(); if(calDay(n.getTime())!==dayMs) return '';
    var m=n.getHours()*60+n.getMinutes(); if(m<CAL_START||m>CAL_END) return '';
    return '<div class="calnow" style="top:'+((m-CAL_START)*CAL_PX)+'px"></div>';
  }
  window.calSlotClick=function(ev,col){
    if(ev.target!==col && !ev.target.classList.contains('calln')) return;   /* a block handled it */
    var rect=col.getBoundingClientRect(), y=ev.clientY-rect.top;
    var min=CAL_START+Math.floor(y/CAL_PX/15)*15;
    openCalAdd({day:Number(col.getAttribute('data-day')), min:min, staff:col.getAttribute('data-staff')||''});
  };
  VIEWS.calendar=function(){
    var c=calState(), all=(S.bookings||[]).filter(function(b){return b&&b.startsAt&&String(b.status||'').toLowerCase()!=='canceled';});
    var staff=calStaff(), names=staff.map(function(x){return x.name;});
    var d=new Date(c.date), today=calDay(Date.now());
    var title = c.mode==='week'
      ? (function(){ var s=new Date(c.date); s.setDate(s.getDate()-s.getDay()); var e=new Date(s); e.setDate(e.getDate()+6);
          return s.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' – '+e.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); })()
      : c.mode==='month' ? d.toLocaleDateString(undefined,{month:'long',year:'numeric'})
      : d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric'});
    var reqs=(S.bookings||[]).filter(function(b){return String(b.status||'new').toLowerCase()==='new';}).length;
    var h='<div class="card calcard"><div class="calbar">'
      + '<div class="calnav"><button class="btn ghost sm" onclick="calMove(-1)" aria-label="Back">‹</button>'
      + '<button class="btn ghost sm" onclick="calToday()">Today</button>'
      + '<button class="btn ghost sm" onclick="calMove(1)" aria-label="Forward">›</button>'
      + '<b class="caltitle">'+esc(title)+'</b></div>'
      + '<div class="calnav"><div class="seg">'
      + '<button class="'+(c.mode==='day'?'on':'')+'" onclick="calMode(\'day\')">Day</button>'
      + '<button class="'+(c.mode==='week'?'on':'')+'" onclick="calMode(\'week\')">Week</button>'
      + '<button class="'+(c.mode==='month'?'on':'')+'" onclick="calMode(\'month\')">Month</button>'
      + '<button class="'+(c.mode==='list'?'on':'')+'" onclick="calMode(\'list\')">List'+(reqs?' <span class="cnt">'+reqs+'</span>':'')+'</button></div>'
      + (names.length>1?'<select class="calsel" onchange="calStaffPick(this.value)"><option value="all"'+(c.staff==='all'?' selected':'')+'>All team members</option>'
          + names.map(function(n){return '<option value="'+esc(n)+'"'+(c.staff===n?' selected':'')+'>'+esc(n)+'</option>';}).join('')+'</select>':'')
      + '<button class="btn sm" onclick="openCalAdd({})">+ Add</button>'
      + '</div></div>';
    if(c.mode==='list') return h+calListBody()+'</div>';
    var shown = c.staff==='all' ? names : names.filter(function(n){return n===c.staff;});
    var mine = all.filter(function(b){ return c.staff==='all' || String(b.stylist||'').trim()===c.staff || !String(b.stylist||'').trim(); });
    if(c.mode==='month'){ return h+calMonthBody(mine)+'</div>'; }
    if(c.mode==='day'){
      var dayList=mine.filter(function(b){return calDay(new Date(b.startsAt).getTime())===c.date;});
      var cols=shown.map(function(n){
        var list=dayList.filter(function(b){return String(b.stylist||'').trim()===n;});
        return {head:'<span class="calav">'+esc(initials(n))+'</span><span>'+esc(n)+'</span><small>'+list.length+'</small>', blocks:calOffBlocks(calOffFor(n,c.date),c.date)+calBlocks(list,c.date)+calNowLine(c.date), today:c.date===today, day:c.date, staff:n};
      });
      var loose=dayList.filter(function(b){return !String(b.stylist||'').trim();});
      if(loose.length) cols.push({head:'<span class="calav">?</span><span>Unassigned</span><small>'+loose.length+'</small>', blocks:calBlocks(loose,c.date), today:false, day:c.date, staff:''});
      if(!dayList.length) h+='<p class="hint" style="margin:0 0 8px">Nothing booked this day'+(c.staff!=='all'?' for '+esc(c.staff):'')+'. Tap an empty spot to add something.</p>';
      h+=calGridCols(cols);
    } else {
      var s0=new Date(c.date); s0.setDate(s0.getDate()-s0.getDay());
      var cols2=[];
      for(var i=0;i<7;i++){
        var dm=new Date(s0); dm.setDate(dm.getDate()+i); var dayMs=dm.getTime();
        var list=mine.filter(function(b){return calDay(new Date(b.startsAt).getTime())===dayMs;});
        var off=c.staff==='all'?calOffFor(null,dayMs).filter(function(t){return t.kind==='salon';}):calOffFor(c.staff,dayMs);
        cols2.push({head:'<span>'+esc(dm.toLocaleDateString(undefined,{weekday:'short'}))+'</span><b>'+dm.getDate()+'</b><small>'+list.length+'</small>', blocks:calOffBlocks(off,dayMs)+calBlocks(list,dayMs)+calNowLine(dayMs), today:dayMs===today, day:dayMs, staff:c.staff==='all'?'':c.staff});
      }
      h+=calGridCols(cols2);
    }
    return h+'<p class="hint" style="margin:10px 0 0">Tap an appointment to confirm, check out, complete or cancel it. Tap an empty spot to add an appointment or time off.</p></div>';
  };
  function calMonthBody(mine){
    var c=calState(), d=new Date(c.date), today=calDay(Date.now());
    var first=new Date(d.getFullYear(),d.getMonth(),1), start=new Date(first); start.setDate(1-first.getDay());
    var h='<div class="calmonth"><div class="cmhead">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(x){return '<div>'+x+'</div>';}).join('')+'</div><div class="cmgrid">';
    for(var i=0;i<42;i++){
      var dm=new Date(start); dm.setDate(dm.getDate()+i); var dayMs=dm.getTime();
      if(i===35 && dm.getMonth()!==d.getMonth()) break;
      var list=mine.filter(function(b){return calDay(new Date(b.startsAt).getTime())===dayMs;}).sort(function(a,b){return new Date(a.startsAt)-new Date(b.startsAt);});
      var off=calOffFor(c.staff==='all'?null:c.staff,dayMs);
      var cls='cmday'+(dm.getMonth()!==d.getMonth()?' other':'')+(dayMs===today?' today':'');
      h+='<div class="'+cls+'" onclick="calOpenDay('+dayMs+')"><div class="cmn">'+dm.getDate()+'</div>';
      if(off.length) h+='<div class="cmoff">'+esc(off.some(function(t){return t.kind==='salon';})?'Closed':'Time off')+'</div>';
      list.slice(0,3).forEach(function(b){ var s=new Date(b.startsAt);
        h+='<div class="cmb '+calStatusCls(b)+'" onclick="event.stopPropagation();openBooking(\''+esc(b.id)+'\')"><b>'+esc(calFmtT(s.getHours()*60+s.getMinutes()))+'</b> '+esc(b.name||'Client')+'</div>'; });
      if(list.length>3) h+='<div class="cmmore">+'+(list.length-3)+' more</div>';
      h+='</div>';
    }
    return h+'</div></div>';
  }
  function calListBody(){
    var up=[],past=[];
    S.bookings.forEach(function(b){
      var s=String(b.status||'').toLowerCase();
      (s==='done'||s==='canceled'?past:up).push(b);
    });
    var list = S.tab==='past'?past:up;
    var h='<div class="rowbtw" style="margin-top:10px"><p class="sub" style="margin:0">Tap any booking to confirm, complete or cancel.</p>'
     + '<div class="seg"><button class="'+(S.tab==='upcoming'?'on':'')+'" onclick="setTab(\'upcoming\')">Upcoming ('+up.length+')</button>'
     + '<button class="'+(S.tab==='past'?'on':'')+'" onclick="setTab(\'past\')">Past ('+past.length+')</button></div></div>';
    h+= list.length ? '<div class="lst">'+list.map(bookingRow).join('')+'</div>'
                    : empty('✓', S.tab==='past'?'Nothing here yet.':'No upcoming bookings.');
    return h;
  }
  window.calMove=function(n){ var c=calState(), d=new Date(c.date);
    if(c.mode==='month'){ d.setDate(1); d.setMonth(d.getMonth()+n); } else d.setDate(d.getDate()+n*(c.mode==='week'?7:1));
    c.date=d.getTime(); render(); };
  window.calToday=function(){ calState().date=calDay(Date.now()); render(); };
  window.calMode=function(m){ calState().mode=m; render(); };
  window.calStaffPick=function(v){ calState().staff=v; render(); };
  window.calOpenDay=function(ms){ var c=calState(); c.date=ms; c.mode='day'; render(); };
  window.setTab=function(t){ S.tab=t; render(); };

  /* ---- add an appointment / time off ---- */
  function calSvcOpts(){
    var svcs=(S.calx&&S.calx.services)||[];
    if(!svcs.length) return '<p class="msub">No services set up yet — the appointment will be saved without one.</p>';
    var cat='', h='<div class="svclist">';
    svcs.forEach(function(sv){
      if(sv.category!==cat){ cat=sv.category; if(cat) h+='<div class="svccat">'+esc(cat)+'</div>'; }
      h+='<label class="svcopt"><input type="checkbox" class="svcchk" value="'+esc(sv.id)+'" data-min="'+sv.minutes+'" onchange="calSumMinutes()"> <span>'+esc(sv.name)+'</span><small>'+sv.minutes+' min · $'+(sv.priceCents/100).toFixed(2).replace(/\.00$/,'')+'</small></label>';
    });
    return h+'</div>';
  }
  window.calSumMinutes=function(){
    var sum=0; document.querySelectorAll('.svcchk:checked').forEach(function(x){ sum+=Number(x.getAttribute('data-min'))||0; });
    var el=$('ca-min'); if(el && sum) el.value=sum;
  };
  window.openCalAdd=function(pre){
    pre=pre||{};
    var c=calState(), day=pre.day||c.date, min=pre.min!=null?pre.min:10*60;
    var staff=calStaff().filter(function(x){return x.id;});
    var picked=pre.staff||(c.staff!=='all'?c.staff:'');
    if(!S.calx){ loadCalExtra().then(function(){ openCalAdd(pre); }); return openModal('<h3>Add</h3><p class="msub">One second…</p>'); }
    var h='<h3>Add to the calendar</h3>'
      + '<div class="seg" style="margin:6px 0 10px"><button class="on" id="ca-tab-appt" onclick="calAddTab(\'appt\')">Appointment</button><button id="ca-tab-off" onclick="calAddTab(\'off\')">Time off</button></div>'
      + '<div id="ca-appt">'
      + '<div class="fld"><label for="ca-sty">With</label><select id="ca-sty">'+staff.map(function(x){return '<option value="'+esc(x.id)+'"'+(x.name===picked?' selected':'')+'>'+esc(x.name)+'</option>';}).join('')+'</select></div>'
      + '<div class="frow"><div class="fld"><label for="ca-date">Date</label><input id="ca-date" type="date" value="'+calISO(day)+'"></div>'
      + '<div class="fld"><label for="ca-start">Start</label><input id="ca-start" type="time" step="300" value="'+calHM(min)+'"></div>'
      + '<div class="fld"><label for="ca-min">Minutes</label><input id="ca-min" type="number" min="5" step="5" value="60"></div></div>'
      + '<div class="fld"><label for="ca-name">Client name</label><input id="ca-name" placeholder="Walk-in"></div>'
      + '<div class="frow"><div class="fld"><label for="ca-phone">Phone</label><input id="ca-phone" type="tel"></div><div class="fld"><label for="ca-email">Email</label><input id="ca-email" type="email"></div></div>'
      + '<label>Services</label>'+calSvcOpts()
      + '<div class="fld"><label for="ca-note">Note</label><input id="ca-note" placeholder="Anything to remember"></div>'
      + '<label class="chkrow" style="margin-top:12px"><input type="checkbox" id="ca-notify"> Send the client a confirmation now and a reminder the day before (email / text). Leave off if they already get these from your old software.</label>'
      + '<div class="mact"><button class="btn" onclick="calAddSave(this)">Add appointment</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div><p class="msg" id="caMsg"></p>'
      + '</div>'
      + '<div id="ca-off" class="hidden">'
      + '<div class="fld"><label for="co-sty">Who</label><select id="co-sty">'+(me&&me.role==='admin'?'<option value="salon">Whole salon (closed)</option>':'')+staff.map(function(x){return '<option value="'+esc(x.id)+'"'+(x.name===picked?' selected':'')+'>'+esc(x.name)+'</option>';}).join('')+'</select></div>'
      + '<label class="chkrow" style="margin-top:12px"><input type="checkbox" id="co-allday" checked onchange="calOffAllDay()"> All day</label>'
      + '<div class="frow"><div class="fld"><label for="co-from">From</label><input id="co-from" type="date" value="'+calISO(day)+'"></div><div class="fld co-time"><label for="co-fromt">Time</label><input id="co-fromt" type="time" step="300" value="'+calHM(min)+'"></div></div>'
      + '<div class="frow"><div class="fld"><label for="co-to">To</label><input id="co-to" type="date" value="'+calISO(day)+'"></div><div class="fld co-time"><label for="co-tot">Time</label><input id="co-tot" type="time" step="300" value="'+calHM(Math.min(min+60,23*60+55))+'"></div></div>'
      + '<div class="fld"><label for="co-reason">Reason (optional)</label><input id="co-reason" placeholder="Vacation, sick day, training…"></div>'
      + '<div class="mact"><button class="btn" onclick="calOffSave(this)">Block this time</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div><p class="msg" id="coMsg"></p>'
      + '</div>';
    openModal(h);
    if(pre.off) calAddTab('off');
    calOffAllDay();
  };
  window.calAddTab=function(t){
    $('ca-appt').classList.toggle('hidden',t!=='appt'); $('ca-off').classList.toggle('hidden',t!=='off');
    $('ca-tab-appt').classList.toggle('on',t==='appt'); $('ca-tab-off').classList.toggle('on',t==='off');
  };
  window.calOffAllDay=function(){ var all=$('co-allday')&&$('co-allday').checked; document.querySelectorAll('.co-time').forEach(function(el){ el.classList.toggle('hidden',!!all); }); };
  window.calAddSave=function(btn){
    hideMsg('caMsg'); btn.disabled=true;
    var ids=[]; document.querySelectorAll('.svcchk:checked').forEach(function(x){ ids.push(x.value); });
    api('calendar-edit','POST',{slug:slug,action:'add',stylistId:$('ca-sty').value,date:$('ca-date').value,start:$('ca-start').value,minutes:Number($('ca-min').value)||60,
      clientName:$('ca-name').value.trim(),phone:$('ca-phone').value.trim(),email:$('ca-email').value.trim(),serviceIds:ids,note:$('ca-note').value.trim(),notify:$('ca-notify').checked}).then(function(r){
      btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return msg('caMsg',(r.data&&r.data.error)||'Could not add that.');
      closeModal(); toast(r.data.notified?'Added — confirmation sent':'Added','ok');
      var d=new Date($('ca-date').value+'T00:00:00'); if(!isNaN(d)) calState().date=d.getTime();
      loadBookings();
    });
  };
  window.calOffSave=function(btn){
    hideMsg('coMsg'); btn.disabled=true;
    var all=$('co-allday').checked, f=$('co-from').value, t=$('co-to').value||f;
    var from=new Date(f+'T'+(all?'00:00':$('co-fromt').value||'00:00')+':00'), to=new Date(t+'T'+(all?'23:59':$('co-tot').value||'23:59')+':00');
    if(isNaN(from)||isNaN(to)){ btn.disabled=false; return msg('coMsg','Pick the dates first.'); }
    api('calendar-edit','POST',{slug:slug,action:'timeoff',stylistId:$('co-sty').value,startsAt:from.toISOString(),endsAt:to.toISOString(),reason:$('co-reason').value.trim()}).then(function(r){
      btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return msg('coMsg',(r.data&&r.data.error)||'Could not block that time.');
      closeModal(); toast('Time blocked off','ok');
      calState().date=calDay(from.getTime());
      loadCalExtra();
    });
  };
  window.openTimeOff=function(id,kind){
    var x=S.calx||{}, t=(kind==='salon'?x.closures:x.timeOff).filter(function(o){return String(o.id)===String(id);})[0];
    if(!t) return;
    var f=new Date(t.startsAt), e=new Date(t.endsAt);
    var fmt=function(d){ return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); };
    openModal('<h3>'+(kind==='salon'?'Salon closed':'Time off'+(t.stylist?' — '+esc(t.stylist):''))+'</h3><p class="msub">'+esc(fmt(f)+' → '+fmt(e))+(t.reason?' · '+esc(t.reason):'')+'</p>'
      + '<div class="mact"><button class="btn ghost danger" onclick="calOffDelete(\''+esc(id)+'\',\''+esc(kind)+'\')">Remove</button><button class="btn ghost" onclick="closeModal()">Close</button></div>');
  };
  window.calOffDelete=function(id,kind){
    api('calendar-edit','POST',{slug:slug,action:'timeoff-delete',id:id,kind:kind}).then(function(r){
      closeModal();
      if(!(r.status===200&&r.data.ok)) return toast((r.data&&r.data.error)||'Could not remove that','err');
      toast('Removed','ok'); loadCalExtra();
    });
  };
  function loadCalExtra(){
    return api('calendar-edit?slug='+encodeURIComponent(slug)).then(function(r){
      if(r.status===200&&r.data.ok) S.calx={stylists:r.data.stylists||[],services:r.data.services||[],timeOff:r.data.timeOff||[],closures:r.data.closures||[]};
      else if(!S.calx) S.calx={stylists:[],services:[],timeOff:[],closures:[]};
      if(S.route==='calendar') render();
    });
  }
  window.loadCalExtra=loadCalExtra;

  /* ---------------- my profile (card on the booking site + the bookings switch) ----------------
     A stylist edits her own card: photo, title, what she does, bio,
     Instagram, instant vs ask-first, and which services she offers at her
     own price and time. The owner can edit anyone's. OFF on the switch =
     gone from the booking site until it is turned back on. */
  function profPick(){
    var a=S.avail||{};
    if(me&&me.role==='admin'){ return (a.team||[]).filter(function(p){return p.id===S.profSel;})[0]||null; }
    return a.mine||null;
  }
  function money(c){ return (Number(c||0)/100).toFixed(2).replace(/\.00$/,''); }
  /* the editable card for one person */
  function profEditor(p, a, inline){
    var isAdmin=me&&me.role==='admin', svcs=a.services||[], cat='';
    var offer={}; (p.offers||[]).forEach(function(o){ offer[o.serviceId]=o; });
    var h='<div class="'+(inline?'profinline':'card')+'"><div class="rowbtw"><div><h2>'+(inline?esc(p.name):'My profile')+'</h2>'
      + '<p class="sub">This is the card clients see on the booking site.</p></div>'
      + '<div>'+(p.accepting?'<span class="chip live">Taking bookings</span> ':'<span class="chip critc">Not taking bookings</span> ')
      + '<button class="btn '+(p.accepting?'ghost':'')+' sm" onclick="setAvail(\''+esc(p.id)+'\','+(p.accepting?'false':'true')+',this)">'+(p.accepting?'Turn off':'Turn on')+'</button>'
      + (inline?' <button class="btn ghost sm" onclick="profSelect(null)">Close</button>':'')+'</div></div>'
      + '<div class="profhead"><div class="profav">'+(p.photoUrl?'<img src="'+esc(p.photoUrl)+'" alt="">':'<span>'+esc(initials(p.name))+'</span>')+'</div>'
      + '<div><label class="btn ghost sm upl">'+(p.photoUrl?'Change photo':'Add a photo')+'<input type="file" accept="image/*" hidden onchange="profPhoto(\''+esc(p.id)+'\',this)"></label>'
      + '<p class="hint" style="margin:6px 0 0">A clear head-and-shoulders shot works best. It\'s cropped to a square.</p></div></div>'
      + (isAdmin?'<div class="fld"><label for="pf-name">Name</label><input id="pf-name" value="'+esc(p.name)+'"></div>':'')
      + '<div class="frow"><div class="fld"><label for="pf-role">Title</label><input id="pf-role" placeholder="Hairstylist, Nail Tech, Esthetician…" value="'+esc(p.role)+'"></div>'
      + '<div class="fld"><label for="pf-spec">'+(inline?'Known for':'What you\'re known for')+'</label><input id="pf-spec" placeholder="Color & long haircuts" value="'+esc(p.specialty)+'"></div></div>'
      + '<div class="fld"><label for="pf-bio">'+(inline?'About':'About you')+'</label><textarea id="pf-bio" rows="4" placeholder="A couple of friendly sentences — who you are, what you love doing, what clients can expect.">'+esc(p.bio)+'</textarea></div>'
      + '<div class="frow"><div class="fld"><label for="pf-ig">Instagram</label><input id="pf-ig" placeholder="yourhandle" value="'+esc(p.instagram)+'"></div>'
      + '<div class="fld"><label for="pf-mode">How clients book</label><select id="pf-mode"><option value="instant"'+(p.bookingMode!=='request'?' selected':'')+'>Book instantly</option><option value="request"'+(p.bookingMode==='request'?' selected':'')+'>Ask first (stylist confirms)</option></select></div></div>'
      + '<label style="margin-top:16px">Services offered</label><p class="hint" style="margin:0 0 6px">Tick what she does. Change the price or minutes if hers differ from the salon\'s menu.</p>';
    if(!svcs.length) h+='<p class="hint">No services on the menu yet — the owner adds them under Services.</p>';
    else{
      h+='<div class="svclist" style="max-height:none">';
      svcs.forEach(function(sv){
        if(sv.category!==cat){ cat=sv.category; if(cat) h+='<div class="svccat">'+esc(cat)+'</div>'; }
        var o=offer[sv.id];
        h+='<div class="svcrow"><label class="svcopt" style="flex:1"><input type="checkbox" class="pf-svc" value="'+esc(sv.id)+'"'+(o?' checked':'')+' onchange="this.closest(\'.svcrow\').classList.toggle(\'on\',this.checked)"> <span>'+esc(sv.name)+'</span></label>'
          + '<span class="svcnum">$<input type="number" min="0" step="1" class="pf-price" data-id="'+esc(sv.id)+'" value="'+money(o?o.priceCents:sv.priceCents)+'"></span>'
          + '<span class="svcnum"><input type="number" min="5" step="5" class="pf-min" data-id="'+esc(sv.id)+'" value="'+(o?o.minutes:sv.minutes)+'"> min</span></div>';
      });
      h+='</div>';
    }
    var cats=[]; svcs.forEach(function(sv){ if(sv.category&&cats.indexOf(sv.category)<0) cats.push(sv.category); });
    h+='<div class="svcadd"><b>Offer something that isn\'t on the list?</b><p class="hint" style="margin:2px 0 8px">Add it here — it goes on the salon\'s menu under the category you pick, bookable with '+(inline?'her':'you')+'.</p>'
      + '<div class="frow"><div class="fld" style="margin-top:0;flex:2"><label for="ns-svc">Service</label><input id="ns-svc" placeholder="e.g. Lash lift"></div>'
      + '<div class="fld" style="margin-top:0"><label for="ns-cat">Category</label><input id="ns-cat" list="ns-cats" placeholder="Nails, Color…"><datalist id="ns-cats">'+cats.map(function(c){return '<option value="'+esc(c)+'">';}).join('')+'</datalist></div>'
      + '<div class="fld" style="margin-top:0;flex:0 0 90px"><label for="ns-price">Price $</label><input id="ns-price" type="number" min="0" step="1"></div>'
      + '<div class="fld" style="margin-top:0;flex:0 0 90px"><label for="ns-min">Minutes</label><input id="ns-min" type="number" min="5" step="5" value="60"></div></div>'
      + '<button class="btn ghost sm" style="margin-top:8px" onclick="profAddService(\''+esc(p.id)+'\',this)">Add service</button></div>';
    h+='<div class="vacts"><button class="btn" onclick="profSave(\''+esc(p.id)+'\',this)">Save '+(inline?'card':'my card')+'</button>'+(inline?'<button class="btn ghost" onclick="profSelect(null)">Close</button>':'')+'</div><p class="msg" id="pfMsg"></p></div>';
    return h;
  }
  VIEWS.availability=function(){
    var a=S.avail;
    if(a===undefined){ return '<div class="card"><h2>My profile</h2>'+empty('◐','Loading…')+'</div>'; }
    if(a===null){ return '<div class="card"><h2>My profile</h2>'+empty('◐','Could not load this right now — try again in a moment.')+'</div>'; }
    var isAdmin=me&&me.role==='admin', h='';
    if(isAdmin){
      h+='<div class="card"><h2>Team</h2><p class="sub">Tap a person to open her card and make changes, or switch her bookings on and off. Off means she disappears from the booking site until it\'s turned back on; what\'s already on her calendar stays.</p>';
      var team=a.team||[];
      if(!team.length) h+='<p class="hint">No team members yet — add one under Staff.</p>';
      else{
        h+='<div class="lst">';
        team.forEach(function(p){
          var open=p.id===S.profSel;
          h+=availCard(p, true, open);
          if(open) h+=profEditor(p, a, true);
        });
        h+='</div>';
      }
      return h+'</div>';
    }
    var p=a.mine;
    if(!p) return '<div class="card"><h2>My profile</h2><p class="hint">You\'re not on the booking site\'s team list yet. Add yourself — you start hidden, and nothing shows to clients until you turn bookings on.</p><button class="btn" onclick="joinTeam(this)">Add me to the team</button></div>';
    return profEditor(p, a, false);
  };
  function availCard(p, canEdit, selected){
    return '<div class="li static'+(selected?' sel':'')+'"><div class="av">'+(p.photoUrl?'<img src="'+esc(p.photoUrl)+'" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':esc(initials(p.name)))+'</div>'
      + '<div class="bd" style="cursor:pointer" onclick="profSelect(\''+esc(p.id)+'\')"><div class="t1">'+esc(p.name)+' '+(p.accepting?'<span class="chip live">Taking bookings</span>':'<span class="chip critc">Not taking bookings</span>')+'</div>'
      + '<div class="t2">'+esc(p.role||'')+(p.specialty?' · '+esc(p.specialty):'')+(!p.photoUrl||!p.bio?' · <span style="color:var(--warn)">card not finished</span>':'')+'</div></div>'
      + (canEdit?'<div class="vacts"><button class="btn ghost sm" onclick="profSelect(\''+esc(p.id)+'\')">'+(selected?'Close':'Edit')+'</button><button class="btn '+(p.accepting?'ghost':'')+' sm" onclick="setAvail(\''+esc(p.id)+'\','+(p.accepting?'false':'true')+',this)">'+(p.accepting?'Turn off':'Turn on')+'</button></div>':'')
      + '</div>';
  }
  window.profSelect=function(id){ S.profSel=(id&&S.profSel===id)?null:id; render(); var el=document.querySelector('.li.sel'); if(el&&id) el.scrollIntoView({behavior:'smooth',block:'start'}); };
  window.profSave=function(id,btn){
    hideMsg('pfMsg'); btn.disabled=true;
    var offers=profOffers();
    var nm=$('pf-name');
    api('availability','POST',{slug:slug,action:'profile',stylistId:id,name:nm?nm.value.trim():undefined,role:$('pf-role').value.trim(),specialty:$('pf-spec').value.trim(),bio:$('pf-bio').value.trim(),instagram:$('pf-ig').value.trim(),bookingMode:$('pf-mode').value,offers:offers}).then(function(r){
      btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return msg('pfMsg',(r.data&&r.data.error)||'Could not save.');
      S.avail={mine:r.data.mine,team:r.data.team||[],services:r.data.services||[]};
      toast('Saved','ok'); loadCalExtra(); render();
    });
  };
  function profOffers(){
    var offers=[]; document.querySelectorAll('.pf-svc:checked').forEach(function(x){
      var pr=document.querySelector('.pf-price[data-id="'+x.value+'"]'), mn=document.querySelector('.pf-min[data-id="'+x.value+'"]');
      offers.push({serviceId:x.value, priceCents:Math.round(parseFloat(pr&&pr.value||'0')*100), minutes:parseInt(mn&&mn.value||'0',10)});
    });
    return offers;
  }
  window.profAddService=function(id,btn){
    hideMsg('pfMsg');
    var name=$('ns-svc').value.trim(); if(!name) return msg('pfMsg','Give the service a name first.');
    btn.disabled=true;
    api('availability','POST',{slug:slug,action:'service-add',stylistId:id,name:name,category:$('ns-cat').value.trim(),priceCents:Math.round(parseFloat($('ns-price').value||'0')*100),minutes:parseInt($('ns-min').value||'60',10),offers:profOffers()}).then(function(r){
      btn.disabled=false;
      if(!(r.status===200&&r.data.ok)) return msg('pfMsg',(r.data&&r.data.error)||'Could not add that service.');
      S.avail={mine:r.data.mine,team:r.data.team||[],services:r.data.services||[]};
      toast('Added and ticked for you','ok'); render();
      var el=document.querySelector('.svcadd'); if(el) el.scrollIntoView({behavior:'smooth',block:'center'});
    });
  };
  window.profPhoto=function(id,input){
    var f=input.files&&input.files[0]; if(!f) return;
    toast('Uploading photo…');
    svResize(f, 900, false, function(dataUrl){
      if(!dataUrl) return toast('Could not read that image','err');
      api('availability','POST',{slug:slug,action:'photo',stylistId:id,data:dataUrl}).then(function(r){
        if(!(r.status===200&&r.data.ok)) return toast((r.data&&r.data.error)||'Upload failed','err');
        S.avail={mine:r.data.mine,team:r.data.team||[],services:r.data.services||[]};
        toast('Photo saved','ok'); render();
      });
    });
  };
  window.setAvail=function(id,on,btn){
    if(btn) btn.disabled=true;
    api('availability','POST',{slug:slug,stylistId:id,accepting:on}).then(function(r){
      if(!(r.status===200&&r.data.ok)){ if(btn) btn.disabled=false; return toast((r.data&&r.data.error)||'Could not change that','err'); }
      S.avail={mine:r.data.mine,team:r.data.team||[],services:r.data.services||[]};
      toast(on?'Back on — clients can book again':'Off — hidden from the booking site','ok');
      loadCalExtra(); render();
    });
  };
  window.joinTeam=function(btn){
    if(btn) btn.disabled=true;
    api('availability','POST',{slug:slug,action:'join'}).then(function(r){
      if(!(r.status===200&&r.data.ok)){ if(btn) btn.disabled=false; return toast((r.data&&r.data.error)||'Could not add you','err'); }
      S.avail={mine:r.data.mine,team:r.data.team||[],services:r.data.services||[]}; toast('You\'re on the team — finish your card, then turn bookings on','ok'); loadCalExtra(); render();
    });
  };
  function loadAvailability(){
    return api('availability?slug='+encodeURIComponent(slug)).then(function(r){
      S.avail = (r.status===200&&r.data.ok) ? {mine:r.data.mine,team:r.data.team||[],services:r.data.services||[]} : null;
      if(S.route==='availability') render();
    });
  }

  /* ---------------- clients (real list from the client table) ---------------- */
  function clientRow(c){
    var hay=((c.name||'')+' '+(c.email||'')+' '+(c.phone||'')).toLowerCase();
    return '<div class="li static" data-hay="'+esc(hay)+'"><input type="checkbox" class="bchk-clients" data-id="'+esc(c.id)+'" onclick="bulkSync(\'clients\')" style="margin-right:10px;flex:none"><div class="av">'+esc(initials(c.name||c.email||'?'))+'</div>'
      + '<div class="bd" style="cursor:pointer" onclick="openClient(\''+esc(c.id)+'\')"><div class="t1">'+esc(c.name||'Client')+'</div>'
      + '<div class="t2">'+esc(c.email||'')+(c.phone?(c.email?' · ':'')+esc(c.phone):'')+' · <span style="color:var(--accent)">view history</span></div></div></div>';
  }
  function cliMoney(cents){ return '$'+(Number(cents||0)/100).toFixed(2); }
  function cliWhen(iso){ if(!iso) return '—'; var d=new Date(iso); return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); }
  window.openClient=function(id){
    openModal('<h3>Client</h3><p class="msub">Loading history…</p>');
    api('clients?slug='+encodeURIComponent(slug)+'&client='+encodeURIComponent(id)).then(function(r){
      if(!(r.status===200&&r.data.ok)){
        return openModal('<h3>Client</h3><p class="msub">'+esc((r.data&&r.data.error)||'Could not load this client.')+'</p><div class="mact"><button class="btn ghost" onclick="closeModal()">Close</button></div>');
      }
      var cli=r.data.client, st=cli.stats||{};
      var h='<h3>'+esc(cli.name||'Client')+'</h3>'
        + '<p class="msub">'+esc(cli.email||'')+(cli.phone?(cli.email?' · ':'')+esc(cli.phone):'')+'</p>'
        + '<div class="tiles" style="margin:12px 0">'
        + tile('Visits', String(st.completed||0), (st.total&&st.total!==st.completed)?(st.total+' incl. upcoming'):'Completed')
        + tile('Total spent', cliMoney(st.totalSpentCents), 'Completed visits')
        + tile('No-shows', String(st.noShows||0), st.noShows?'Heads up':'None')
        + tile('Last visit', cliWhen(st.lastVisit), '')
        + '</div>'
        + '<div class="fld"><label for="cli-notes">Private notes</label><textarea id="cli-notes" rows="3" placeholder="Preferences, allergies, colour formula, anything to remember…">'+esc(cli.notes||'')+'</textarea></div>'
        + '<div class="vacts"><button class="btn" onclick="saveClientNote(this,\''+esc(cli.id)+'\')">Save notes</button></div><p class="msg" id="cnMsg"></p>'
        + '<h4 style="margin:14px 0 6px">Visit history</h4>';
      if(!cli.visits||!cli.visits.length){ h+='<p class="msub">No appointments yet.</p>'; }
      else{
        h+='<div class="lst">'+cli.visits.map(function(v){
          var sc = v.status==='completed'?'<span class="chip neut">Done</span>'
                 : v.status==='no_show'?'<span class="chip critc">No-show</span>'
                 : v.status==='confirmed'?'<span class="chip live">Confirmed</span>'
                 : (v.status==='cancelled'||v.status==='declined')?'<span class="chip mock">Canceled</span>'
                 : '<span class="chip warnc">'+esc(v.status||'')+'</span>';
          return '<div class="li static"><div class="bd"><div class="t1">'+cliWhen(v.startsAt)+' '+sc+'</div>'
            + '<div class="t2">'+esc(v.service||'Appointment')+(v.stylist?' · '+esc(v.stylist):'')+(v.priceCents?' · '+cliMoney(v.priceCents):'')+'</div></div></div>';
        }).join('')+'</div>';
      }
      h+='<div class="mact"><button class="btn ghost" onclick="closeModal()">Close</button></div>';
      openModal(h);
    });
  };
  window.saveClientNote=function(btn,id){
    hideMsg('cnMsg'); btn.disabled=true;
    api('clients','POST',{slug:slug,action:'note',id:id,notes:$('cli-notes').value}).then(function(r){
      btn.disabled=false;
      if(r.status===200&&r.data.ok) msg('cnMsg','Saved',true); else msg('cnMsg',(r.data&&r.data.error)||'Could not save.');
    });
  };
  VIEWS.clients=function(){
    var h='<div class="card"><div class="rowbtw"><div><h2>Clients</h2>'
      + '<p class="sub">Everyone who has booked with you or that you imported. Search by name, email or phone.</p></div>'
      + '<button class="btn ghost sm" onclick="go(\'import\')">Import clients</button></div>';
    if(S.clients===undefined){ return h+empty('☺','Loading your clients…')+'</div>'; }
    if(!S.clients.length){ return h+empty('☺','No clients yet — import your list, or they build up as people book.')+'</div>'; }
    h+='<div class="fld"><input id="cliSearch" type="search" placeholder="Search '+S.clients.length+' clients…" oninput="filterClients(this.value)"></div>'
      + bulkBar('clients')
      + '<div class="lst" id="cliList">'+S.clients.map(clientRow).join('')+'</div>';
    return h+'</div>';
  };
  window.filterClients=function(q){
    q=String(q||'').toLowerCase().trim();
    var list=document.getElementById('cliList'); if(!list) return;
    Array.prototype.forEach.call(list.children,function(el){
      var hay=el.getAttribute('data-hay')||'';
      el.style.display=(!q||hay.indexOf(q)!==-1)?'':'none';
    });
  };

  /* ---------------- insights (real numbers from loaded data) ---------------- */
  VIEWS.insights=function(){
    var bs=S.bookings||[], now=Date.now(), MO=30*24*3600*1000;
    var upcoming=bs.filter(function(b){return b.startsAt && new Date(b.startsAt).getTime()>=now && String(b.status||'').toLowerCase()!=='canceled';});
    var needReply=bs.filter(function(b){return String(b.status||'new').toLowerCase()==='new';});
    var done=bs.filter(function(b){return String(b.status||'').toLowerCase()==='done';});
    var sales=S.sales||[];
    var salesTotal=sales.reduce(function(s,x){return s+(x.refunded?0:(x.amountCents||0));},0);
    var salesMo=sales.filter(function(x){return !x.refunded && x.created && (now-new Date(x.created).getTime())<MO;})
                     .reduce(function(s,x){return s+(x.amountCents||0);},0);
    var clientCount=S.clients===undefined?'—':String(S.clients.length);
    var h='<div class="card"><h2>Insights</h2><p class="sub">The numbers behind your salon — from your real bookings and sales.</p></div>'
      + '<div class="tiles">'
      + tile('Upcoming appts',String(upcoming.length),upcoming.length?'Booked ahead':'Nothing booked yet')
      + tile('Needs a reply',String(needReply.length),needReply.length?'Waiting on you':'All caught up')
      + tile('Clients',clientCount,S.clients===undefined?'Loading…':'On your books')
      + tile('Completed',String(done.length),'Marked done')
      + tile('Sales · 30 days',centsFmt(salesMo),'Money in, last 30 days')
      + tile('Sales · all time',centsFmt(salesTotal),sales.length?'Every paid sale':'No sales yet')
      + '</div>';
    return h;
  };

  /* ---------------- inventory (real products in the product table) ---------------- */
  VIEWS.inventory=function(){
    var h='<div class="card"><h2>Add a product</h2><p class="sub">Retail you sell at the counter — shampoo, tools, gift cards. Track the price and how many you have.</p>'
      + '<div class="fld"><label for="np-name">Product name</label><input id="np-name" type="text" placeholder="e.g. Daily Shampoo 8oz"></div>'
      + '<div class="fld"><label for="np-sku">SKU (optional)</label><input id="np-sku" type="text" placeholder="e.g. SHMP-08"></div>'
      + '<div class="fld"><label for="np-price">Price ($)</label><input id="np-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="24"></div>'
      + '<div class="fld"><label for="np-stock">In stock</label><input id="np-stock" type="number" inputmode="numeric" min="0" step="1" placeholder="0"></div>'
      + '<button class="btn" onclick="saveProduct(this)">Add product</button><p class="msg" id="prodMsg"></p></div>';
    h+='<div class="card"><div class="rowbtw"><div><h2>Products</h2><p class="sub">Your retail list.</p></div>'
      + '<button class="btn ghost sm" onclick="go(\'import\')">Import products</button></div>';
    if(S.products===undefined){ h+=empty('◫','Loading…'); }
    else if(!S.products.length){ h+=empty('◫','No products yet — add one above or import your list.'); }
    else{
      var lowN=S.products.filter(function(p){return p.stock===0||(p.lowAt!=null&&p.stock<=p.lowAt);}).length;
      if(lowN) h+='<p class="hint" style="color:var(--accent)"><b>'+lowN+'</b> product'+(lowN===1?'':'s')+' low or out of stock.</p>';
      h+=bulkBar('inventory');
      h+='<div class="lst">'+S.products.map(function(p){
        var low = p.stock===0 ? ' <span class="chip critc">Out</span>'
                : (p.lowAt!=null && p.stock<=p.lowAt ? ' <span class="chip warnc">Low</span>' : '');
        var thumb = p.image
          ? '<img src="'+esc(p.image)+'" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:8px;flex:none;margin-right:10px">'
          : '<div style="width:42px;height:42px;border-radius:8px;flex:none;margin-right:10px;display:grid;place-items:center;background:rgba(127,127,127,.12)">◫</div>';
        return '<div class="li static"><input type="checkbox" class="bchk-inventory" data-id="'+esc(p.id)+'" onclick="bulkSync(\'inventory\')" style="margin-right:10px;flex:none">'
          + thumb
          + '<div class="bd"><div class="t1">'+esc(p.name)+(p.sku?' <span class="chip neut">'+esc(p.sku)+'</span>':'')+low+'</div>'
          + '<div class="t2">'+centsFmt(p.price||0)+' · '+(p.stock||0)+' in stock</div></div>'
          + '<div class="vacts"><button class="btn ghost sm" onclick="editProduct(\''+esc(p.id)+'\')">Edit</button>'
          + '<button class="btn ghost sm" onclick="delProduct(\''+esc(p.id)+'\')">Remove</button></div></div>';
      }).join('')+'</div>';
    }
    return h+'</div>';
  };
  window.saveProduct=function(btn){
    hideMsg('prodMsg'); btn.disabled=true;
    api('products','POST',{slug:slug,name:$('np-name').value.trim(),sku:$('np-sku').value.trim(),
      price:$('np-price').value,stock:$('np-stock').value}).then(function(r){
      btn.disabled=false;
      if(r.status===200&&r.data.ok){ S.products=undefined; toast('Product added','ok'); loadProducts(); }
      else msg('prodMsg', r.data.error||'Could not add that.');
    });
  };
  window.delProduct=function(id){
    if(!confirm('Remove this product? This cannot be undone.')) return;
    api('products','POST',{slug:slug,action:'delete',id:id}).then(function(r){
      if(!r.data.ok) return toast(r.data.error||'Could not remove','err');
      S.products=undefined; toast('Removed','ok'); loadProducts();
    });
  };
  window.editStock=function(id,cur){
    var v=prompt('How many in stock?',String(cur)); if(v===null) return;
    var n=parseInt(v,10); if(!isFinite(n)||n<0) return toast('Enter a number','err');
    api('products','POST',{slug:slug,action:'stock',id:id,stock:n}).then(function(r){
      if(!r.data.ok) return toast(r.data.error||'Could not update','err');
      S.products=undefined; toast('Stock updated','ok'); loadProducts();
    });
  };
  window.editProduct=function(id){
    var p=(S.products||[]).filter(function(x){return x.id===id;})[0]; if(!p) return;
    openModal('<h3>Edit product</h3>'
      + '<div style="display:flex;gap:12px;align-items:center;margin:10px 0">'
      + (p.image?'<img src="'+esc(p.image)+'" alt="" style="width:60px;height:60px;object-fit:cover;border-radius:10px">':'<div style="width:60px;height:60px;border-radius:10px;background:rgba(127,127,127,.12);display:grid;place-items:center;font-size:1.3rem">◫</div>')
      + '<label class="btn ghost sm" style="cursor:pointer">'+(p.image?'Change photo':'Add photo')+'<input type="file" accept="image/*" hidden onchange="uploadProductPhoto(\''+esc(id)+'\',this)"></label></div>'
      + '<div class="fld"><label for="ep-name">Name</label><input id="ep-name" type="text" value="'+esc(p.name)+'"></div>'
      + '<div class="fld"><label for="ep-sku">SKU</label><input id="ep-sku" type="text" value="'+esc(p.sku)+'"></div>'
      + '<div class="fld"><label for="ep-price">Price ($)</label><input id="ep-price" type="number" inputmode="decimal" min="0" step="0.01" value="'+(p.price?(p.price/100):'')+'"></div>'
      + '<div class="fld"><label for="ep-stock">In stock</label><input id="ep-stock" type="number" inputmode="numeric" min="0" step="1" value="'+(p.stock||0)+'"></div>'
      + '<div class="fld"><label for="ep-low">Warn me when stock reaches</label><input id="ep-low" type="number" inputmode="numeric" min="0" step="1" placeholder="e.g. 3" value="'+(p.lowAt==null?'':p.lowAt)+'"></div>'
      + '<div class="mact"><button class="btn" onclick="saveProductEdit(this,\''+esc(id)+'\')">Save changes</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>'
      + '<p class="msg" id="epMsg"></p>');
  };
  window.saveProductEdit=function(btn,id){
    hideMsg('epMsg'); btn.disabled=true;
    api('products','POST',{slug:slug,action:'update',id:id,
      name:$('ep-name').value.trim(), sku:$('ep-sku').value.trim(),
      price:$('ep-price').value, stock:$('ep-stock').value,
      low_stock_at: $('ep-low').value===''?'':$('ep-low').value
    }).then(function(r){
      btn.disabled=false;
      if(r.status===200&&r.data.ok){ closeModal(); S.products=undefined; toast('Saved','ok'); loadProducts(); }
      else msg('epMsg', r.data.error||'Could not save.');
    });
  };
  window.uploadProductPhoto=function(id,input){
    var f=input.files&&input.files[0]; if(!f) return;
    toast('Uploading photo…');
    svResize(f, 800, false, function(dataUrl){
      if(!dataUrl) return toast('Could not read that image','err');
      api('product-photo','POST',{slug:slug,data:dataUrl}).then(function(r){
        if(!(r.status===200&&r.data.ok&&r.data.url)) return toast((r.data&&r.data.error)||'Upload failed','err');
        api('products','POST',{slug:slug,action:'update',id:id,image_url:r.data.url}).then(function(u){
          if(u.status===200&&u.data.ok){ closeModal(); S.products=undefined; toast('Photo added','ok'); loadProducts(); }
          else toast((u.data&&u.data.error)||'Uploaded, but could not attach it','err');
        });
      });
    });
  };
  function loadClients(){
    return api('clients?slug='+encodeURIComponent(slug)).then(function(r){
      S.clients=(r.status===200&&r.data.ok)?(r.data.clients||[]):[];
      if(S.route==='clients'||S.route==='insights') render();
    });
  }
  function loadProducts(){
    return api('products?slug='+encodeURIComponent(slug)).then(function(r){
      S.products=(r.status===200&&r.data.ok)?(r.data.products||[]):[];
      if(S.route==='inventory') render();
    });
  }

  /* ---------------- bulk select + remove (inventory / clients / staff) ---------------- */
  function bulkBar(kind){
    return '<div class="rowbtw" style="margin:4px 0 10px">'
      + '<label class="hint" style="display:flex;gap:7px;align-items:center;margin:0;cursor:pointer">'
      + '<input type="checkbox" id="chkAll-'+kind+'" onclick="bulkAll(\''+kind+'\',this)"> Select all</label>'
      + '<button class="btn danger sm" id="bulkBtn-'+kind+'" onclick="bulkRemove(\''+kind+'\')" disabled>Remove selected</button></div>';
  }
  window.bulkAll=function(kind,master){
    Array.prototype.forEach.call(document.querySelectorAll('.bchk-'+kind),function(b){ b.checked=master.checked; });
    bulkSync(kind);
  };
  window.bulkSync=function(kind){
    var boxes=document.querySelectorAll('.bchk-'+kind), n=0;
    Array.prototype.forEach.call(boxes,function(b){ if(b.checked) n++; });
    var btn=document.getElementById('bulkBtn-'+kind);
    if(btn){ btn.disabled=n===0; btn.textContent=n?('Remove selected ('+n+')'):'Remove selected'; }
    var all=document.getElementById('chkAll-'+kind);
    if(all){ all.checked = boxes.length>0 && n===boxes.length; }
  };
  window.bulkRemove=function(kind){
    var ids=[];
    Array.prototype.forEach.call(document.querySelectorAll('.bchk-'+kind),function(b){ if(b.checked) ids.push(b.getAttribute('data-id')); });
    if(!ids.length) return;
    var noun = kind==='inventory'?'product':kind==='clients'?'client':'team member';
    if(!confirm('Remove '+ids.length+' '+noun+(ids.length===1?'':'s')+'? This cannot be undone.')) return;
    if(kind==='inventory'){
      api('products','POST',{slug:slug,action:'delete',ids:ids}).then(function(r){
        if(!r.data.ok) return toast(r.data.error||'Could not remove','err');
        S.products=undefined; toast('Removed '+(r.data.removed||ids.length),'ok'); loadProducts();
      });
    } else if(kind==='clients'){
      api('clients','POST',{slug:slug,action:'delete',ids:ids}).then(function(r){
        if(!r.data.ok) return toast(r.data.error||'Could not remove','err');
        S.clients=undefined; toast('Removed '+(r.data.removed||ids.length),'ok'); loadClients();
      });
    } else {
      api('stylists','POST',{slug:slug,action:'bulkRemove',emails:ids}).then(function(r){
        if(!r.data.ok) return toast(r.data.error||'Could not remove','err');
        if(r.data.team){ S.team=r.data.team; S.seats=r.data.seats||S.seats; }
        var msg='Removed '+(r.data.removed||0);
        if(r.data.skipped&&r.data.skipped.length) msg+=' · kept owner/you';
        toast(msg,'ok'); render();
      });
    }
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
    /* The "My website" tab now opens the full-screen visual editor (studio.html),
       the Google-Sites-style editor. Same login/session carries over. The old
       form-based editor below is left in place as dead code (never reached) so
       this stays a one-line change on an actively-edited file — safe to delete later. */
    location.href='/studio.html';
    return '<div class="card"><h2>Opening your website editor…</h2><p class="sub">Taking you to your live site so you can edit it. <a href="/studio.html">Click here</a> if it doesn\'t open.</p></div>';
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
     + '<div class="fld"><label for="st-address">Address</label><input id="st-address" type="text" maxlength="200" placeholder="e.g. 12 High Street, Springfield" value="'+esc(c.address||'')+'">'
     + '<span class="hint">Goes on every confirmation and reminder email so clients know where to come.</span></div>'
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

    var x=S.extra||{};
    h+='<div class="card"><h2>About &amp; social</h2><p class="sub">Tell clients who you are, and point them at your other pages.</p>'
     + '<div class="fld"><label for="st-about">About your salon</label>'
     + '<textarea id="st-about" rows="4" maxlength="1200" placeholder="A few lines about your salon — what you are known for, who you look after.">'+esc(x.about||'')+'</textarea></div>'
     + '<div class="fld"><label for="st-fb">Facebook</label><input id="st-fb" type="text" maxlength="80" placeholder="yoursalon" value="'+esc(x.facebook||'')+'"></div>'
     + '<div class="fld"><label for="st-tw">X / Twitter</label><input id="st-tw" type="text" maxlength="80" placeholder="yoursalon" value="'+esc(x.twitter||'')+'"></div>'
     + '<div class="fld"><label for="st-pin">Pinterest</label><input id="st-pin" type="text" maxlength="80" placeholder="yoursalon" value="'+esc(x.pinterest||'')+'"></div>'
     + '<div class="fld"><label for="st-yelp">Yelp</label><input id="st-yelp" type="text" maxlength="80" placeholder="yoursalon-city" value="'+esc(x.yelp||'')+'"></div>'
     + '<div class="fld"><label for="st-ext">Another website of yours</label><input id="st-ext" type="text" maxlength="200" placeholder="https://…" value="'+esc(x.externalWebsite||'')+'"></div>'
     + '<div class="vacts"><button class="btn" onclick="saveAboutSocial(this)">Save about &amp; social</button></div>'
     + '<p class="msg" id="socMsg"></p>'
     + '<p class="hint">Paste a full link or just the handle — either works.</p></div>';

    function tog(id,key,label,note){
      var on = x[key]===undefined ? true : !!x[key];
      return '<div class="fld"><label class="chkrow"><input type="checkbox" id="'+id+'"'+(on?' checked':'')+'> '+esc(label)+'</label>'
           + '<p class="hint" style="margin-top:4px">'+esc(note)+'</p></div>';
    }
    h+='<div class="card"><h2>What shows on your site</h2><p class="sub">Turn sections on or off. Saved changes show on your site straight away.</p>'
     + tog('tg-gallery','showGallery','Show my photo gallery','Your work photos on the booking page.')
     + tog('tg-team','showTeam','Let clients request a stylist','Adds a "who would you like?" picker to your booking form.')
     + tog('tg-svcvis','servicesVisual','Show prices next to services','Turn off if your pricing varies by consultation.')
     + '<div class="vacts"><button class="btn" onclick="saveToggles(this)">Save</button></div>'
     + '<p class="msg" id="togMsg"></p></div>';
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
      instagram:$('st-insta').value.trim().replace(/^@+/,''),
      address:$('st-address').value.trim()
    };
    /* header card fields save with the same button when present */
    var ht=$('st-herotitle'); if(ht){ fields.heroTitle=ht.value.trim(); }
    saveSite(fields, btn, 'siteMsg', 'Saved — your site is updated.');
  };
  window.saveAboutSocial=function(btn){
    hideMsg('socMsg'); btn.disabled=true;
    saveSite({
      about:$('st-about').value.trim(),
      facebook:$('st-fb').value.trim(),
      twitter:$('st-tw').value.trim(),
      pinterest:$('st-pin').value.trim(),
      yelp:$('st-yelp').value.trim(),
      externalWebsite:$('st-ext').value.trim()
    }, btn, 'socMsg', 'Saved.');
  };
  window.saveToggles=function(btn){
    hideMsg('togMsg'); btn.disabled=true;
    saveSite({
      showGallery:$('tg-gallery').checked,
      showTeam:$('tg-team').checked,
      servicesVisual:$('tg-svcvis').checked
    }, btn, 'togMsg', 'Saved.');
  };
  /* Shared save: writes through /api/site-edit, which checks the session,
     allow-lists the fields and adds the registry token server-side. */
  function saveSite(fields, btn, msgId, okText){
    api('site-edit','POST',{slug:slug,fields:fields}).then(function(r){
      if(btn) btn.disabled=false;
      if(r.status===200&&r.data.ok){
        S.cfg=Object.assign({},S.cfg||{},r.data.fields||fields);
        if(r.data.patch) S.extra=Object.assign({},S.extra||{},r.data.patch);
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
     + (b.posPaid?'<dt>Paid</dt><dd>'+centsFmt(b.posPaidCents||0)+(b.posTipCents?' (incl. '+centsFmt(b.posTipCents)+' tip)':'')+'</dd>':'')
     + '</div><div class="mact">'
     + (!b.posPaid?'<button class="btn" onclick="posFromBooking(\''+esc(b.id)+'\')">$ Checkout</button>':'')
     + '<button class="btn'+(b.posPaid?'':' ghost')+'" onclick="setBooking(\''+esc(b.id)+'\',\'confirmed\')">Confirm</button>'
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
  /* Commission <-> independent. Only the owner can move this: it decides
     whose bank account the card money lands in. Switching back to
     commission leaves their Stripe account connected but unused, so it
     costs them nothing to be switched back and forth. */
  window.setPayType=function(email,sel){
    var val=sel.value; sel.disabled=true;
    api('stylists','POST',{slug:slug,action:'setPayType',email:email,payType:val}).then(function(r){
      sel.disabled=false;
      if(r.status===200&&r.data.ok){
        S.team=r.data.team||S.team; S.seats=r.data.seats||S.seats;
        toast(val==='independent'?'Now takes their own payments':'Now paid through the salon','ok');
      } else {
        toast((r.data&&r.data.error)||'Could not change that','err');
      }
      render();
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
  function loadExtra(){
    return api('site-extra?slug='+encodeURIComponent(slug)).then(function(r){
      S.extra = (r.status===200 && r.data.ok) ? (r.data.extra||{}) : {};
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
    loadBookings(); loadCalExtra();
    if(me.role==='admin'){ loadTeam(); loadPayments(); loadBilling(); loadExtra(); }
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
