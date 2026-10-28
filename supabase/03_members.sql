-- Who can use the app. Use the exact email address each person signs in with.
insert into public.members (email, name) values
  ('contact@ramediapro.co', 'Rian')
  -- , ('anna@example.com', 'Anna')   -- remove the leading "--" and put Anna's email here
on conflict (email) do nothing;
