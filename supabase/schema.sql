-- =====================================================================
--  PIZZARIA ONLINE · Banco de dados (Supabase / PostgreSQL) · versão 3
--  Como usar: Supabase > SQL Editor > New query > cole TUDO > Run.
--  Depois rode o cardapio.sql para carregar o cardápio.
--  Pode rodar de novo sem problema: não apaga pedidos, clientes nem cardápio.
-- =====================================================================

-- ---------- Configurações da loja (uma linha só) ----------
create table if not exists public.settings (
  id           int primary key default 1 check (id = 1),
  store_name   text not null default 'Minha Pizzaria',
  is_open      boolean not null default true,
  delivery_fee numeric(10,2) not null default 0 check (delivery_fee >= 0),
  whatsapp     text not null default '',
  pix_key      text not null default '',
  pix_name     text not null default '',
  pix_city     text not null default ''
);
alter table public.settings add column if not exists store_address text not null default '';
-- broto = % do preço da GRANDE (do sabor mais caro); meio a meio na broto soma um adicional
alter table public.settings add column if not exists broto_percent     numeric(5,2)  not null default 50;
alter table public.settings add column if not exists broto_half_extra  numeric(10,2) not null default 5;
-- regra de entrega (usada pela calculadora do painel ao cadastrar regiões)
-- delivery_fee = taxa base; acima de delivery_km_included km cobra delivery_per_km por km
alter table public.settings add column if not exists delivery_km_included numeric(6,2);
alter table public.settings add column if not exists delivery_per_km      numeric(10,2) not null default 1.50;
alter table public.settings add column if not exists delivery_condo_fee   numeric(10,2) not null default 12;
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------- Cardápio ----------
-- Pizzas: price = GRANDE, price_media = MÉDIA, price_broto = BROTO (vazio = não vende broto).
-- Outros itens (bebidas etc.): só price.
create table if not exists public.products (
  id          bigint generated always as identity primary key,
  category    text not null,
  name        text not null,
  description text not null default '',
  price       numeric(10,2) not null check (price >= 0),
  allow_half  boolean not null default false,
  available   boolean not null default true,
  sort        int not null default 0
);
alter table public.products add column if not exists code        int;
alter table public.products add column if not exists is_pizza    boolean not null default false;
alter table public.products add column if not exists price_media numeric(10,2) check (price_media >= 0);
alter table public.products add column if not exists price_broto numeric(10,2) check (price_broto >= 0);
alter table public.products add column if not exists image_url   text not null default '';

-- ---------- Bordas recheadas ----------
create table if not exists public.borders (
  id        bigint generated always as identity primary key,
  name      text not null,
  price     numeric(10,2) not null default 0 check (price >= 0),
  available boolean not null default false,
  sort      int not null default 0
);

alter table public.borders add column if not exists kind text not null default 'comum';
do $$ begin
  alter table public.borders add constraint borders_kind_check check (kind in ('comum','vulcao'));
exception when duplicate_object then null; end $$;

-- ---------- Regiões de entrega (bairros e condomínios atendidos) ----------
create table if not exists public.delivery_zones (
  id        bigint generated always as identity primary key,
  city      text not null,
  name      text not null,
  fee       numeric(10,2) not null default 0 check (fee >= 0),
  is_condo  boolean not null default false,
  available boolean not null default false,
  sort      int not null default 0
);

-- ---------- Equipe: admin (tudo) ou atendente (pedidos e esgotados) ----------
create table if not exists public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.staff add column if not exists role text not null default 'atendente';
do $$ begin
  alter table public.staff add constraint staff_role_check check (role in ('admin','atendente'));
exception when duplicate_object then null; end $$;

-- ---------- Cadastro do cliente (com endereço) ----------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  phone      text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists cep        text not null default '';
alter table public.profiles add column if not exists street     text not null default '';
alter table public.profiles add column if not exists number     text not null default '';
alter table public.profiles add column if not exists district   text not null default '';
alter table public.profiles add column if not exists complement text not null default '';
alter table public.profiles add column if not exists reference  text not null default '';
alter table public.profiles add column if not exists zone_id    bigint references public.delivery_zones(id) on delete set null;

