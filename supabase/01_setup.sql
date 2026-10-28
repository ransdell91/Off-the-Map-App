-- Off The Map Production: database setup
-- One table holds every record (episodes, ideas, trips, tasks, prompts, config),
-- keyed by collection + id, with the record body in a JSON column.

create table if not exists public.items (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid                 default auth.uid(),
  primary key (col, id)
);

-- Who may use the app. Only these email addresses can read or change anything.
create table if not exists public.members (
  email    text primary key,
  name     text,
  added_at timestamptz not null default now()
);

alter table public.items   enable row level security;
alter table public.members enable row level security;  -- no policies: not readable from the app

create or replace function public.otm_is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke execute on function public.otm_is_member() from public, anon;
grant  execute on function public.otm_is_member() to authenticated;

drop policy if exists "members read"   on public.items;
drop policy if exists "members insert" on public.items;
drop policy if exists "members update" on public.items;
drop policy if exists "members delete" on public.items;
create policy "members read"   on public.items for select to authenticated using ((select public.otm_is_member()));
create policy "members insert" on public.items for insert to authenticated with check ((select public.otm_is_member()));
create policy "members update" on public.items for update to authenticated using ((select public.otm_is_member())) with check ((select public.otm_is_member()));
create policy "members delete" on public.items for delete to authenticated using ((select public.otm_is_member()));

-- Deep merge, so checking one box only changes that one field.
create or replace function public.otm_jsonb_merge(a jsonb, b jsonb)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  k text;
  result jsonb;
begin
  if a is null or jsonb_typeof(a) <> 'object' or b is null or jsonb_typeof(b) <> 'object' then
    return b;
  end if;
  result := a;
  for k in select jsonb_object_keys(b) loop
    if result ? k and jsonb_typeof(result -> k) = 'object' and jsonb_typeof(b -> k) = 'object' then
      result := jsonb_set(result, array[k], public.otm_jsonb_merge(result -> k, b -> k));
    else
      result := jsonb_set(result, array[k], b -> k);
    end if;
  end loop;
  return result;
end;
$$;

create or replace function public.otm_merge(p_col text, p_id text, p_patch jsonb)
returns void
language plpgsql security invoker
set search_path = ''
as $$
begin
  update public.items
     set data = public.otm_jsonb_merge(data, p_patch),
         updated_at = now(),
         updated_by = auth.uid()
   where col = p_col and id = p_id;
  if not found then
    raise exception 'Record %/% not found', p_col, p_id using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.otm_merge(text, text, jsonb) from public, anon;
grant  execute on function public.otm_merge(text, text, jsonb) to authenticated;
revoke execute on function public.otm_jsonb_merge(jsonb, jsonb) from public, anon;
grant  execute on function public.otm_jsonb_merge(jsonb, jsonb) to authenticated;

-- Live updates between your phone and Anna's.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items') then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;
