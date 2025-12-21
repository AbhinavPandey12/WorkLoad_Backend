import supabase from "../db/supabaseClient.js";
import { sendNotificationToUser } from "./notificationController.js";

/**
 * Helpers for Normalized DB
 */

const getRoleId = async (roleName) => {
  if (!roleName) return null;
  const { data } = await supabase.from('roles').select('role_id').eq('role_name', roleName).single();
  return data ? data.role_id : null;
};

const getClusterId = async (clusterName) => {
  if (!clusterName) return null;
  const { data } = await supabase.from('clusters').select('cluster_id').eq('cluster_name', clusterName).single();
  return data ? data.cluster_id : null; 
};

const getOrInsertSkillId = async (skillName) => {
  if (!skillName) return null;
  const { data } = await supabase.from('skills').select('skill_id').eq('skill_name', skillName).single();
  if (data) return data.skill_id;
  const { data: newData } = await supabase.from('skills').insert([{ skill_name: skillName }]).select('skill_id').single();
  return newData ? newData.skill_id : null;
};

const getOrInsertInterestId = async (interestName) => {
  if (!interestName) return null;
  const { data } = await supabase.from('interests').select('interest_id').eq('interest_name', interestName).single();
  if (data) return data.interest_id;
  const { data: newData } = await supabase.from('interests').insert([{ interest_name: interestName }]).select('interest_id').single();
  return newData ? newData.interest_id : null;
};

const getOrInsertProjectId = async (projectName) => {
  if (!projectName) return null;
  const { data } = await supabase.from('projects').select('project_id').eq('project_name', projectName).single();
  if (data) return data.project_id;
  const { data: newData } = await supabase.from('projects').insert([{ project_name: projectName }]).select('project_id').single();
  return newData ? newData.project_id : null;
};

// Data Transformer: DB Normalized -> Frontend JSON
const transformEmployee = (emp) => {
  // Get Latest Availability (if array)
  // One-to-many: availability table. We want the one with latest created_at
  const latestAvail = (emp.availability && Array.isArray(emp.availability) && emp.availability.length > 0)
    ? emp.availability.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0]
    : (Array.isArray(emp.availability) ? {} : emp.availability); 
    // If availability is an object (single), use it. Join sometimes returns array, sometimes single depending on query.
    // Supabase join usually returns array for one-to-many.

  // Skills
  const skills = emp.employee_skills ? emp.employee_skills.map(es => es.skills?.skill_name).filter(Boolean) : [];
  
  // Interests
  const interests = emp.employee_interests ? emp.employee_interests.map(ei => ei.interests?.interest_name).filter(Boolean) : [];

  // Projects
  const currentProject = emp.employee_projects
    ? emp.employee_projects.find(ep => ep.project_type === 'CURRENT')?.projects?.project_name || ""
    : "";
  
  const previousProjects = emp.employee_projects
    ? emp.employee_projects.filter(ep => ep.project_type === 'PREVIOUS').map(ep => ep.projects?.project_name).filter(Boolean)
    : [];

  return {
    empid: emp.empid,
    name: emp.name,
    email: emp.email,
    role: emp.roles?.role_name || "Employee",
    role_type: emp.roles?.role_type || "Employee", // Mapped from roles table
    cluster: emp.clusters?.cluster_name || "",
    cluster2: "", // Deprecated in normal form, return empty or handle?
    
    // Stars: assume column exists in employees table
    stars: emp.stars || 0,
    
    // Details
    current_skills: skills,
    interests: interests,
    current_project: currentProject,
    previous_projects: previousProjects,
    
    // Status
    availability: latestAvail?.status || "Occupied", // Default
    hours_available: latestAvail?.hours_available || null,
    from_date: latestAvail?.from_date || null,
    to_date: latestAvail?.to_date || null,
    
    updated_at: emp.updated_at
  };
};

/**
 * REST Controllers
 */

