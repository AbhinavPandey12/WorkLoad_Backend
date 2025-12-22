import supabase from "../db/supabaseClient.js";
import { sendNotificationToUser } from "./notificationController.js";

// ---------------------------
// LOGIN USER
// ---------------------------
// ---------------------------
// LOGIN USER
// ---------------------------
export const loginUser = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    // 1. Fetch user (No join)
    const { data: users, error: userError } = await supabase
      .from('employees')
      .select('*')
      .eq('email', email);
    
    if (userError) {
      console.error("Supabase User Query Error:", userError);
      throw userError;
    }

    if (!users || users.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = users[0];

    if (user.password !== password)
      return res.status(401).json({ error: "Invalid credentials" });

    // 2. Fetch role manually (No join)
    let roleName = "Employee";
    let roleType = "IC";
    if (user.role_id) {
      try {
        const { data: roleData, error: roleError } = await supabase
          .from('roles')
          .select('role_name, role_type')
          .eq('id', user.role_id)
          .single();
        if (!roleError && roleData) {
          roleName = roleData.role_name;
          roleType = roleData.role_type;
        }
      } catch (rErr) {
        console.warn("Role fetch error:", rErr.message);
      }
    }

    // 3. Fetch clusters manually (No join)
    let clusters = [];
    try {
      const { data: ecData, error: ecError } = await supabase
        .from('employee_clusters')
        .select('cluster_id')
        .eq('employee_id', user.employee_id);
      
      if (!ecError && ecData && ecData.length > 0) {
        const clusterIds = ecData.map(ec => ec.cluster_id);
        const { data: cData, error: cError } = await supabase
          .from('clusters')
          .select('cluster_name')
          .in('id', clusterIds);
        
        if (!cError && cData) {
          clusters = cData.map(c => c.cluster_name);
        }
      }
    } catch (cErr) {
      console.warn("Cluster fetch error:", cErr.message);
    }

    const safeUser = {
      employee_id: user.employee_id, // Integer PK
      name: user.name,
      email: user.email,
      role: roleName,
      role_type: roleType,
      clusters: clusters,
      availability: user.availability,
      created_at: user.created_at,
      updated_at: user.updated_at
    };

    // Send Notification
    try {
      sendNotificationToUser(user.employee_id, {
        title: "New Login Detected",
        message: `Login detected for ${user.email} at ${new Date().toLocaleTimeString()}`,
        url: "/"
      });
    } catch (nErr) {
      console.error("Notification error:", nErr);
    }

    // NOTE: last_login column is not in the provided new schema, so skipping update.
    // If needed, add last_login column to employees table or a separate log table.

    res.json({ success: true, user: safeUser });

  } catch (err) {
    console.error("Login error →", err);
    res.status(500).json({ error: "Supabase login error", details: err.message, hint: err.hint });
  }
};

// ---------------------------
// SIGNUP USER
// ---------------------------
export const signupUser = async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name)
    return res.status(400).json({ error: "All fields required" });

  if (!email.endsWith('@workload.com')) {
    return res.status(400).json({ error: "Email must end with @workload.com" });
  }

  try {
    // 1. Check if email exists
    const { data: existing, error: findError } = await supabase
      .from('employees')
      .select('employee_id')
      .eq('email', email);

    if (findError) throw findError;

    if (existing && existing.length > 0)
      return res.status(409).json({ error: "Email already registered" });

    // 2. Generate 6-digit integer employee_id (Unique)
    let employee_id;
    let isUnique = false;
    while (!isUnique) {
      employee_id = Math.floor(100000 + Math.random() * 900000);
      const { data: check } = await supabase.from('employees').select('employee_id').eq('employee_id', employee_id).single();
      if (!check) isUnique = true;
    }

    // 3. Get Default Role ID (IC type Developer)
    const { data: roleData, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('role_name', 'Software Developer') 
      .single();
    
    if (roleError || !roleData) {
       console.warn("Default role not found. Ensure DB is seeded.");
       // Fallback or error
       return res.status(500).json({ error: "Database not properly seeded. Missing roles." });
    }

    // 4. Insert Employee
    const { data: newEmp, error: insertError } = await supabase
      .from('employees')
      .insert([
        {
          employee_id,
          name,
          email,
          password,
          role_id: roleData.id,
          availability: 'Available'
        }
      ])
      .select()
      .single();

    if (insertError) throw insertError;

    // 5. Initialize Availability Details
    if (newEmp) {
      await supabase.from('availability_details').insert([{
        employee_id: newEmp.employee_id,
        availability: 'Available'
      }]);
    }

    res.json({ success: true, message: "Account created successfully" });
  } catch (err) {
    console.error("Signup error →", err);
    res.status(500).json({ error: "Supabase signup error" });
  }
};

// ---------------------------
// UPDATE PASSWORD
// ---------------------------
export const updatePassword = async (req, res) => {
  const { employee_id, currentPassword, newPassword } = req.body;

  if (!employee_id || !currentPassword || !newPassword) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    // 1. Fetch current user to verify password
    const { data: user, error: fetchError } = await supabase
      .from('employees')
      .select('password')
      .eq('employee_id', employee_id)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ error: "User not found" });
    }

    // 2. Verify current password
    if (user.password !== currentPassword) {
      return res.status(401).json({ error: "Incorrect current password" });
    }

    // 3. Update to new password
    const { error: updateError } = await supabase
      .from('employees')
      .update({ password: newPassword })
      .eq('employee_id', employee_id);

    if (updateError) throw updateError;

    // Send Notification
    sendNotificationToUser(employee_id, {
      title: "Password Changed",
      message: "Your password has been successfully updated.",
      url: "/profile"
    });

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Update password error →", err);
    res.status(500).json({ error: "Failed to update password" });
  }
};
