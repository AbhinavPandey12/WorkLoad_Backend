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
    // Normalized Schema: Join roles and clusters
    // We assume 'roles' table has 'role_name' and 'role_type' and 'clusters' has 'cluster_name'
    const { data: users, error } = await supabase
      .from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        clusters ( cluster_name )
      `)
      .eq('email', email);

    if (error) throw error;

    if (!users || users.length === 0)
      return res.status(401).json({ error: "Invalid credentials" });

    const user = users[0];

    if (user.password !== password)
      return res.status(401).json({ error: "Invalid credentials" });

    // Flatten structure for frontend compatibility
    const roleName = user.roles ? user.roles.role_name : "Employee";
    const roleType = user.roles ? user.roles.role_type : "Employee";
    const clusterName = user.clusters ? user.clusters.cluster_name : null;

    const safeUser = {
      empid: user.empid,
      employee_id: user.employee_id, // New UUID
      name: user.name,
      email: user.email,
      role: roleName,
      role_type: roleType, // Correctly mapped from roles table
      cluster: clusterName,
      // Pass through other fields if needed, but avoid nested objects if frontend doesn't expect them
      created_at: user.created_at,
      updated_at: user.updated_at
    };

    // Send Notification
    try {
      sendNotificationToUser(user.empid, {
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
    res.status(500).json({ error: "Supabase login error" });
  }
};

// ---------------------------
// SIGNUP USER
// ---------------------------
export const signupUser = async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password || !name)
    return res.status(400).json({ error: "All fields required" });

  try {
    // 1. Check if email exists
    const { data: existing, error: findError } = await supabase
      .from('employees')
      .select('employee_id')
      .eq('email', email);

    if (findError) throw findError;

    if (existing && existing.length > 0)
      return res.status(409).json({ error: "Email already registered" });

    // 2. Generate EMPID
    const empid = `E${String(Date.now()).slice(-6)}`;

    // 3. Get Default Role ID (Employee)
    const { data: roleData, error: roleError } = await supabase
      .from('roles')
      .select('role_id')
      .eq('role_name', 'Employee') // Assuming 'Employee' role exists
      .single();
    
    // If role fetch fails, we might proceed with null or error. 
    // Ideally we should handle this. For now logging.
    let defaultRoleId = null;
    if (roleData) defaultRoleId = roleData.role_id;
    else console.warn("Default 'Employee' role not found in DB.");

    // 4. Insert Employee
    const { data: newEmp, error: insertError } = await supabase
      .from('employees')
      .insert([
        {
          empid,
          name,
          email,
          password,
          role_id: defaultRoleId,
          // cluster_id is null initially
        }
      ])
      .select()
      .single();

    if (insertError) throw insertError;

    // 5. Initialize Availability (Default to 'Available' or 'Busy'?)
    // User schema has availability table.
    // Let's create a default availability entry.
    if (newEmp) {
      await supabase.from('availability').insert([{
        employee_id: newEmp.employee_id,
        status: 'Available', // Default
        hours_available: 8 // Default
        // from_date/to_date null
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
  const { empid, currentPassword, newPassword } = req.body;

  if (!empid || !currentPassword || !newPassword) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    // 1. Fetch current user to verify password
    const { data: users, error: fetchError } = await supabase
      .from('employees')
      .select('password')
      .eq('empid', empid)
      .single();

    if (fetchError || !users) {
      return res.status(404).json({ error: "User not found" });
    }

    // 2. Verify current password
    console.log(`[UpdatePassword] Verifying: DB=${users.password} vs Input=${currentPassword}`);
    if (users.password !== currentPassword) {
      console.log("[UpdatePassword] Password mismatch!");
      return res.status(401).json({ error: "Incorrect current password" });
    }

    // 3. Update to new password
    const { error: updateError } = await supabase
      .from('employees')
      .update({ password: newPassword })
      .eq('empid', empid);

    if (updateError) throw updateError;

    // Send Notification
    sendNotificationToUser(empid, {
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