-- ---------- Pedidos ----------
create table if not exists public.orders (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  customer_name  text not null,
  customer_phone text not null,
  fulfillment    text not null check (fulfillment in ('entrega','retirada')),
  address        text not null default '',
  items          jsonb not null,
  subtotal       numeric(10,2) not null,
  delivery_fee   numeric(10,2) not null,
  total          numeric(10,2) not null,
  payment_method text not null check (payment_method in ('pix','cartao','dinheiro')),
  change_for     numeric(10,2),
  payment_status text not null default 'pendente' check (payment_status in ('pendente','pago')),
  status         text not null default 'novo'
                 check (status in ('novo','preparo','entrega','concluido','cancelado')),
  notes          text not null default ''
);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_user_idx       on public.orders (user_id, created_at desc);

-- ---------- Papéis ----------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and role = 'admin');
$$;
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.staff where user_id = auth.uid();
$$;

-- =====================================================================
--  SEGURANÇA (Row Level Security)
--  Cliente: vê cardápio, o próprio cadastro e os próprios pedidos.
--  Atendente: vê e atualiza pedidos, abre/fecha a loja, marca esgotado.
--  Admin: tudo isso + edita/exclui cardápio, bordas, pedidos, loja e equipe.
-- =====================================================================
alter table public.settings enable row level security;
alter table public.products enable row level security;
alter table public.borders  enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.staff    enable row level security;
alter table public.profiles enable row level security;
alter table public.orders   enable row level security;

drop policy if exists settings_read         on public.settings;
drop policy if exists settings_staff_update on public.settings;
drop policy if exists settings_admin_update on public.settings;
create policy settings_read         on public.settings for select using (true);
create policy settings_admin_update on public.settings for update
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists products_read         on public.products;
drop policy if exists products_staff_insert on public.products;
drop policy if exists products_staff_update on public.products;
drop policy if exists products_staff_delete on public.products;
drop policy if exists products_admin_insert on public.products;
drop policy if exists products_admin_update on public.products;
drop policy if exists products_admin_delete on public.products;
create policy products_read         on public.products for select using (available or public.is_staff());
create policy products_admin_insert on public.products for insert with check (public.is_admin());
create policy products_admin_update on public.products for update using (public.is_admin()) with check (public.is_admin());
create policy products_admin_delete on public.products for delete using (public.is_admin());

drop policy if exists borders_read         on public.borders;
drop policy if exists borders_admin_insert on public.borders;
drop policy if exists borders_admin_update on public.borders;
drop policy if exists borders_admin_delete on public.borders;
create policy borders_read         on public.borders for select using (available or public.is_staff());
create policy borders_admin_insert on public.borders for insert with check (public.is_admin());
create policy borders_admin_update on public.borders for update using (public.is_admin()) with check (public.is_admin());
create policy borders_admin_delete on public.borders for delete using (public.is_admin());

drop policy if exists zones_read         on public.delivery_zones;
drop policy if exists zones_admin_insert on public.delivery_zones;
drop policy if exists zones_admin_update on public.delivery_zones;
drop policy if exists zones_admin_delete on public.delivery_zones;
create policy zones_read         on public.delivery_zones for select using (available or public.is_staff());
create policy zones_admin_insert on public.delivery_zones for insert with check (public.is_admin());
create policy zones_admin_update on public.delivery_zones for update using (public.is_admin()) with check (public.is_admin());
create policy zones_admin_delete on public.delivery_zones for delete using (public.is_admin());

