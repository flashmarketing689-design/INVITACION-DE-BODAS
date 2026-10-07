const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
// Prefer the service-role key configured in production; keep the alternate
// service-key name as a fallback for deployments that still use it.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
    },
    realtime: {
      transport: ws,
    },
  });
}

module.exports = { supabase, supabaseConfigured: Boolean(supabase) };
