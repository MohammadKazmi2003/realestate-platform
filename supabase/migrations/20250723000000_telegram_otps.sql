-- Create a table to store Telegram OTP codes.
-- Used by the telegram-otp-bot edge function to persist codes
-- generated via Telegram bot webhook or direct API calls.

create table if not exists public.telegram_otps (
  phone text primary key,
  code text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

-- Allow the edge function (service role) to read/insert/update
grant all on public.telegram_otps to service_role;

-- No public access — OTP verification goes through Supabase Auth, not this table.
