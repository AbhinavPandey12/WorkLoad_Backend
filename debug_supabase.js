import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testLogin() {
  console.log("\n--- Testing Joins Step-by-Step ---");
  
  console.log("Testing roles join...");
  const { error: e1 } = await supabase.from('employees').select('*, roles(role_name)').limit(1);
  if (e1) console.error("  roles join FAIL:", e1.message);
  else console.log("  roles join SUCCESS");

  console.log("Testing employee_clusters join...");
  const { error: e2 } = await supabase.from('employees').select('*, employee_clusters(cluster_id)').limit(1);
  if (e2) console.error("  employee_clusters join FAIL:", e2.message);
  else console.log("  employee_clusters join SUCCESS");

  console.log("Testing full clusters join...");
  const { error: e3 } = await supabase.from('employees').select('*, employee_clusters(clusters(cluster_name))').limit(1);
  if (e3) console.error("  full clusters join FAIL:", e3.message);
  else console.log("  full clusters join SUCCESS");
}

testLogin();
