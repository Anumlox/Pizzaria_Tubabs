/* Painel do caixa / cozinha / administração */
(function () {
  'use strict';
  const U = window.PizzaUtil;
  const { money, esc, waLink, fmtPhone, parseMoney, norm, code2, SIZE_NAME, borderLabel, priceFor } = U;
  const api = window.pizzaApi;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const pref = (k, d) => { try { const v = localStorage.getItem('painel_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem('painel_' + k, JSON.stringify(v)); } catch (e) { /* ok */ } };

  const P = { role: null, settings: null, products: [], borders: [], zones: [], zq: '', orders: new Map(), seen: new Set(), ready: false, audio: null, wake: null, autoPrint: pref('autoPrint', true), pq: '' };
  const NEXT = { novo: 'preparo', preparo: 'entrega', entrega: 'concluido' };
  const ACTIVE = ['novo', 'preparo', 'entrega'];
  const isAdmin = () => P.role === 'admin';

  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = 'toast'; }, 3000);
  }
  function show(id) { ['vLogin', 'vDenied', 'vApp'].forEach((v) => { $('#' + v).hidden = v !== id; }); }
  function shiftStart() { const now = new Date(), s = new Date(now); s.setHours(6, 0, 0, 0); if (now < s) s.setDate(s.getDate() - 1); return s; }
  const minutesSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  const moneyIn = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2).replace('.', ','));
  const optMoney = (v) => { const s = String(v || '').trim(); if (!s) return null; const n = parseMoney(s); return n >= 0 ? n : NaN; };

  // descrição para a cozinha: tamanho + sabores com número
  const fl = (name, code) => (code != null ? `${code2(code)} ${name}` : name);
  function kitchenLabel(i) {
    const flav = i.half ? `½ ${fl(i.name, i.code)} + ½ ${fl(i.half, i.half_code)}` : fl(i.name, i.code);
    return i.size ? `${SIZE_NAME[i.size]} · ${flav}` : i.name;
  }

  /* ---------- entrada ---------- */
  async function init() {
    if (!api) { document.body.innerHTML = `<p style="padding:24px">${esc((window.pizzaApiError && window.pizzaApiError.message) || 'Erro ao iniciar.')}</p>`; return; }
    if (api.demo) { $('#demoBar').hidden = false; $('#lDemo').hidden = false; }
    const s = await api.getSession();
    if (!s) return show('vLogin');
    await gate(s);
  }
  async function gate(s) {
    try { P.role = await api.myRole(); } catch (e) { toast(e.message, 'err'); }
    if (!P.role) {
      $('#dEmail').textContent = s.user.email;
      $('#dSql').textContent = `insert into public.staff (user_id, role)\nselect id, 'admin' from auth.users where email = '${s.user.email}';`;
      return show('vDenied');
    }
    start();
  }
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#lErr');
    err.hidden = true;
    try { await gate(await api.signIn({ email: $('#lEmail').value.trim(), password: $('#lPass').value })); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#dRetry').onclick = async () => { const s = await api.getSession(); if (s) gate(s); else show('vLogin'); };
  $('#dOut').onclick = $('#btnOut').onclick = async () => { await api.signOut(); location.reload(); };

  async function start() {
    show('vApp');
    $('#roleTag').textContent = isAdmin() ? 'Admin' : 'Atendente';
    $('#roleTag').className = 'role ' + (isAdmin() ? 'admin' : '');
    $$('[data-admin]').forEach((el) => { el.hidden = !isAdmin(); });
    try {
      [P.settings, P.products, P.borders, P.zones] = await Promise.all([api.getSettings(), api.getProducts(), api.getBorders(), api.getZones()]);
    } catch (e) { toast(e.message, 'err'); return; }
    paintSettings();
    renderProducts();
    renderBorders();
    renderZones();
    $('#swPrint').checked = P.autoPrint;
    $('#startOv').hidden = false;
    await refresh();
    api.onOrders(() => refresh());
    setInterval(() => refresh(), 20000);
    setInterval(() => renderOrders(), 30000);
  }

  function paintSettings() {
    const s = P.settings;
    $('#pName').textContent = s.store_name;
    $('#swOpen').checked = !!s.is_open;
    const f = $('#cfgForm');
    ['store_name', 'whatsapp', 'store_address', 'pix_key', 'pix_name', 'pix_city'].forEach((k) => { f.elements[k].value = s[k] || ''; });
    f.elements.broto_percent.value = String(s.broto_percent == null ? 50 : Number(s.broto_percent)).replace('.', ',');
    f.elements.broto_half_extra.value = moneyIn(s.broto_half_extra == null ? 5 : s.broto_half_extra);
    const r = $('#ruleForm').elements;
    r.delivery_fee.value = moneyIn(s.delivery_fee || 0);
    r.delivery_km_included.value = s.delivery_km_included == null ? '' : String(Number(s.delivery_km_included)).replace('.', ',');
    r.delivery_per_km.value = moneyIn(s.delivery_per_km == null ? 1.5 : s.delivery_per_km);
    r.delivery_condo_fee.value = moneyIn(s.delivery_condo_fee == null ? 12 : s.delivery_condo_fee);
    $('#shopLink').value = new URL('./', location.href).href;
  }

  /* ---------- pedidos ---------- */
  async function refresh() {
    let list;
    try { list = await api.listOrders(shiftStart().toISOString()); $('#live').classList.remove('off'); }
    catch (e) { $('#live').classList.add('off'); return; }
    const fresh = [];
    const ids = new Set(list.map((o) => o.id));
    for (const id of [...P.orders.keys()]) if (!ids.has(id)) P.orders.delete(id);
    for (const o of list) {
      if (!P.seen.has(o.id)) { P.seen.add(o.id); if (P.ready && o.status === 'novo') fresh.push(o); }
      P.orders.set(o.id, o);
    }
    P.ready = true;
    renderOrders(fresh.map((o) => o.id));
    if (fresh.length) {
      beep();
      toast(fresh.length === 1 ? `Novo pedido #${fresh[0].id}!` : `${fresh.length} novos pedidos!`);
      if (P.autoPrint) fresh.forEach(enqueuePrint);
    }
  }

  function payBadge(o) {
    if (o.payment_method === 'pix') return o.payment_status === 'pago' ? '<span class="pb ok">Pix pago</span>' : '<span class="pb pend">Pix a confirmar</span>';
    if (o.payment_method === 'cartao') return `<span class="pb">Cartão ${o.fulfillment === 'entrega' ? '· levar maquininha' : 'no balcão'}</span>`;
    return `<span class="pb">Dinheiro${o.change_for ? ' · troco p/ ' + money(o.change_for) : ''}</span>`;
  }
  function nextLabel(o) {
    if (o.status === 'novo') return 'Iniciar preparo';
    if (o.status === 'preparo') return o.fulfillment === 'entrega' ? 'Saiu p/ entrega' : 'Pronto p/ retirada';
    if (o.status === 'entrega') return o.fulfillment === 'entrega' ? 'Entregue' : 'Retirado';
    return '';
  }
  function waMsg(o) {
    const first = String(o.customer_name).split(' ')[0];
    const store = P.settings.store_name;
    if (o.status === 'novo') return `Olá, ${first}! Recebemos seu pedido #${o.id} na ${store}. Total: ${money(o.total)}.`;
    if (o.status === 'preparo') return `Olá, ${first}! Seu pedido #${o.id} já está no forno 🍕`;
    if (o.status === 'entrega') return o.fulfillment === 'entrega'
      ? `Olá, ${first}! Seu pedido #${o.id} saiu para entrega 🛵`
      : `Olá, ${first}! Seu pedido #${o.id} está pronto para retirada no balcão.`;
    if (o.status === 'cancelado') return `Olá, ${first}. Sobre o seu pedido #${o.id}: `;
    return `Olá, ${first}! Obrigado pela preferência. Bom apetite!`;
  }

  function cardHTML(o, isFresh) {
    const age = minutesSince(o.created_at);
    const ageCls = age >= 45 ? 'late' : age >= 25 ? 'warn' : '';
    const pixPend = o.payment_method === 'pix' && o.payment_status === 'pendente';
    return `<article class="card ${o.status === 'novo' ? 'is-new' : ''} ${isFresh ? 'flash' : ''}" data-id="${o.id}">
      <header><b>#${o.id}</b><span class="tag ${o.fulfillment}">${o.fulfillment === 'entrega' ? 'Entrega' : 'Retirada'}</span><span class="age ${ageCls}">${age} min</span></header>
      <div class="cust"><b>${esc(o.customer_name)}</b><span class="muted">${esc(fmtPhone(o.customer_phone))}</span>${o.fulfillment === 'entrega' ? `<span class="addr">${esc(o.address)}</span>` : ''}</div>
      <ul class="items">${o.items.map((i) => `<li><b>${i.qty}×</b> ${esc(kitchenLabel(i))}${borderLabel(i) ? `<em>+ Borda ${esc(borderLabel(i))}</em>` : ''}${i.obs ? `<em>↳ ${esc(i.obs)}</em>` : ''}</li>`).join('')}</ul>
      ${o.notes ? `<p class="notes">Obs.: ${esc(o.notes)}</p>` : ''}
      <div class="pay">${payBadge(o)}<b>${money(o.total)}</b></div>
      <div class="acts">
        ${pixPend ? '<button class="btn ok sm" data-act="pix">Confirmar Pix</button>' : ''}
        <button class="btn primary sm" data-act="next">${nextLabel(o)}</button>
        <button class="btn ghost sm" data-act="print">Imprimir</button>
        <a class="btn ghost sm" target="_blank" rel="noopener" href="${waLink(o.customer_phone, waMsg(o))}">WhatsApp</a>
        <button class="btn danger sm" data-act="cancel">Cancelar</button>
      </div></article>`;
  }

  function renderOrders(freshIds) {
    const fresh = new Set(freshIds || []);
    const all = [...P.orders.values()].sort((a, b) => a.id - b.id);
    for (const st of ACTIVE) {
      const list = all.filter((o) => o.status === st);
      const col = $(`.col[data-col=${st}]`);
      $('.n', col).textContent = list.length;
      $('.cards', col).innerHTML = list.length ? list.map((o) => cardHTML(o, fresh.has(o.id))).join('') : '<p class="empty-col">Nenhum pedido aqui</p>';
    }
    const done = all.filter((o) => !ACTIVE.includes(o.status)).reverse();
    $('#doneN').textContent = done.length;
    $('#doneList').innerHTML = done.map((o) => `<div class="drow" data-id="${o.id}"><b>#${o.id}</b><span>${esc(o.customer_name)}</span><span class="muted">${money(o.total)}</span><span class="st ${o.status}">${o.status === 'concluido' ? 'Concluído' : 'Cancelado'}</span>
      <div class="acts"><button class="btn ghost sm" data-act="print">Imprimir</button>${o.status === 'cancelado' ? '' : '<button class="btn ghost sm" data-act="reopen">Reabrir</button>'}${isAdmin() ? '<button class="btn danger sm" data-act="delete">Excluir</button>' : ''}</div></div>`).join('') || '<p class="muted small">Nada por aqui ainda.</p>';

    const valid = all.filter((o) => o.status !== 'cancelado');
    const revenue = valid.reduce((a, o) => a + Number(o.total), 0);
    const pixPend = all.filter((o) => ACTIVE.includes(o.status) && o.payment_method === 'pix' && o.payment_status === 'pendente').length;
    const open = all.filter((o) => ACTIVE.includes(o.status)).length;
    $('#stats').innerHTML = `
      <div class="stat"><span>Pedidos no turno</span><b>${valid.length}</b></div>
      <div class="stat"><span>Faturamento</span><b>${money(revenue)}</b></div>
      <div class="stat"><span>Em aberto</span><b>${open}</b></div>
      <div class="stat ${pixPend ? 'alert' : ''}"><span>Pix a confirmar</span><b>${pixPend}</b></div>`;
    const novos = all.filter((o) => o.status === 'novo').length;
    document.title = (novos ? `(${novos}) ` : '') + 'Painel · ' + P.settings.store_name;
  }

  $('#tPedidos').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const o = P.orders.get(Number(b.closest('[data-id]').dataset.id));
    if (!o) return;
    const act = b.dataset.act;
    if (act === 'print') return enqueuePrint(o);
    b.disabled = true;
    try {
      if (act === 'delete') {
        if (!confirm(`Excluir DEFINITIVAMENTE o pedido #${o.id}? Ele some dos relatórios.`)) { b.disabled = false; return; }
        await api.deleteOrder(o.id);
        P.orders.delete(o.id);
        renderOrders();
        toast(`Pedido #${o.id} excluído`);
        return;
      }
      let patch = null;
      if (act === 'next') patch = { status: NEXT[o.status] };
      if (act === 'pix') patch = { payment_status: 'pago' };
      if (act === 'reopen') patch = { status: 'entrega' };
      if (act === 'cancel') {
        if (!confirm(`Cancelar o pedido #${o.id} de ${o.customer_name}?`)) { b.disabled = false; return; }
        patch = { status: 'cancelado' };
      }
      if (!patch) return;
      const n = await api.updateOrder(o.id, patch);
      P.orders.set(n.id, n);
      renderOrders();
      if (act === 'pix') toast(`Pix do pedido #${o.id} confirmado`);
    } catch (ex) { toast(ex.message, 'err'); b.disabled = false; }
  });

  /* ---------- impressão térmica ---------- */
  function payText(o) {
    if (o.payment_method === 'pix') return o.payment_status === 'pago' ? 'PIX - PAGO' : 'PIX - AGUARDANDO CONFIRMACAO';
    if (o.payment_method === 'cartao') return o.fulfillment === 'entrega' ? 'CARTAO - LEVAR MAQUININHA' : 'CARTAO NO BALCAO';
    let t = 'DINHEIRO';
    if (o.change_for) t += ` - TROCO P/ ${money(o.change_for)} (levar ${money(o.change_for - o.total)})`;
    return t;
  }
  function ticketItem(i) {
    const head = i.size ? `${i.qty}x ${SIZE_NAME[i.size].toUpperCase()}` : `${i.qty}x ${esc(i.name)}`;
    let h = `<div class="t-row t-b"><span>${head}</span><span>${money(i.unit * i.qty)}</span></div>`;
    const bd = (b) => (b ? `<div class="t-obs">&nbsp;&nbsp;+ BORDA ${esc(b).toUpperCase()}</div>` : '');
    if (i.size && i.half) {
      h += `<div class="t-obs">1/2 ${esc(fl(i.name, i.code))}</div>${bd(i.border)}<div class="t-obs">1/2 ${esc(fl(i.half, i.half_code))}</div>${bd(i.border2)}`;
    } else if (i.size) {
      h += `<div class="t-obs">${esc(fl(i.name, i.code))}</div>${bd(i.border)}`;
    }
    if (i.obs) h += `<div class="t-obs">&gt; ${esc(i.obs)}</div>`;
    return h;
  }
  function ticketHTML(o) {
    const dt = new Date(o.created_at);
    return `
      <div class="t-c t-b t-big">${esc(P.settings.store_name)}</div>
      <div class="t-c t-b t-big">PEDIDO #${o.id}</div>
      <div class="t-c">${dt.toLocaleDateString('pt-BR')} ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
      <div class="t-c t-b t-inv">${o.fulfillment === 'entrega' ? 'ENTREGA' : 'RETIRADA NO BALCAO'}</div>
      <div><b>Cliente:</b> ${esc(o.customer_name)}</div>
      <div><b>Tel:</b> ${esc(fmtPhone(o.customer_phone))}</div>
      ${o.fulfillment === 'entrega' ? `<div><b>End.:</b> ${esc(o.address)}</div>` : ''}
      <div class="t-hr"></div>
      ${o.items.map(ticketItem).join('<div style="height:1.5mm"></div>')}
      <div class="t-hr"></div>
      <div class="t-row"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
      ${Number(o.delivery_fee) > 0 ? `<div class="t-row"><span>Entrega</span><span>${money(o.delivery_fee)}</span></div>` : ''}
      <div class="t-row t-b t-big"><span>TOTAL</span><span>${money(o.total)}</span></div>
      <div class="t-hr"></div>
      <div class="t-b">PAGAMENTO: ${payText(o)}</div>
      ${o.notes ? `<div class="t-hr"></div><div><b>Obs.:</b> ${esc(o.notes)}</div>` : ''}
      <div class="t-hr"></div>
      <div class="t-c">Documento sem valor fiscal</div>`;
  }
  const printQueue = [];
  let printing = false;
  function enqueuePrint(o) { printQueue.push(o); if (!printing) nextPrint(); }
  function nextPrint() {
    const o = printQueue.shift();
    if (!o) { printing = false; return; }
    printing = true;
    $('#ticket').innerHTML = ticketHTML(o);
    setTimeout(() => { window.print(); setTimeout(nextPrint, 700); }, 120);
  }

  /* ---------- alerta sonoro e tela ligada ---------- */
  function beep() {
    const ctx = P.audio;
    if (!ctx) return;
    const t = ctx.currentTime;
    [0, 0.2, 0.4].forEach((d, i) => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 2 ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.5, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.17);
      osc.connect(g).connect(ctx.destination);
      osc.start(t + d);
      osc.stop(t + d + 0.2);
    });
  }
  async function keepAwake() { try { if ('wakeLock' in navigator) P.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* ok */ } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && P.wake !== null) keepAwake(); });
  $('#startBtn').onclick = () => {
    try { P.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* sem som */ }
    keepAwake();
    beep();
    $('#startOv').hidden = true;
  };

  /* ---------- barra ---------- */
  $$('.tabs button').forEach((b) => b.onclick = () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    ['pedidos', 'cardapio', 'entrega', 'loja', 'equipe'].forEach((t) => { $('#t' + t[0].toUpperCase() + t.slice(1)).hidden = b.dataset.tab !== t; });
    if (b.dataset.tab === 'equipe') renderStaff();
  });
  $('#swPrint').onchange = (e) => {
    P.autoPrint = e.target.checked;
    setPref('autoPrint', P.autoPrint);
    toast(P.autoPrint ? 'Novos pedidos serão impressos automaticamente' : 'Impressão automática desligada');
  };
  $('#swOpen').onchange = async (e) => {
    const v = e.target.checked;
    try { P.settings = await api.setStoreOpen(v); toast(v ? 'Loja aberta: o site está aceitando pedidos' : 'Loja fechada: o site não aceita pedidos'); }
    catch (ex) { e.target.checked = !v; toast(ex.message, 'err'); }
  };

  /* ---------- cardápio ---------- */
  function renderProducts() {
    const cats = [...new Set(P.products.map((p) => p.category))];
    $('#catList').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
    $('#cardHint').textContent = isAdmin()
      ? `${P.products.length} itens. Edite e clique em Salvar. Desligar "Disponível" esconde o item do site na hora.`
      : `${P.products.length} itens. Desligue "Disponível" quando algum sabor acabar: ele some do site na hora.`;
    const q = norm(P.pq.trim());
    const list = P.products.filter((p) => !q || norm(p.name).includes(q) || (/^\d+$/.test(q) && Number(q) === p.code));
    const dis = isAdmin() ? '' : 'disabled';
    $('#prodList').innerHTML = list.map((p) => `
      <tr data-pid="${p.id}" class="${p.available ? '' : 'off'}">
        <td><input class="ti code" data-f="code" value="${p.code == null ? '' : p.code}" ${dis}></td>
        <td><input class="ti" data-f="name" value="${esc(p.name)}" ${dis}><input class="ti sub" data-f="description" value="${esc(p.description)}" placeholder="descrição" ${dis}><input class="ti sub" data-f="image_url" value="${esc(p.image_url || '')}" placeholder="link da foto (opcional)" ${dis}></td>
        <td><input class="ti" data-f="category" list="catList" value="${esc(p.category)}" style="width:130px" ${dis}></td>
        <td class="muted">${p.is_pizza ? money(priceFor(p, 'broto', P.settings)) : ''}</td>
        <td>${p.is_pizza ? `<input class="ti num" data-f="price_media" value="${moneyIn(p.price_media)}" ${dis}>` : ''}</td>
        <td><input class="ti num" data-f="price" value="${moneyIn(p.price)}" ${dis}></td>
        <td>${p.is_pizza ? `<label class="sw" title="Aceita meio a meio"><input type="checkbox" data-f="allow_half" ${p.allow_half ? 'checked' : ''} ${dis}><span></span></label>` : ''}</td>
        <td class="keep"><label class="sw"><input type="checkbox" data-f="available" ${p.available ? 'checked' : ''}><span></span></label></td>
        <td class="td-acts keep">${isAdmin() ? '<button class="btn sm" data-save>Salvar</button> <button class="btn danger sm" data-del>Excluir</button>' : ''}</td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">Nenhum item encontrado.</td></tr>';
  }
  $('#pSearch').addEventListener('input', (e) => { P.pq = e.target.value; renderProducts(); });

  async function saveRow(tr) {
    const p = P.products.find((x) => x.id === Number(tr.dataset.pid));
    const v = (f) => $(`[data-f=${f}]`, tr);
    const price = parseMoney(v('price').value);
    const pm = p.is_pizza ? optMoney(v('price_media').value) : null;
    if (!(price >= 0) || Number.isNaN(pm)) { toast('Preço inválido', 'err'); return; }
    if (!v('name').value.trim() || !v('category').value.trim()) { toast('Preencha nome e categoria', 'err'); return; }
    const code = v('code').value.trim();
    try {
      const saved = await api.saveProduct(Object.assign({}, p, {
        code: code ? Number(code) : null, name: v('name').value.trim(), description: v('description').value.trim(),
        category: v('category').value.trim(), price, price_media: pm, image_url: v('image_url').value.trim(),
        allow_half: p.is_pizza ? v('allow_half').checked : false, available: v('available').checked,
      }));
      Object.assign(p, saved);
      tr.classList.toggle('off', !p.available);
      toast(`"${p.name}" salvo`);
    } catch (ex) { toast(ex.message, 'err'); }
  }
  $('#prodList').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-pid]');
    if (!tr) return;
    if (e.target.closest('[data-save]')) return saveRow(tr);
    if (e.target.closest('[data-del]')) {
      const p = P.products.find((x) => x.id === Number(tr.dataset.pid));
      if (!confirm(`Excluir "${p.name}" do cardápio? (Pedidos antigos não são afetados.)`)) return;
      try { await api.deleteProduct(p.id); P.products = P.products.filter((x) => x.id !== p.id); renderProducts(); toast(`"${p.name}" excluído`); }
      catch (ex) { toast(ex.message, 'err'); }
    }
  });
  $('#prodList').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-f=available]')) return;
    const tr = e.target.closest('tr');
    const p = P.products.find((x) => x.id === Number(tr.dataset.pid));
    const v = e.target.checked;
    try {
      await api.setAvailable('product', p.id, v);
      p.available = v;
      tr.classList.toggle('off', !v);
      toast(v ? `"${p.name}" disponível` : `"${p.name}" marcado como esgotado`);
    } catch (ex) { e.target.checked = !v; toast(ex.message, 'err'); }
  });
  $('#newProd').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const isPizza = f.is_pizza.checked;
    const price = parseMoney(f.price.value);
    const pm = isPizza ? optMoney(f.price_media.value) : null;
    if (!f.name.value.trim() || !f.category.value.trim() || !(price >= 0) || Number.isNaN(pm)) { toast('Preencha nome, categoria e preço', 'err'); return; }
    try {
      const maxSort = P.products.reduce((m, p) => Math.max(m, p.sort || 0), 0);
      const saved = await api.saveProduct({
        code: f.code.value.trim() ? Number(f.code.value) : null, name: f.name.value.trim(), category: f.category.value.trim(),
        description: f.description.value.trim(), is_pizza: isPizza, price, price_media: pm, image_url: f.image_url.value.trim(),
        allow_half: isPizza && f.allow_half.checked, available: true, sort: maxSort + 10,
      });
      P.products.push(saved);
      renderProducts();
      e.target.reset();
      toast(`"${saved.name}" adicionado`);
    } catch (ex) { toast(ex.message, 'err'); }
  };

  /* ---------- bordas ---------- */
  function renderBorders() {
    const dis = isAdmin() ? '' : 'disabled';
    $('#borderList').innerHTML = P.borders.map((b) => `
      <div class="srow" data-bid="${b.id}">
        <input class="ti" data-f="name" value="${esc(b.name)}" style="flex:1;min-width:160px" ${dis}>
        <span class="muted small">R$</span><input class="ti num" data-f="price" value="${moneyIn(b.price)}" ${dis}>
        <select data-f="kind" ${dis}><option value="comum" ${b.kind !== 'vulcao' ? 'selected' : ''}>Comum</option><option value="vulcao" ${b.kind === 'vulcao' ? 'selected' : ''}>Vulcão (só grande)</option></select>
        <label class="sw"><input type="checkbox" data-f="available" ${b.available ? 'checked' : ''}><span></span>Disponível</label>
        ${isAdmin() ? '<button class="btn sm" data-save>Salvar</button><button class="btn danger sm" data-del>Excluir</button>' : ''}
      </div>`).join('') || '<p class="muted small">Nenhuma borda cadastrada.</p>';
  }
  $('#borderList').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-bid]');
    if (!row) return;
    const b = P.borders.find((x) => x.id === Number(row.dataset.bid));
    if (e.target.closest('[data-save]')) {
      const price = parseMoney($('[data-f=price]', row).value);
      if (!(price >= 0)) { toast('Preço inválido', 'err'); return; }
      try {
        Object.assign(b, await api.saveBorder(Object.assign({}, b, { name: $('[data-f=name]', row).value.trim(), price, kind: $('[data-f=kind]', row).value, available: $('[data-f=available]', row).checked })));
        toast(`Borda "${b.name}" salva`);
      } catch (ex) { toast(ex.message, 'err'); }
    }
    if (e.target.closest('[data-del]')) {
      if (!confirm(`Excluir a borda "${b.name}"?`)) return;
      try { await api.deleteBorder(b.id); P.borders = P.borders.filter((x) => x.id !== b.id); renderBorders(); toast('Borda excluída'); }
      catch (ex) { toast(ex.message, 'err'); }
    }
  });
  $('#borderList').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-f=available]')) return;
    const b = P.borders.find((x) => x.id === Number(e.target.closest('[data-bid]').dataset.bid));
    const v = e.target.checked;
    if (v && !(Number(b.price) > 0) && !confirm(`A borda "${b.name}" está com preço R$ 0,00. Ligar mesmo assim?`)) { e.target.checked = false; return; }
    try { await api.setAvailable('border', b.id, v); b.available = v; toast(v ? `Borda "${b.name}" ligada` : `Borda "${b.name}" desligada`); }
    catch (ex) { e.target.checked = !v; toast(ex.message, 'err'); }
  });
  $('#newBorder').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const price = parseMoney(f.price.value);
    if (!f.name.value.trim() || !(price >= 0)) { toast('Preencha nome e preço da borda', 'err'); return; }
    try {
      const saved = await api.saveBorder({ name: f.name.value.trim(), price, kind: f.kind.value, available: true, sort: P.borders.reduce((m, b) => Math.max(m, b.sort || 0), 0) + 10 });
      P.borders.push(saved);
      renderBorders();
      e.target.reset();
      toast(`Borda "${saved.name}" adicionada`);
    } catch (ex) { toast(ex.message, 'err'); }
  };

  /* ---------- loja ---------- */
  $('#cfgForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const pct = parseMoney(f.broto_percent.value), extra = parseMoney(f.broto_half_extra.value || '0');
    if (!(pct > 0 && pct <= 100) || !(extra >= 0)) { toast('Regra da broto inválida', 'err'); return; }
    if (!f.store_name.value.trim()) { toast('Informe o nome da pizzaria', 'err'); return; }
    try {
      P.settings = await api.saveSettings({
        broto_percent: pct, broto_half_extra: extra,
        store_name: f.store_name.value.trim(), whatsapp: f.whatsapp.value.replace(/\D/g, ''), store_address: f.store_address.value.trim(),
        pix_key: f.pix_key.value.trim(), pix_name: f.pix_name.value.trim(), pix_city: f.pix_city.value.trim(),
      });
      paintSettings();
      renderProducts();
      toast('Dados da loja salvos');
    } catch (ex) { toast(ex.message, 'err'); }
  };
  $('#copyLink').onclick = async () => {
    const i = $('#shopLink');
    try { await navigator.clipboard.writeText(i.value); } catch (e) { i.select(); document.execCommand('copy'); }
    toast('Link copiado');
  };

  /* ---------- entrega: regra e regiões ---------- */
  function feeFromKm(km) {
    const s = P.settings;
    if (s.delivery_km_included == null || !(km >= 0)) return null;
    const extraKm = Math.max(0, km - Number(s.delivery_km_included));
    return U.round2(Number(s.delivery_fee || 0) + Math.ceil(extraKm) * Number(s.delivery_per_km || 0));
  }
  $('#ruleForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const base = parseMoney(f.delivery_fee.value), per = parseMoney(f.delivery_per_km.value), condo = parseMoney(f.delivery_condo_fee.value);
    const kmS = f.delivery_km_included.value.trim(), km = kmS ? parseMoney(kmS) : null;
    if (!(base >= 0) || !(per >= 0) || !(condo >= 0) || (km != null && !(km >= 0))) { toast('Confira os valores da regra', 'err'); return; }
    try {
      P.settings = await api.saveSettings({ delivery_fee: base, delivery_km_included: km, delivery_per_km: per, delivery_condo_fee: condo });
      paintSettings();
      updateFeeCalc();
      toast('Regra de entrega salva');
    } catch (ex) { toast(ex.message, 'err'); }
  };
  function updateFeeCalc() {
    const f = $('#newZone').elements;
    const s = P.settings;
    if (f.is_condo.checked) { f.fee.value = moneyIn(s.delivery_condo_fee); $('#feeCalc').textContent = 'Taxa de condomínio.'; return; }
    const kmS = f.km.value.trim();
    if (!kmS) { $('#feeCalc').textContent = 'Informe a distância para calcular, ou digite a taxa.'; return; }
    const v = feeFromKm(parseMoney(kmS));
    if (v == null) { $('#feeCalc').textContent = 'Defina "Até quantos km vale a base" na regra acima para calcular.'; return; }
    f.fee.value = moneyIn(v);
    $('#feeCalc').textContent = `Calculado: ${money(s.delivery_fee)} até ${String(Number(s.delivery_km_included)).replace('.', ',')} km + ${money(s.delivery_per_km)} por km a mais.`;
  }
  ['km', 'is_condo'].forEach((n) => $('#newZone').elements[n].addEventListener('input', updateFeeCalc));
  $('#newZone').elements.is_condo.addEventListener('change', updateFeeCalc);

  const zoneFilter = () => { const q = norm(P.zq.trim()); return P.zones.filter((z) => !q || norm(z.name).includes(q) || norm(z.city).includes(q)); };
  function renderZones() {
    $('#cityList').innerHTML = [...new Set(P.zones.map((z) => z.city))].map((c) => `<option value="${esc(c)}">`).join('');
    const on = P.zones.filter((z) => z.available).length;
    $('#zoneHint').textContent = `${P.zones.length} regiões cadastradas, ${on} atendidas. Só as marcadas em "Atende" aparecem para o cliente.`;
    const list = zoneFilter();
    $('#zoneList').innerHTML = list.map((z) => `
      <tr data-zid="${z.id}" class="${z.available ? '' : 'off'}">
        <td><input class="ti" data-f="city" value="${esc(z.city)}" style="width:150px"></td>
        <td><input class="ti" data-f="name" value="${esc(z.name)}"></td>
        <td><label class="sw"><input type="checkbox" data-f="is_condo" ${z.is_condo ? 'checked' : ''}><span></span></label></td>
        <td><input class="ti num" data-f="fee" value="${moneyIn(z.fee)}"></td>
        <td class="keep"><label class="sw"><input type="checkbox" data-f="available" ${z.available ? 'checked' : ''}><span></span></label></td>
        <td class="td-acts keep"><button class="btn sm" data-save>Salvar</button> <button class="btn danger sm" data-del>Excluir</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhuma região encontrada.</td></tr>';
  }
  $('#zSearch').addEventListener('input', (e) => { P.zq = e.target.value; renderZones(); });
  async function setZonesOn(v) {
    const list = zoneFilter().filter((z) => z.available !== v);
    if (!list.length) return;
    if (!confirm(`${v ? 'Ligar' : 'Desligar'} ${list.length} região(ões)?`)) return;
    try {
      for (const z of list) { await api.setAvailable('zone', z.id, v); z.available = v; }
      renderZones();
      toast(`${list.length} região(ões) ${v ? 'ligada(s)' : 'desligada(s)'}`);
    } catch (ex) { toast(ex.message, 'err'); renderZones(); }
  }
  $('#zAllOn').onclick = () => setZonesOn(true);
  $('#zAllOff').onclick = () => setZonesOn(false);
  $('#zoneList').addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-zid]');
    if (!tr) return;
    const z = P.zones.find((x) => x.id === Number(tr.dataset.zid));
    const v = (f) => $(`[data-f=${f}]`, tr);
    if (e.target.closest('[data-save]')) {
      const fee = parseMoney(v('fee').value);
      if (!(fee >= 0) || !v('name').value.trim() || !v('city').value.trim()) { toast('Preencha cidade, nome e taxa', 'err'); return; }
      try {
        Object.assign(z, await api.saveZone(Object.assign({}, z, { city: v('city').value.trim(), name: v('name').value.trim(), fee, is_condo: v('is_condo').checked, available: v('available').checked })));
        toast(`"${z.name}" salvo`);
      } catch (ex) { toast(ex.message, 'err'); }
    }
    if (e.target.closest('[data-del]')) {
      if (!confirm(`Excluir a região "${z.name}"? Clientes desse bairro precisarão escolher outro.`)) return;
      try { await api.deleteZone(z.id); P.zones = P.zones.filter((x) => x.id !== z.id); renderZones(); toast('Região excluída'); }
      catch (ex) { toast(ex.message, 'err'); }
    }
  });
  $('#zoneList').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-zid]');
    if (!tr) return;
    const z = P.zones.find((x) => x.id === Number(tr.dataset.zid));
    if (e.target.matches('[data-f=is_condo]') && e.target.checked) $('[data-f=fee]', tr).value = moneyIn(P.settings.delivery_condo_fee);
    if (!e.target.matches('[data-f=available]')) return;
    const v = e.target.checked;
    try { await api.setAvailable('zone', z.id, v); z.available = v; tr.classList.toggle('off', !v); toast(v ? `Agora entrega em "${z.name}"` : `"${z.name}" desligado`); }
    catch (ex) { e.target.checked = !v; toast(ex.message, 'err'); }
  });
  $('#newZone').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const fee = parseMoney(f.fee.value);
    if (!f.city.value.trim() || !f.name.value.trim() || !(fee >= 0)) { toast('Preencha cidade, bairro e taxa', 'err'); return; }
    try {
      const saved = await api.saveZone({ city: f.city.value.trim(), name: f.name.value.trim(), fee, is_condo: f.is_condo.checked, available: true, sort: 0 });
      P.zones.push(saved);
      P.zones.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
      renderZones();
      e.target.reset();
      $('#feeCalc').textContent = '';
      toast(`"${saved.name}" adicionado e ligado`);
    } catch (ex) { toast(ex.message, 'err'); }
  };

  /* ---------- equipe ---------- */
  async function renderStaff() {
    if (!isAdmin()) return;
    const box = $('#staffList');
    box.innerHTML = '<p class="muted small">Carregando…</p>';
    try {
      const list = await api.listStaff();
      box.innerHTML = list.map((s) => `
        <div class="srow" data-email="${esc(s.email)}">
          <b>${esc(s.email)}</b>
          <select data-role><option value="atendente" ${s.role === 'atendente' ? 'selected' : ''}>Atendente</option><option value="admin" ${s.role === 'admin' ? 'selected' : ''}>Admin</option></select>
          <button class="btn danger sm" data-remove>Remover</button>
        </div>`).join('');
    } catch (ex) { box.innerHTML = `<p class="err">${esc(ex.message)}</p>`; }
  }
  $('#staffList').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-role]')) return;
    const email = e.target.closest('[data-email]').dataset.email;
    try { await api.setStaff(email, e.target.value); toast(`${email} agora é ${e.target.value}`); }
    catch (ex) { toast(ex.message, 'err'); renderStaff(); }
  });
  $('#staffList').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-remove]')) return;
    const email = e.target.closest('[data-email]').dataset.email;
    if (!confirm(`Remover ${email} da equipe? A pessoa perde o acesso ao painel.`)) return;
    try { await api.setStaff(email, ''); toast(`${email} removido da equipe`); renderStaff(); }
    catch (ex) { toast(ex.message, 'err'); }
  });
  $('#staffForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.email.value.trim()) { toast('Informe o e-mail', 'err'); return; }
    try { await api.setStaff(f.email.value.trim(), f.role.value); toast('Pessoa adicionada à equipe'); e.target.reset(); renderStaff(); }
    catch (ex) { toast(ex.message, 'err'); }
  };

  init();
})();
