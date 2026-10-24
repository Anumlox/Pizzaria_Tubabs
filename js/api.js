/*
 * Camada de dados da pizzaria.
 * - Com o Supabase configurado em config.js: usa o banco de verdade (login, pedidos em tempo real).
 * - Sem configuração: MODO DEMONSTRAÇÃO, com dados salvos no navegador (localStorage).
 * As telas (index.html e painel.html) usam só window.pizzaApi e window.PizzaUtil.
 */
(function () {
  'use strict';

  const CFG = window.PIZZARIA_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */
  const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function waLink(phone, text) {
    let d = onlyDigits(phone);
    if (d.length >= 10 && d.length <= 11) d = '55' + d;
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text || '');
  }
  function fmtPhone(p) {
    const d = onlyDigits(p).replace(/^55(?=\d{10,11}$)/, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return p || '';
  }
  // "49,90" | "49.90" | "1.049,90" -> número
  function parseMoney(v) {
    const s = String(v == null ? '' : v).trim().replace(/[R$\s]/g, '');
    if (!s) return NaN;
    return parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  }

  /* ---------- tamanhos, preços e descrição dos itens ---------- */
  const SIZES = [['broto', 'Broto'], ['media', 'Média'], ['grande', 'Grande']];
  const SIZE_NAME = { broto: 'Broto', media: 'Média', grande: 'Grande' };
  const code2 = (c) => (c == null ? '' : String(c).padStart(2, '0'));

  const round2 = (v) => Math.round(v * 100) / 100;
  const brotoPct = (st) => (st && st.broto_percent != null ? Number(st.broto_percent) : 50);
  const brotoExtra = (st) => (st && st.broto_half_extra != null ? Number(st.broto_half_extra) : 5);
  // preço de UM sabor inteiro no tamanho (broto = % da grande)
  function priceFor(p, size, st) {
    if (!p) return null;
    if (!p.is_pizza) return Number(p.price);
    if (size === 'broto') return round2(Number(p.price) * brotoPct(st) / 100);
    const v = size === 'media' ? p.price_media : p.price;
    return v == null || v === '' ? null : Number(v);
  }
  const isSweet = (p) => !!p && /doce/i.test(p.category || '');
  // MESMO cálculo do servidor (place_order):
  // sabor mais caro; broto = % da grande mais cara (+ adicional no meio a meio); borda mais cara; vulcão só na grande
  function unitPrice(p, size, half, b1, b2, st) {
    if (!p.is_pizza) return Number(p.price);
    let u;
    if (size === 'broto') {
      u = round2(Math.max(Number(p.price), half ? Number(half.price) : 0) * brotoPct(st) / 100) + (half ? brotoExtra(st) : 0);
    } else {
      const a = priceFor(p, size, st), b = half ? priceFor(half, size, st) : null;
      if (a == null || (half && b == null)) return null;
      u = Math.max(a, b == null ? 0 : b);
    }
    if (size !== 'grande' && ((b1 && b1.kind === 'vulcao') || (b2 && b2.kind === 'vulcao'))) return null;
    u += Math.max(b1 ? Number(b1.price) : 0, b2 ? Number(b2.price) : 0);
    return round2(u);
  }
  const borderName = (b) => (b ? b.name + (b.kind === 'vulcao' ? ' (vulcão)' : '') : null);
  const flavorLabel = (i) => (i.half ? `½ ${i.name} + ½ ${i.half}` : i.name);
  const itemLabel = (i) => (i.size ? `${SIZE_NAME[i.size]} · ${flavorLabel(i)}` : i.name);
  function borderLabel(i) {
    if (!i.border && !i.border2) return '';
    if (!i.half || i.border === i.border2) return i.border || i.border2;
    return `½ ${i.border || 'sem borda'} + ½ ${i.border2 || 'sem borda'}`;
  }

  function formatAddress(p, zone) {
    if (!p || !p.street) return '';
    let a = [`${p.street}, ${p.number}`, p.complement, zone ? `${zone.name} (${zone.city})` : p.district]
      .filter((x) => x && String(x).trim()).join(' - ');
    if (p.reference && p.reference.trim()) a += ` - Ref.: ${p.reference.trim()}`;
    return a;
  }

  // CEP -> rua e bairro (ViaCEP, gratuito)
  async function lookupCep(cep) {
    const d = onlyDigits(cep);
    if (d.length !== 8) return null;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${d}/json/`);
      const j = await r.json();
      if (j.erro) return null;
      return { street: j.logradouro || '', district: j.bairro || '', city: j.localidade || '', uf: j.uf || '' };
    } catch (e) { return null; }
  }

  /* ---------- Pix "copia e cola" estático (padrão BR Code do Banco Central) ---------- */
  function pixField(id, value) { const v = String(value); return id + String(v.length).padStart(2, '0') + v; }
  function crc16(str) {
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) { crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1; crc &= 0xffff; }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  const pixText = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '').trim().toUpperCase().slice(0, max);
  function pixPayload({ key, name, city, amount, txid }) {
    const account = pixField('00', 'br.gov.bcb.pix') + pixField('01', String(key).trim());
    let p = pixField('00', '01') + pixField('26', account) + pixField('52', '0000') + pixField('53', '986');
    if (amount) p += pixField('54', Number(amount).toFixed(2));
    p += pixField('58', 'BR') + pixField('59', pixText(name, 25) || 'PIZZARIA') + pixField('60', pixText(city, 15) || 'BRASIL');
    const tx = String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
    p += pixField('62', pixField('05', tx)) + '6304';
    return p + crc16(p);
  }

  function translateError(e) {
    const m = String((e && (e.message || e.error_description)) || e || 'Erro desconhecido');
    const map = [
      [/Invalid login credentials/i, 'E-mail ou senha incorretos.'],
      [/already registered|already been registered/i, 'Este e-mail já tem conta. Use "Já tenho conta".'],
      [/Password should be at least/i, 'A senha precisa ter pelo menos 6 caracteres.'],
      [/Unable to validate email|invalid format|is invalid/i, 'E-mail inválido.'],
      [/Email not confirmed/i, 'E-mail ainda não confirmado. (Dono do sistema: desative "Confirm email" no Supabase.)'],
      [/Failed to fetch|NetworkError|Load failed/i, 'Sem conexão com o servidor. Verifique a internet.'],
      [/rate limit|too many/i, 'Muitas tentativas seguidas. Aguarde um pouco e tente de novo.'],
      [/permission denied|row-level security/i, 'Você não tem permissão para fazer isso.'],
    ];
    for (const [re, msg] of map) if (re.test(m)) return new Error(msg);
    return new Error(m);
  }

  window.PizzaUtil = {
    money, onlyDigits, esc, norm, waLink, fmtPhone, parseMoney, code2,
    SIZES, SIZE_NAME, priceFor, unitPrice, isSweet, borderName, borderLabel, flavorLabel, itemLabel, formatAddress, lookupCep, pixPayload, crc16, round2,
  };

  const PROFILE_FIELDS = ['name', 'phone', 'cep', 'street', 'number', 'district', 'complement', 'reference'];
  const pickProfile = (p) => {
    const o = PROFILE_FIELDS.reduce((r, k) => { r[k] = String((p && p[k]) || '').trim(); return r; }, {});
    o.zone_id = p && p.zone_id ? Number(p.zone_id) : null;
    return o;
  };
  const PRODUCT_FIELDS = ['code', 'category', 'name', 'description', 'is_pizza', 'price', 'price_media', 'allow_half', 'available', 'sort', 'image_url'];
  const pickProduct = (p) => PRODUCT_FIELDS.reduce((o, k) => { if (k in p) o[k] = p[k]; return o; }, {});

  /* ------------------------------------------------------------------ */
  /* Supabase (produção)                                                 */
  /* ------------------------------------------------------------------ */
  function makeSupabaseApi() {
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('Não foi possível carregar o sistema. Verifique a internet e recarregue a página.');
    }
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    const must = ({ data, error }) => { if (error) throw translateError(error); return data; };
    const userOf = (u) => (u ? { user: { id: u.id, email: u.email } } : null);
    async function uid() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user.id : null; }

    return {
      demo: false,
      async getSession() { const { data } = await sb.auth.getSession(); return userOf(data.session && data.session.user); },
      async signUp({ email, password, profile }) {
        const data = must(await sb.auth.signUp({ email, password, options: { data: { name: profile.name, phone: profile.phone } } }));
        if (!data.session) throw new Error('Conta criada, mas falta confirmar o e-mail. (Dono do sistema: desative "Confirm email" no Supabase, veja o LEIA-ME.)');
        must(await sb.from('profiles').upsert(Object.assign({ user_id: data.user.id }, pickProfile(profile))));
        return userOf(data.user);
      },
      async signIn({ email, password }) { return userOf(must(await sb.auth.signInWithPassword({ email, password })).user); },
      async signOut() { await sb.auth.signOut(); },
      async getProfile() {
        const id = await uid();
        if (!id) return null;
        return must(await sb.from('profiles').select('*').eq('user_id', id).maybeSingle());
      },
      async saveProfile(p) {
        const id = await uid();
        if (!id) throw new Error('Faça login primeiro.');
        return must(await sb.from('profiles').upsert(Object.assign({ user_id: id, updated_at: new Date().toISOString() }, pickProfile(p))).select().single());
      },
      async getSettings() { return must(await sb.from('settings').select('*').eq('id', 1).single()); },
      async saveSettings(patch) { return must(await sb.from('settings').update(patch).eq('id', 1).select().single()); },
      async setStoreOpen(v) { return must(await sb.rpc('set_store_open', { p_open: v })); },
      async getProducts() { return must(await sb.from('products').select('*').order('sort').order('name')); },
      async saveProduct(p) {
        const row = pickProduct(p);
        if (p.id) return must(await sb.from('products').update(row).eq('id', p.id).select().single());
        return must(await sb.from('products').insert(row).select().single());
      },
      async deleteProduct(id) { must(await sb.from('products').delete().eq('id', id)); },
      async getBorders() { return must(await sb.from('borders').select('*').order('sort').order('name')); },
      async saveBorder(b) {
        const row = { name: b.name, price: b.price, kind: b.kind || 'comum', available: !!b.available, sort: Number(b.sort) || 0 };
        if (b.id) return must(await sb.from('borders').update(row).eq('id', b.id).select().single());
        return must(await sb.from('borders').insert(row).select().single());
      },
      async deleteBorder(id) { must(await sb.from('borders').delete().eq('id', id)); },
      async getZones() { return must(await sb.from('delivery_zones').select('*').order('city').order('name')); },
      async saveZone(z) {
        const row = { city: z.city, name: z.name, fee: z.fee, is_condo: !!z.is_condo, available: !!z.available, sort: Number(z.sort) || 0 };
        if (z.id) return must(await sb.from('delivery_zones').update(row).eq('id', z.id).select().single());
        return must(await sb.from('delivery_zones').insert(row).select().single());
      },
      async deleteZone(id) { must(await sb.from('delivery_zones').delete().eq('id', id)); },
      async setAvailable(kind, id, available) { must(await sb.rpc('set_available', { p_kind: kind, p_id: id, p_available: available })); },
      async placeOrder(o) {
        return must(await sb.rpc('place_order', {
          p_items: o.items, p_fulfillment: o.fulfillment, p_payment: o.payment,
          p_change_for: o.change_for == null ? null : o.change_for, p_notes: o.notes || '',
        }));
      },
      async getOrder(id) { return must(await sb.from('orders').select('*').eq('id', id).maybeSingle()); },
      async myOrders() {
        const id = await uid();
        return must(await sb.from('orders').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(20));
      },
      async listOrders(sinceISO) {
        return must(await sb.from('orders').select('*').gte('created_at', sinceISO).order('created_at', { ascending: true }).limit(500));
      },
      async updateOrder(id, patch) { return must(await sb.from('orders').update(patch).eq('id', id).select().single()); },
      async deleteOrder(id) { must(await sb.from('orders').delete().eq('id', id)); },
      async myRole() { return must(await sb.rpc('my_role')) || null; },
      async listStaff() { return must(await sb.rpc('admin_list_staff')); },
      async setStaff(email, role) { must(await sb.rpc('admin_set_staff', { p_email: email, p_role: role || '' })); },
      onOrders(cb) {
        const ch = sb.channel('painel-pedidos')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => cb()).subscribe();
        return () => sb.removeChannel(ch);
      },
      onOrder(id, cb) {
        const ch = sb.channel('pedido-' + id)
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: 'id=eq.' + id }, () => cb()).subscribe();
        return () => sb.removeChannel(ch);
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Modo demonstração (sem servidor)                                    */
  /* ------------------------------------------------------------------ */
  function makeDemoApi() {
    const PREFIX = 'pizzaria_demo4_';
    const MEM = {};
    const listeners = new Set();
    const get = (k, d) => {
      try { const v = localStorage.getItem(PREFIX + k); if (v != null) return JSON.parse(v); } catch (e) { /* sem localStorage */ }
      return k in MEM ? MEM[k] : d;
    };
    const set = (k, v) => {
      MEM[k] = v;
      try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) { /* ignora */ }
      listeners.forEach((f) => f(k));
    };
    window.addEventListener('storage', (e) => {
      if (e.key && e.key.indexOf(PREFIX) === 0) listeners.forEach((f) => f(e.key.slice(PREFIX.length)));
    });
    const wait = (v) => new Promise((r) => setTimeout(() => r(v), 120));
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    const DATA = window.PIZZARIA_DEMO_DATA || { store_name: 'Pizzaria', products: [], borders: [] };

    if (!get('products')) set('products', clone(DATA.products));
    if (!get('borders')) set('borders', clone(DATA.borders));
    if (!get('zones')) set('zones', clone(DATA.zones || []));
    if (!get('settings')) {
      set('settings', { id: 1, store_name: DATA.store_name, is_open: true, delivery_fee: 6, whatsapp: '', store_address: DATA.address || '',
        pix_key: 'pix@example.com', pix_name: DATA.store_name, pix_city: 'Aracoiaba da Serra',
        broto_percent: 50, broto_half_extra: 5, delivery_km_included: null, delivery_per_km: 1.5, delivery_condo_fee: 12 });
    }
    // painel e site têm logins separados na demonstração (como em aparelhos diferentes)
    const SESSION_KEY = /painel/.test(location.pathname) ? 'session_painel' : 'session_loja';
    const session = () => get(SESSION_KEY, null);
    function login(email) {
      email = String(email || '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('E-mail inválido.');
      const users = get('users', {});
      if (!users[email]) { users[email] = 'demo-' + Math.random().toString(36).slice(2, 10); set('users', users); }
      const s = { user: { id: users[email], email } };
      set(SESSION_KEY, s);
      return s;
    }
    const checkPass = (p) => { if (String(p || '').length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.'); };
    const profileOf = (uid) => get('profiles', {})[uid] || null;

    return {
      demo: true,
      async getSession() { return wait(session()); },
      async signUp({ email, password, profile }) {
        checkPass(password);
        const s = login(email);
        const all = get('profiles', {});
        all[s.user.id] = Object.assign({ user_id: s.user.id }, pickProfile(profile));
        set('profiles', all);
        return wait(s);
      },
      async signIn({ email, password }) { checkPass(password); return wait(login(email)); },
      async signOut() { set(SESSION_KEY, null); },
      async getProfile() { const s = session(); return wait(s ? clone(profileOf(s.user.id)) : null); },
      async saveProfile(p) {
        const s = session();
        if (!s) throw new Error('Faça login primeiro.');
        const all = get('profiles', {});
        all[s.user.id] = Object.assign({ user_id: s.user.id }, pickProfile(p));
        set('profiles', all);
        return wait(clone(all[s.user.id]));
      },
      async getSettings() { return wait(clone(get('settings'))); },
      async saveSettings(patch) { const st = Object.assign(get('settings'), patch); set('settings', st); return wait(clone(st)); },
      async setStoreOpen(v) { return this.saveSettings({ is_open: v }); },
      async getProducts() { return wait(clone(get('products')).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))); },
      async saveProduct(p) {
        const list = get('products');
        let row = p.id ? list.find((x) => x.id === p.id) : null;
        if (row) Object.assign(row, pickProduct(p));
        else { row = Object.assign({ id: nextId(list) }, pickProduct(p)); list.push(row); }
        set('products', list);
        return wait(clone(row));
      },
      async deleteProduct(id) { set('products', get('products').filter((x) => x.id !== id)); },
      async getBorders() { return wait(clone(get('borders')).sort((a, b) => a.sort - b.sort)); },
      async saveBorder(b) {
        const list = get('borders');
        let row = b.id ? list.find((x) => x.id === b.id) : null;
        const data = { name: b.name, price: Number(b.price), kind: b.kind || 'comum', available: !!b.available, sort: Number(b.sort) || 0 };
        if (row) Object.assign(row, data); else { row = Object.assign({ id: nextId(list) }, data); list.push(row); }
        set('borders', list);
        return wait(clone(row));
      },
      async deleteBorder(id) { set('borders', get('borders').filter((x) => x.id !== id)); },
      async getZones() { return wait(clone(get('zones', [])).sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name))); },
      async saveZone(z) {
        const list = get('zones', []);
        let row = z.id ? list.find((x) => x.id === z.id) : null;
        const data = { city: z.city, name: z.name, fee: Number(z.fee), is_condo: !!z.is_condo, available: !!z.available, sort: Number(z.sort) || 0 };
        if (row) Object.assign(row, data); else { row = Object.assign({ id: nextId(list) }, data); list.push(row); }
        set('zones', list);
        return wait(clone(row));
      },
      async deleteZone(id) { set('zones', get('zones', []).filter((x) => x.id !== id)); },
      async setAvailable(kind, id, available) {
        const key = kind === 'border' ? 'borders' : kind === 'zone' ? 'zones' : 'products';
        const list = get(key);
        const row = list.find((x) => x.id === id);
        if (row) row.available = available;
        set(key, list);
      },
      async placeOrder(o) {
        const s = session();
        if (!s) throw new Error('Faça login para fazer o pedido.');
        const st = get('settings');
        if (!st.is_open) throw new Error('A pizzaria está fechada no momento.');
        const prof = profileOf(s.user.id);
        if (!prof || prof.name.length < 2 || onlyDigits(prof.phone).length < 10) throw new Error('Complete seu cadastro (nome e WhatsApp) antes de pedir.');
        let zone = null;
        if (o.fulfillment === 'entrega') {
          if (!(prof.street && prof.number)) throw new Error('Cadastre seu endereço (rua e número) para receber em casa.');
          zone = get('zones', []).find((z) => z.id === prof.zone_id && z.available);
          if (!zone) throw new Error('Ainda não entregamos no seu bairro pelo site. Escolha retirada ou fale com a pizzaria pelo WhatsApp.');
        }
        const products = get('products'), borders = get('borders');
        const findP = (id) => products.find((p) => p.id === Number(id) && p.available);
        const findB = (id) => { const b = borders.find((x) => x.id === Number(id) && x.available); if (!b) throw new Error('A borda escolhida não está mais disponível.'); return b; };
        let sub = 0;
        const lines = o.items.map((it) => {
          const p = findP(it.product_id);
          if (!p) throw new Error('Um item do carrinho não está mais disponível. Atualize a página.');
          const qty = Number(it.qty);
          if (!(qty >= 1 && qty <= 20)) throw new Error('Quantidade inválida no carrinho.');
          const size = p.is_pizza ? (it.size || 'grande') : null;
          const h = it.half_id ? findP(it.half_id) : null;
          if (it.half_id && (!h || !h.allow_half || !p.allow_half)) throw new Error('Um sabor do meio a meio não está mais disponível.');
          const b1 = p.is_pizza && it.border_id ? findB(it.border_id) : null;
          const b2 = p.is_pizza && h && it.border2_id ? findB(it.border2_id) : null;
          const unit = unitPrice(p, size, h, b1, b2, st);
          if (unit == null) throw new Error('Combinação de tamanho e borda não disponível para ' + p.name + '.');
          sub += unit * qty;
          return { product_id: p.id, code: p.code, name: p.name, half: h ? h.name : null, half_code: h ? h.code : null,
            size, border: borderName(b1), border2: borderName(b2), qty, unit, obs: String(it.obs || '').slice(0, 140) };
        });
        const fee = zone ? Number(zone.fee) : 0;
        const total = Math.round((sub + fee) * 100) / 100;
        if (o.payment === 'dinheiro' && o.change_for != null && o.change_for < total) throw new Error('O valor do troco precisa ser maior que o total do pedido.');
        const id = get('seq', 0) + 1;
        set('seq', id);
        const order = {
          id, user_id: s.user.id, created_at: new Date().toISOString(),
          customer_name: prof.name, customer_phone: onlyDigits(prof.phone),
          fulfillment: o.fulfillment, address: zone ? formatAddress(prof, zone) : '',
          items: lines, subtotal: Math.round(sub * 100) / 100, delivery_fee: fee, total,
          payment_method: o.payment, change_for: o.payment === 'dinheiro' ? o.change_for : null,
          payment_status: 'pendente', status: 'novo', notes: o.notes || '',
        };
        const orders = get('orders', []);
        orders.push(order);
        set('orders', orders);
        return wait(clone(order));
      },
      async getOrder(id) { const s = session(); const o = get('orders', []).find((x) => x.id === Number(id)); return wait(o && s ? clone(o) : null); },
      async myOrders() { const s = session(); return wait(get('orders', []).filter((o) => s && o.user_id === s.user.id).reverse().slice(0, 20)); },
      async listOrders(sinceISO) { return wait(get('orders', []).filter((o) => o.created_at >= sinceISO)); },
      async updateOrder(id, patch) {
        const orders = get('orders', []);
        const o = orders.find((x) => x.id === Number(id));
        Object.assign(o, patch);
        set('orders', orders);
        return wait(clone(o));
      },
      async deleteOrder(id) { set('orders', get('orders', []).filter((x) => x.id !== id)); },
      async myRole() { return wait('admin'); },
      async listStaff() {
        const s = session();
        return wait([{ user_id: s ? s.user.id : 'demo', email: s ? s.user.email : 'voce@demo', role: 'admin' }].concat(get('staff', [])));
      },
      async setStaff(email, role) {
        const users = get('users', {});
        const e = String(email || '').trim().toLowerCase();
        if (!users[e]) throw new Error(`Não existe conta com o e-mail ${e}. A pessoa precisa criar a conta no site primeiro.`);
        let list = get('staff', []).filter((x) => x.email !== e);
        if (role) list = list.concat([{ user_id: users[e], email: e, role }]);
        set('staff', list);
      },
      onOrders(cb) { const f = (k) => { if (k === 'orders') cb(); }; listeners.add(f); return () => listeners.delete(f); },
      onOrder(id, cb) { return this.onOrders(cb); },
    };
  }

  try {
    window.pizzaApi = DEMO ? makeDemoApi() : makeSupabaseApi();
  } catch (e) {
    window.pizzaApiError = e;
  }
})();
