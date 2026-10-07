const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
// Prefer the current service key. Keep the legacy service-role name as a
// fallback so existing deployments continue to work during the transition.
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

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