// GET ALL
export const getAllEmployees = async (req, res) => {
  const { search = "", availability = "" } = req.query;
  try {
    const { data: employees, error } = await supabase
      .from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        clusters ( cluster_name ),
        employee_skills ( skills ( skill_name ) ),
        employee_interests ( interests ( interest_name ) ),
        employee_projects ( project_type, projects ( project_name ) ),
        availability ( status, hours_available, from_date, to_date, created_at )
      `)
      .order('empid', { ascending: true }); // Base sort

    if (error) throw error;

    let result = (employees || []).map(transformEmployee);

    // Filter in JS (Supabase complex filtering on joined tables is hard)
    if (search || availability) {
       result = result.filter(emp => {
          const s = search.toLowerCase();
          const matchesSearch = !s || 
             emp.name.toLowerCase().includes(s) || 
             emp.current_skills.some(sk => sk.toLowerCase().includes(s));
          
          const matchesAvail = !availability || availability === "All" || emp.availability === availability;
          
          return matchesSearch && matchesAvail;
       });
    }

    res.json(result);
  } catch (err) {
    console.error("Fetch employees error →", err);
    res.status(500).json({ error: "Supabase fetch error" });
  }
};

// GET by empid
export const getEmployeeById = async (req, res) => {
  const { empid } = req.params;
  try {
    const { data, error } = await supabase
      .from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        clusters ( cluster_name ),
        employee_skills ( skills ( skill_name ) ),
        employee_interests ( interests ( interest_name ) ),
        employee_projects ( project_type, projects ( project_name ) ),
        availability ( status, hours_available, from_date, to_date, created_at )
      `)
      .eq('empid', empid);

    if (error) throw error;

    if (!data || data.length === 0) return res.status(404).json({ error: "Employee not found" });
    
    res.json(transformEmployee(data[0]));
  } catch (err) {
    console.error("Fetch employee error →", err);
    res.status(500).json({ error: "Supabase fetch error" });
  }
};

