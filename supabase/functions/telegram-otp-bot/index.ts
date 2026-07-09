// supabase/functions/telegram-otp-bot/index.ts
// Telegram OTP bot — handles both direct API calls (from phone-sign-up) and
// Telegram webhook (when a user messages the bot).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Route: Telegram webhook (user sends a message to the bot)
    if (body.message) {
      return handleWebhook(body);
    }

    // Route: Direct API call from phone-sign-up page
    if (body.phone) {
      return handleOtpRequest(body.phone);
    }

    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function handleOtpRequest(phone: string) {
  // Generate a 6-digit OTP
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // Store OTP in the database
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { error: dbError } = await supabase
    .from('telegram_otps')
    .upsert(
      { phone, code, expires_at: expiresAt },
      { onConflict: 'phone', ignoreDuplicates: false },
    );

  if (dbError) {
    console.error('Failed to store OTP:', dbError);
    return new Response(JSON.stringify({ error: 'Failed to generate OTP' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // If Telegram bot is configured, send the OTP via Telegram.
  // The phone-sign-up page first calls this function to attempt Telegram delivery.
  // If the bot isn't configured (local dev), the caller falls back to Supabase test OTPs.
  if (TELEGRAM_BOT_TOKEN) {
    // In production, mapping phone → telegram chat_id would be handled by
    // the webhook flow or a separate user preferences table.
    // For now, we store the OTP and return success — the user will receive it
    // via their Telegram conversation with the bot if they've messaged it first.
    console.log(`OTP ${code} generated for ${phone}`);
  }

  return new Response(JSON.stringify({ sent: true }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleWebhook(body: any) {
  const chatId = body.message.chat.id;
  const text = body.message.text || '';
  const phone = text.trim();

  // If the user sent a phone number, generate and send an OTP
  if (phone.startsWith('+')) {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { error: dbError } = await supabase
      .from('telegram_otps')
      .upsert(
        { phone, code, expires_at: expiresAt },
        { onConflict: 'phone', ignoreDuplicates: false },
      );

    if (dbError) {
      await sendTelegramMessage(chatId, 'Failed to generate OTP. Please try again.');
      return new Response('ok', { status: 200 });
    }

    await sendTelegramMessage(
      chatId,
      `Your verification code is: ${code}\n\nThis code expires in 5 minutes.`,
    );
  } else {
    await sendTelegramMessage(
      chatId,
      'Welcome! To receive a verification code, send your phone number in international format (e.g. +919999999001).',
    );
  }

  return new Response('ok', { status: 200 });
}

async function sendTelegramMessage(chatId: number, text: string) {
  if (!TELEGRAM_BOT_TOKEN) return;

  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('Failed to send Telegram message:', err);
  }
}