drop policy if exists staff_self_read on public.staff;
create policy staff_self_read on public.staff for select using (user_id = auth.uid());

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select using (user_id = auth.uid() or public.is_staff());
create policy profiles_insert on public.profiles for insert with check (user_id = auth.uid());
create policy profiles_update on public.profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists orders_read         on public.orders;
drop policy if exists orders_staff_update on public.orders;
drop policy if exists orders_admin_delete on public.orders;
create policy orders_read         on public.orders for select using (user_id = auth.uid() or public.is_staff());
create policy orders_staff_update on public.orders for update using (public.is_staff()) with check (public.is_staff());
create policy orders_admin_delete on public.orders for delete using (public.is_admin());
-- (de propósito: nenhuma policy de INSERT em orders; pedidos só entram por place_order)

-- =====================================================================
--  FAZER PEDIDO: nome, telefone, endereço e região vêm do CADASTRO;
--  produtos, tamanhos, meio a meio, bordas e taxa de entrega são
--  conferidos e o total é calculado aqui no servidor.
--  Item: {product_id, size: broto|media|grande, half_id?, border_id?, border2_id?, qty, obs}
--  Regras de preço da pizza:
--   - grande / média: preço do sabor mais caro naquele tamanho
--   - broto: broto_percent% da GRANDE do sabor mais caro (+ broto_half_extra se for meio a meio)
--   - borda: no meio a meio cada metade pode ter uma borda; cobra a borda mais cara
--   - borda vulcão: só na pizza grande
-- =====================================================================
drop function if exists public.place_order(jsonb, text, text, text, numeric, text, text, text);

create or replace function public.place_order(
  p_items       jsonb,
  p_fulfillment text,
  p_payment     text,
  p_change_for  numeric,
  p_notes       text
)
returns public.orders
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_set    public.settings;
  v_prof   public.profiles;
  v_zone   public.delivery_zones;
  v_item   jsonb;
  v_p      public.products;
  v_h      public.products;
  v_b1     public.borders;
  v_b2     public.borders;
  v_qty    int;
  v_pid    bigint;
  v_hid    bigint;
  v_bid    bigint;
  v_bid2   bigint;
  v_size   text;
  v_unit   numeric;
  v_bprice numeric;
  v_lines  jsonb := '[]'::jsonb;
  v_sub    numeric := 0;
  v_fee    numeric := 0;
  v_total  numeric;
  v_phone  text;
  v_addr   text := '';
  v_order  public.orders;
