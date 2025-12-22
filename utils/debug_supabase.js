import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing env vars");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testLogin() {
  console.log("--- Step 1: Fetch Employee (No Join) ---");
  const { data: empData, error: empErr } = await supabase
    .from('employees')
    .select('*')
    .eq('email', 'manager@workload.com')
    .single();

  if (empErr) {
    console.error("Employee fetch FAILED:", empErr.message);
    return;
  }
  console.log("Employee found:", empData.name, "Role ID:", empData.role_id);

  console.log("\n--- Step 2: Fetch Role (No Join) ---");
  if (!empData.role_id) {
    console.log("No role_id for this user.");
  } else {
    const { data: roleData, error: roleErr } = await supabase
      .from('roles')
      .select('*')
      .eq('id', empData.role_id)
      .single();

    if (roleErr) {
      console.error("Role fetch FAILED:", roleErr.message);
    } else {
      console.log("Role found:", roleData.role_name, "Type:", roleData.role_type);
    }
  }

  console.log("\n--- Step 3: Fetch Clusters (No Join) ---");
  const { data: clustersData, error: clustersErr } = await supabase
    .from('employee_clusters')
    .select('cluster_id')
    .eq('employee_id', empData.employee_id);

  if (clustersErr) {
    console.error("Clusters fetch FAILED:", clustersErr.message);
  } else {
    console.log("Clusters found:", clustersData.length);
  }
}

testLogin();