// UPDATE (Complex Transaction-like logic)
export const updateEmployee = async (req, res) => {
  const { empid } = req.params;
  const body = req.body;
  
  try {
    // 1. Get Employee UUID first (needed for relations)
    const { data: empRecord, error: findError } = await supabase
      .from('employees')
      .select('employee_id, cluster_id, role_id') // minimal
      .eq('empid', empid)
      .single();

    if (findError || !empRecord) return res.status(404).json({ error: "Employee not found" });
    const employee_id = empRecord.employee_id;

    // 2. Prepare Employees Table Update
    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    // Stars
    if (body.stars !== undefined) updates.stars = body.stars;
    // Role
    if (body.role) {
      const rid = await getRoleId(body.role);
      if (rid) updates.role_id = rid;
    }
    // Cluster: Only assume single cluster now
    if (body.cluster) {
      const cid = await getClusterId(body.cluster);
      if (cid) updates.cluster_id = cid;
    }
    // updated_at is triggered by DB trigger

    if (Object.keys(updates).length > 0) {
      await supabase.from('employees').update(updates).eq('employee_id', employee_id);
    }

    // 3. Update Skills
    if (body.current_skills !== undefined) {
      const skillsArr = Array.isArray(body.current_skills) 
          ? body.current_skills 
          : (typeof body.current_skills === 'string' ? JSON.parse(body.current_skills || '[]') : []); 

      // Wipe and replace strategy (simplest for many-to-many)
      await supabase.from('employee_skills').delete().eq('employee_id', employee_id);
      
      for (const skill of skillsArr) {
         if(!skill) continue;
         const skill_id = await getOrInsertSkillId(skill.trim());
         if (skill_id) {
           await supabase.from('employee_skills').insert([{ employee_id, skill_id }]);
         }
      }
    }

    // 4. Update Interests
    if (body.interests !== undefined) {
       const interestArr = Array.isArray(body.interests) 
          ? body.interests 
          : (typeof body.interests === 'string' ? JSON.parse(body.interests || '[]') : []);

       await supabase.from('employee_interests').delete().eq('employee_id', employee_id);
       for (const interest of interestArr) {
         if(!interest) continue;
         const interest_id = await getOrInsertInterestId(interest.trim());
         if (interest_id) {
           await supabase.from('employee_interests').insert([{ employee_id, interest_id }]);
         }
       }
    }

    // 5. Update Projects (Current/Previous)
    if (body.current_project !== undefined || body.previous_projects !== undefined || body.noCurrentProject) {
        // Clear all projects for user
        await supabase.from('employee_projects').delete().eq('employee_id', employee_id);
        
        // Handle Current
        let currProjName = body.current_project;
        if (body.noCurrentProject) currProjName = null;
        
        if (currProjName) {
           const pid = await getOrInsertProjectId(currProjName.trim());
           if (pid) {
              await supabase.from('employee_projects').insert([{ 
                  employee_id, 
                  project_id: pid, 
                  project_type: 'CURRENT',
                  from_date: new Date().toISOString() // Start now?
              }]);
           }
        }

        // Handle Previous
        const prevArr = Array.isArray(body.previous_projects)
           ? body.previous_projects
           : (typeof body.previous_projects === 'string' ? JSON.parse(body.previous_projects || '[]') : []);
           
        for (const proj of prevArr) {
           if(!proj) continue;
           const pid = await getOrInsertProjectId(proj.trim());
           if (pid) {
              await supabase.from('employee_projects').insert([{
                  employee_id,
                  project_id: pid,
                  project_type: 'PREVIOUS'
              }]);
           }
        }
    }

    // 6. Availability Update
    // Always insert new status if provided
    if (body.availability) {
       await supabase.from('availability').insert([{
          employee_id,
          status: body.availability,
          hours_available: body.hours_available || null,
          from_date: body.from_date || null,
          to_date: body.to_date || null
       }]);
    }

    // Return the updated full object
    const { data: freshData } = await supabase.from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        clusters ( cluster_name ),
        employee_skills ( skills ( skill_name ) ),
        employee_interests ( interests ( interest_name ) ),
        employee_projects ( project_type, projects ( project_name ) ),
        availability ( status, hours_available, from_date, to_date, created_at )
      `)
      .eq('employee_id', employee_id)
      .single();
    
    if (freshData) {
        const transformed = transformEmployee(freshData);
        res.json({ success: true, message: "Employee updated", data: transformed });
        
        // Notification
        try {
            sendNotificationToUser(empid, {
               title: "Profile Updated",
               message: "Your profile details have been successfully updated.",
               url: "/profile"
            });
        } catch(e) { console.error("Notification Error:", e); }
    } else {
        res.status(500).json({ error: "Failed to reload data" });
    }

  } catch (err) {
    console.error("Update employee error →", err);
    res.status(500).json({ error: "Supabase update error", details: err.message });
  }
};

// UPDATE STARS ONLY
export const updateEmployeeStars = async (req, res) => {
  const { empid } = req.params;
  const { stars } = req.body;

  if (stars === undefined) {
    return res.status(400).json({ error: "Stars value is required" });
  }

  try {
    const { data, error } = await supabase
      .from('employees')
      .update({ stars })
      .eq('empid', empid)
      .select();

    if (error) throw error;
    res.json({ success: true, message: "Stars updated successfully", data });
  } catch (err) {
    console.error("Star update error →", err);
    res.status(500).json({ error: "Failed to update stars" });
  }
};

// GET DASHBOARD METRICS
export const getDashboardMetrics = async (req, res) => {
  try {
    const { data: employees, error } = await supabase
      .from('employees')
      .select(`
        *,
        roles ( role_name ),
        clusters ( cluster_name ),
        availability ( status, hours_available, created_at )
      `);

    if (error) throw error;

    // Use Transformer to get simplified objects
    const simplified = employees.map(transformEmployee); 
    
    // Calculate Metrics
    const metrics = {
      partialHoursDistribution: {},
      clusters: { "MEBM": 0, "M&T": 0, "S&PS Insitu": 0, "S&PS Exsitu": 0 },
      roles: {},
      totalPartialHours: 0,
      totalAvailableHours: 0,
      partialEmployeeCount: 0,
      availableEmployeeCount: 0
    };
    
    // Use multiplier=1 for now, as logic was complexity in previous version and is range dependent.
    // If strict range logic is needed, it should be re-implemented. 
    // Assuming for now simple aggregation.
    const multiplier = 1; 

    simplified.forEach(emp => {
       // Roles
       const r = emp.role;
       if (r) metrics.roles[r] = (metrics.roles[r] || 0) + 1;
       
       // Clusters
       const c = emp.cluster;
       // Add to clusters map if known, else dynamic
       if (metrics.clusters.hasOwnProperty(c)) metrics.clusters[c]++;
       else if (c) metrics.clusters[c] = (metrics.clusters[c] || 0) + 1;

       // Availability
       if (emp.availability === 'Partially Available') {
          // Hours distribution
          if (emp.hours_available) {
             const label = String(emp.hours_available);
             metrics.partialHoursDistribution[label] = (metrics.partialHoursDistribution[label] || 0) + 1;
             
             metrics.totalPartialHours += (emp.hours_available * multiplier);
             metrics.partialEmployeeCount++;
          }
       } else if (emp.availability === 'Available') {
          metrics.totalAvailableHours += (8 * multiplier);
          metrics.availableEmployeeCount++;
       }
    });

    res.json(metrics);

  } catch (err) {
    console.error("Dashboard metrics error →", err);
    res.status(500).json({ error: "Failed to fetch dashboard metrics" });
  }
};