begin
  if v_uid is null then
    raise exception 'Faça login para fazer o pedido.';
  end if;

  select * into v_set from public.settings where id = 1;
  if not v_set.is_open then
    raise exception 'A pizzaria está fechada no momento.';
  end if;

  select * into v_prof from public.profiles where user_id = v_uid;
  if not found then
    raise exception 'Complete seu cadastro (nome e WhatsApp) antes de pedir.';
  end if;
  v_phone := regexp_replace(coalesce(v_prof.phone, ''), '\D', '', 'g');
  if length(trim(v_prof.name)) < 2 or length(v_phone) < 10 or length(v_phone) > 13 then
    raise exception 'Complete seu cadastro (nome e WhatsApp) antes de pedir.';
  end if;

  if p_fulfillment not in ('entrega','retirada') then
    raise exception 'Escolha entrega ou retirada.';
  end if;
  if p_payment not in ('pix','cartao','dinheiro') then
    raise exception 'Forma de pagamento inválida.';
  end if;

  if p_fulfillment = 'entrega' then
    if trim(v_prof.street) = '' or trim(v_prof.number) = '' then
      raise exception 'Cadastre seu endereço (rua e número) para receber em casa.';
    end if;
    select * into v_zone from public.delivery_zones where id = v_prof.zone_id and available;
    if not found then
      raise exception 'Ainda não entregamos no seu bairro pelo site. Escolha retirada ou fale com a pizzaria pelo WhatsApp.';
    end if;
    v_fee := v_zone.fee;
    v_addr := concat_ws(' - ',
      trim(v_prof.street) || ', ' || trim(v_prof.number),
      nullif(trim(v_prof.complement), ''),
      v_zone.name || ' (' || v_zone.city || ')');
    if trim(v_prof.reference) <> '' then
      v_addr := v_addr || ' - Ref.: ' || trim(v_prof.reference);
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Seu carrinho está vazio.';
  end if;
  if jsonb_array_length(p_items) > 30 then
    raise exception 'Pedido muito grande. Fale com a pizzaria pelo WhatsApp.';
  end if;
  if (select count(*) from public.orders
       where user_id = v_uid and created_at > now() - interval '10 minutes') >= 3 then
    raise exception 'Muitos pedidos seguidos. Aguarde alguns minutos ou fale com a pizzaria.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_qty  := (v_item->>'qty')::int;
      v_pid  := (v_item->>'product_id')::bigint;
      v_hid  := nullif(v_item->>'half_id', '')::bigint;
      v_bid  := nullif(v_item->>'border_id', '')::bigint;
      v_bid2 := nullif(v_item->>'border2_id', '')::bigint;
      v_size := coalesce(nullif(v_item->>'size', ''), 'grande');
    exception when others then
      raise exception 'Item inválido no carrinho.';
    end;
    if v_qty is null or v_qty < 1 or v_qty > 20 then
      raise exception 'Quantidade inválida no carrinho.';
    end if;

    select * into v_p from public.products where id = v_pid and available;
    if not found then
      raise exception 'Um item do carrinho não está mais disponível. Atualize a página.';
    end if;

    v_h := null; v_b1 := null; v_b2 := null; v_bprice := 0;

    if v_p.is_pizza then
      if v_size not in ('broto','media','grande') then
        raise exception 'Tamanho inválido.';
      end if;

      if v_hid is not null then
        if not v_p.allow_half then
          raise exception '% não aceita meio a meio.', v_p.name;
        end if;
        select * into v_h from public.products
          where id = v_hid and available and allow_half and is_pizza;
        if not found then
          raise exception 'Um sabor do meio a meio não está mais disponível.';
        end if;
      end if;

      -- preço: sempre o sabor mais caro
      if v_size = 'grande' then
        v_unit := greatest(v_p.price, v_h.price);
      elsif v_size = 'media' then
        if v_p.price_media is null or (v_h.id is not null and v_h.price_media is null) then
          raise exception 'Tamanho média não disponível para este sabor.';
        end if;
        v_unit := greatest(v_p.price_media, v_h.price_media);
      else
        v_unit := round(greatest(v_p.price, v_h.price) * v_set.broto_percent / 100, 2);
        if v_h.id is not null then
          v_unit := v_unit + v_set.broto_half_extra;
        end if;
      end if;

      -- bordas (uma por metade no meio a meio; cobra a mais cara)
      if v_bid is not null then
        select * into v_b1 from public.borders where id = v_bid and available;
        if not found then raise exception 'A borda escolhida não está mais disponível.'; end if;
      end if;
      if v_bid2 is not null then
        if v_h.id is null then raise exception 'Item inválido no carrinho.'; end if;
        select * into v_b2 from public.borders where id = v_bid2 and available;
        if not found then raise exception 'A borda escolhida não está mais disponível.'; end if;
      end if;
      if v_size <> 'grande' and (v_b1.kind = 'vulcao' or v_b2.kind = 'vulcao') then
        raise exception 'Borda vulcão só na pizza grande.';
      end if;
      v_bprice := coalesce(greatest(v_b1.price, v_b2.price), 0);
      v_unit := v_unit + v_bprice;
    else
      v_size := null;
      v_unit := v_p.price;
    end if;

    v_sub := v_sub + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_p.id, 'code', v_p.code, 'name', v_p.name,
      'half', v_h.name, 'half_code', v_h.code, 'size', v_size,
      'border',  case when v_b1.id is null then null else v_b1.name || case when v_b1.kind = 'vulcao' then ' (vulcão)' else '' end end,
      'border2', case when v_b2.id is null then null else v_b2.name || case when v_b2.kind = 'vulcao' then ' (vulcão)' else '' end end,
      'border_price', v_bprice,
      'qty', v_qty, 'unit', v_unit,
      'obs', left(trim(coalesce(v_item->>'obs', '')), 140)
    );
  end loop;

  v_total := v_sub + v_fee;

  if p_payment = 'dinheiro' and p_change_for is not null and p_change_for < v_total then
    raise exception 'O valor do troco precisa ser maior que o total do pedido.';
  end if;

  insert into public.orders (
    user_id, customer_name, customer_phone, fulfillment, address, items,
    subtotal, delivery_fee, total, payment_method, change_for, notes
  ) values (
    v_uid, left(trim(v_prof.name), 60), v_phone, p_fulfillment, left(v_addr, 300), v_lines,
    v_sub, v_fee, v_total, p_payment,
    case when p_payment = 'dinheiro' then p_change_for else null end,
    left(trim(coalesce(p_notes, '')), 200)
  )
  returning * into v_order;

  return v_order;
