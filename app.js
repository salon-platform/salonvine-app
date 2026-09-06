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
    calendar:{t:'Calendar',   ic:'▦', grp:'Run the day'},
    checkout:{t:'Checkout',   ic:'$', grp:'Run the day'},
    payments:{t:'Payments',   ic:'⇄', grp:'Money',       admin:true},
    insights:{t:'Insights',   ic:'◔', grp:'Money',       admin:true},
    billing :{t:'My plan',    ic:'⚑', grp:'Money',       admin:true},
    staff   :{t:'Staff',      ic:'⚬', grp:'My business', admin:true},
    clients :{t:'Clients',    ic:'☺', grp:'My business', admin:true},
    import  :{t:'Import data', ic:'⇪', grp:'My business', admin:true},
    inventory:{t:'Inventory', ic:'◫', grp:'My business', admin:true},
    services:{t:'Services',   ic:'✂', grp:'My business'},
    site    :{t:'My website', ic:'⌂', grp:'My business'}
  };
  var BOT=['today','bookings','checkout','more'];

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
  function go(r){ if(!SCREENS[r]||!visible(r)) return; S.route=r; closeModal(); window.scrollTo(0,0);
    if(r==='payments'&&S.sales===undefined) loadSales();
    if(r==='clients'&&S.clients===undefined) loadClients();
    if(r==='inventory'&&S.products===undefined) loadProducts();
    if(r==='insights'){ if(S.sales===undefined) loadSales(); if(S.clients===undefined) loadClients(); }
    render(); }
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
     + (b.posPaid?'<span class="chip live">paid</span>':'')
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
      return '<div class="card"><h2>Checkout</h2>'
       + '<p class="sub">Ring up a sale right here — type the card in, or let the customer pay on their own phone.</p>'
       + '<p class="hint">'+(isAdmin
          ? 'Connect your Stripe account first — it takes a few minutes and then this screen becomes your register.'
          : 'Checkout is not set up yet. Ask the owner to finish Stripe setup on the Payments screen.')+'</p>'
       + (isAdmin?'<button class="btn" onclick="go(\'payments\')">Set up payments</button>':'')
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
     + (p.bookingId?'<button class="btn ghost wide" onclick="posReset();go(\'bookings\')">Back to bookings</button>':'')
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

  /* ---------------- calendar (real agenda over bookings) ---------------- */
  VIEWS.calendar=function(){
    var all=S.bookings||[];
    var dated=all.filter(function(b){return b&&b.startsAt;}).slice()
      .sort(function(a,b){return new Date(a.startsAt)-new Date(b.startsAt);});
    var undated=all.filter(function(b){return b&&!b.startsAt;});
    var h='<div class="card"><div class="rowbtw"><div><h2>Calendar</h2>'
      + '<p class="sub">Your appointments, soonest first. Requests without a set time are at the bottom.</p></div>'
      + '<button class="btn ghost sm" onclick="go(\'bookings\')">Requests</button></div>';
    if(!dated.length && !undated.length){ return h+empty('▦','No appointments yet — they appear here the moment a client books a time.')+'</div>'; }
    var lastDay='';
    dated.forEach(function(b){
      var d=new Date(b.startsAt);
      var day=d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
      if(day!==lastDay){ h+='<p class="hint" style="margin:14px 0 4px"><b>'+esc(day)+'</b></p>'; lastDay=day; }
      var t=d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
      var st=String(b.status||'new').toLowerCase();
      var chip = st==='confirmed'?'<span class="chip live">Confirmed</span>'
               : st==='done'?'<span class="chip neut">Done</span>'
               : st==='canceled'?'<span class="chip mock">Canceled</span>'
               : '<span class="chip warnc">Request</span>';
      h+='<div class="li static"><div class="bd"><div class="t1">'+esc(t)+' · '+esc(b.name||'Client')+' '+chip+'</div>'
        + '<div class="t2">'+esc(b.service||'Appointment')+(b.stylist?' · '+esc(b.stylist):'')+'</div></div></div>';
    });
    if(undated.length){
      h+='<p class="hint" style="margin:14px 0 4px"><b>Requests without a set time</b></p>';
      undated.forEach(function(b){
        h+='<div class="li static"><div class="bd"><div class="t1">'+esc(b.name||'Client')+'</div>'
          + '<div class="t2">'+esc(b.service||'Appointment')+(b.when?' · '+esc(b.when):'')+'</div></div></div>';
      });
    }
    return h+'</div>';
  };

  /* ---------------- clients (real list from the client table) ---------------- */
  function clientRow(c){
    var hay=((c.name||'')+' '+(c.email||'')+' '+(c.phone||'')).toLowerCase();
    return '<div class="li static" data-hay="'+esc(hay)+'"><div class="av">'+esc(initials(c.name||c.email||'?'))+'</div>'
      + '<div class="bd"><div class="t1">'+esc(c.name||'Client')+'</div>'
      + '<div class="t2">'+esc(c.email||'')+(c.phone?(c.email?' · ':'')+esc(c.phone):'')+'</div></div></div>';
  }
  VIEWS.clients=function(){
    var h='<div class="card"><div class="rowbtw"><div><h2>Clients</h2>'
      + '<p class="sub">Everyone who has booked with you or that you imported. Search by name, email or phone.</p></div>'
      + '<button class="btn ghost sm" onclick="go(\'import\')">Import clients</button></div>';
    if(S.clients===undefined){ return h+empty('☺','Loading your clients…')+'</div>'; }
    if(!S.clients.length){ return h+empty('☺','No clients yet — import your list, or they build up as people book.')+'</div>'; }
    h+='<div class="fld"><input id="cliSearch" type="search" placeholder="Search '+S.clients.length+' clients…" oninput="filterClients(this.value)"></div>'
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
      h+='<div class="lst">'+S.products.map(function(p){
        return '<div class="li static"><div class="bd"><div class="t1">'+esc(p.name)
          + (p.sku?' <span class="chip neut">'+esc(p.sku)+'</span>':'')+'</div>'
          + '<div class="t2">'+centsFmt(p.price||0)+' · '+(p.stock||0)+' in stock</div></div>'
          + '<div class="vacts"><button class="btn ghost sm" onclick="editStock(\''+esc(p.id)+'\','+(p.stock||0)+')">Stock</button>'
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
    loadBookings();
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