end;
$$;

-- ---------- Ações da equipe ----------
create or replace function public.set_store_open(p_open boolean) returns public.settings
language plpgsql security definer set search_path = public as $$
declare v public.settings;
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode fazer isso.'; end if;
  update public.settings set is_open = p_open where id = 1 returning * into v;
  return v;
end $$;

create or replace function public.set_available(p_kind text, p_id bigint, p_available boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Apenas a equipe pode fazer isso.'; end if;
  if p_kind = 'product' then
    update public.products set available = p_available where id = p_id;
  elsif p_kind = 'border' then
    update public.borders set available = p_available where id = p_id;
  elsif p_kind = 'zone' then
    if not public.is_admin() then raise exception 'Apenas o administrador pode fazer isso.'; end if;
    update public.delivery_zones set available = p_available where id = p_id;
  else
    raise exception 'Tipo inválido.';
  end if;
end $$;

-- ---------- Administração da equipe ----------
create or replace function public.admin_list_staff()
returns table (user_id uuid, email text, role text)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Apenas o administrador pode fazer isso.'; end if;
  return query
    select s.user_id, u.email::text, s.role
      from public.staff s join auth.users u on u.id = s.user_id
     order by s.role, u.email;
end $$;

-- p_role: 'admin', 'atendente' ou vazio (remove da equipe)
create or replace function public.admin_set_staff(p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Apenas o administrador pode fazer isso.'; end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'Não existe conta com o e-mail %. A pessoa precisa criar a conta no site primeiro.', trim(p_email);
  end if;
  if coalesce(p_role, '') = '' then
    if v_id = auth.uid() then raise exception 'Você não pode remover a si mesmo.'; end if;
    delete from public.staff where user_id = v_id;
  else
    if p_role not in ('admin','atendente') then raise exception 'Função inválida.'; end if;
    if v_id = auth.uid() and p_role <> 'admin' then
      raise exception 'Você não pode tirar seu próprio acesso de administrador.';
    end if;
    insert into public.staff (user_id, role) values (v_id, p_role)
      on conflict (user_id) do update set role = excluded.role;
  end if;
end $$;

-- ---------- Permissões das funções ----------
revoke all on function public.place_order(jsonb, text, text, numeric, text) from public, anon;
revoke all on function public.set_store_open(boolean)                     from public, anon;
revoke all on function public.set_available(text, bigint, boolean)        from public, anon;
revoke all on function public.admin_list_staff()                          from public, anon;
revoke all on function public.admin_set_staff(text, text)                 from public, anon;
grant execute on function public.place_order(jsonb, text, text, numeric, text) to authenticated;
grant execute on function public.set_store_open(boolean)                     to authenticated;
grant execute on function public.set_available(text, bigint, boolean)        to authenticated;
grant execute on function public.admin_list_staff()                          to authenticated;
grant execute on function public.admin_set_staff(text, text)                 to authenticated;

-- ---------- Tempo real: o painel recebe pedidos na hora ----------
do $$
begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null;
end $$;
