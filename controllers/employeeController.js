import supabase, { supabaseAdmin } from "../db/supabaseClient.js";
import { sendNotificationToUser } from "./notificationController.js";

/**
 * Helpers for Normalized DB
 */

const getRoleId = async (roleName) => {
  if (!roleName) return null;
  const { data } = await supabase.from('roles').select('id').eq('role_name', roleName).single();
  return data ? data.id : null;
};

const getClusterId = async (clusterName) => {
  if (!clusterName) return null;
  const { data } = await supabase.from('clusters').select('id').eq('cluster_name', clusterName).single();
  return data ? data.id : null; 
};

const getOrInsertSkillId = async (skillName) => {
  if (!skillName) return null;
  const { data } = await supabase.from('skills').select('id').eq('skill_name', skillName).single();
  if (data) return data.id;
  const { data: newData } = await supabase.from('skills').insert([{ skill_name: skillName }]).select('id').single();
  return newData ? newData.id : null;
};

// interests are merged into skills in new schema logic
const getOrInsertProjectId = async (projectName) => {
  if (!projectName) return null;
  const { data } = await supabase.from('projects').select('project_id').eq('project_name', projectName).single();
  if (data) return data.project_id;
  // This might need more fields based on schema, but for simple mapping:
  const { data: newData } = await supabase.from('projects').insert([{ project_name: projectName, manager_id: 0, status: 'Open' }]).select('project_id').single();
  return newData ? newData.project_id : null;
};

// Data Transformer: DB Normalized -> Frontend JSON
const transformEmployee = (emp) => {
  // Clusters
  const clusters = emp.employee_clusters ? emp.employee_clusters.map(ec => ec.clusters?.cluster_name).filter(Boolean) : [];
  
  // Skills (Technical Interests are now Skills)
  const skills = emp.employee_skills ? emp.employee_skills.map(es => es.skills?.skill_name).filter(Boolean) : [];
  
  // Availability Details
  const avail = emp.availability_details?.[0] || {};

  // Projects - Current from project_members or projects joined
  // Note: projects.manager_id is also a thing.
  // We'll simplify for frontend: return projects where member_role is 'Employee' or POC
  const projectMemberships = emp.project_members || [];
  const currentProject = projectMemberships.length > 0 ? projectMemberships[0].projects?.project_name : "";

  return {
    employee_id: emp.employee_id,
    name: emp.name,
    email: emp.email,
    role: emp.roles?.role_name || "Software Developer",
    role_type: emp.roles?.role_type || "IC", 
    clusters: clusters,
    cluster: clusters[0] || "", // legacy support
    cluster2: clusters[1] || "", // legacy support
    
    // Stars: latest from employee_stars table
    stars: emp.employee_stars?.length > 0 ? emp.employee_stars[0].stars : 0, 
    
    // Working Days
    working_days: emp.employee_working_days ? emp.employee_working_days.map(ewd => ewd.working_days?.day_name).filter(Boolean) : [],
    
    current_skills: skills,
    interests: [], // Deprecated
    current_project: currentProject,
    previous_projects: [], // Would need history table
    
    availability: emp.availability || "Occupied",
    hours_available: avail.hours_available || null,
    from_date: avail.from_date || null,
    to_date: avail.to_date || null,
    
    updated_at: emp.updated_at
  };
};

/**
 * REST Controllers
 */

// GET ALL
export const getAllEmployees = async (req, res) => {
  const { search = "", availability = "" } = req.query;
  const client = supabaseAdmin || supabase;
  
  try {
    // 1. Fetch basic info, roles, and availability
    const { data: employees, error } = await client
      .from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        availability_details ( availability, hours_available, from_date, to_date )
      `)
      .order('employee_id', { ascending: true });

    if (error) throw error;
    if (!employees) return res.json([]);

    const empIds = employees.map(e => e.employee_id);

    // 2. Batch fetch clusters
    const { data: ecData } = await client
      .from('employee_clusters')
      .select('employee_id, clusters(cluster_name)')
      .in('employee_id', empIds);
    
    // 3. Batch fetch skills
    const { data: esData } = await client
      .from('employee_skills')
      .select('employee_id, skills(skill_name)')
      .in('employee_id', empIds);

    // 4. Batch fetch stars (latest)
    const { data: starsData } = await client
      .from('employee_stars')
      .select('employee_id, stars, created_at')
      .in('employee_id', empIds)
      .order('created_at', { ascending: false });

    // 5. Batch fetch working days
    const { data: ewdData } = await client
      .from('employee_working_days')
      .select('employee_id, working_days(day_name)')
      .in('employee_id', empIds);

    // 6. Batch fetch project memberships
    const { data: pmData } = await client
      .from('project_members')
      .select('employee_id, member_role, projects(project_name)')
      .in('employee_id', empIds);

    // Manually merge data
    const enriched = employees.map(emp => {
      const id = emp.employee_id;
      return {
        ...emp,
        employee_clusters: ecData?.filter(x => x.employee_id === id) || [],
        employee_skills: esData?.filter(x => x.employee_id === id) || [],
        employee_stars: starsData?.filter(x => x.employee_id === id) || [],
        employee_working_days: ewdData?.filter(x => x.employee_id === id) || [],
        project_members: pmData?.filter(x => x.employee_id === id) || []
      };
    });

    let result = enriched.map(transformEmployee);

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
    res.status(500).json({ error: "Supabase fetch error", details: err.message });
  }
};

// GET by employee_id
export const getEmployeeById = async (req, res) => {
  const { employee_id } = req.params;
  try {
    const { data: emp, error } = await supabase
      .from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        availability_details ( availability, hours_available, from_date, to_date )
      `)
      .eq('employee_id', employee_id)
      .single();

    if (error || !emp) throw error || new Error("Employee not found");

    // Fetch related data
    const id = emp.employee_id;
    const [ec, es, stars, ewd, pm] = await Promise.all([
      supabase.from('employee_clusters').select('clusters(cluster_name)').eq('employee_id', id),
      supabase.from('employee_skills').select('skills(skill_name)').eq('employee_id', id),
      supabase.from('employee_stars').select('stars, created_at').eq('employee_id', id).order('created_at', { ascending: false }),
      supabase.from('employee_working_days').select('working_days(day_name)').eq('employee_id', id),
      supabase.from('project_members').select('member_role, projects(project_name)').eq('employee_id', id)
    ]);

    const enriched = {
      ...emp,
      employee_clusters: ec.data || [],
      employee_skills: es.data || [],
      employee_stars: stars.data || [],
      employee_working_days: ewd.data || [],
      project_members: pm.data || []
    };

    res.json(transformEmployee(enriched));

  } catch (err) {
    console.error(`Fetch employee error →`, err);
    res.status(500).json({ error: "Supabase fetch error", details: err.message });
  }
};

// UPDATE
export const updateEmployee = async (req, res) => {
  const { employee_id } = req.params;
  const body = req.body;
  
  try {
    // 1. Check existence
    const { data: empRecord, error: findError } = await supabase
      .from('employees')
      .select('employee_id')
      .eq('employee_id', employee_id)
      .single();

    if (findError || !empRecord) return res.status(404).json({ error: "Employee not found" });

    // 2. Prepare Employees Table Update
    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.role) {
      const rid = await getRoleId(body.role);
      if (rid) updates.role_id = rid;
    }
    if (body.availability) {
      updates.availability = body.availability;
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from('employees').update(updates).eq('employee_id', employee_id);
    }

    // 3. Update Clusters (Many-to-Many, Max 2)
    if (body.clusters !== undefined || body.cluster || body.cluster2) {
      const clusterNames = Array.isArray(body.clusters) ? body.clusters : [body.cluster, body.cluster2].filter(Boolean);
      const finalClusters = [...new Set(clusterNames)].slice(0, 2);

      await supabase.from('employee_clusters').delete().eq('employee_id', employee_id);
      for (const cName of finalClusters) {
        const cid = await getClusterId(cName);
        if (cid) {
          await supabase.from('employee_clusters').insert([{ employee_id, cluster_id: cid }]);
        }
      }
    }

    // 4. Update Skills
    if (body.current_skills !== undefined) {
      const skillsArr = Array.isArray(body.current_skills) ? body.current_skills : [];
      await supabase.from('employee_skills').delete().eq('employee_id', employee_id);
      for (const skill of skillsArr) {
         if(!skill) continue;
         const skill_id = await getOrInsertSkillId(skill.trim());
         if (skill_id) {
           await supabase.from('employee_skills').insert([{ employee_id, skill_id }]);
         }
      }
    }

    // 5. Update Working Days
    if (body.working_days !== undefined) {
      const days = Array.isArray(body.working_days) ? body.working_days : [];
      await supabase.from('employee_working_days').delete().eq('employee_id', employee_id);
      for (const dName of days) {
        const { data: dData } = await supabase.from('working_days').select('id').eq('day_name', dName).single();
        if (dData) {
          await supabase.from('employee_working_days').insert([{ employee_id, day_id: dData.id }]);
        }
      }
    }

    // 6. Availability Details Sync
    if (body.availability) {
       const availUpdate = {
          availability: body.availability,
          hours_available: body.availability === 'Partially Available' ? (body.hours_available || null) : null,
          from_date: body.availability === 'Partially Available' ? (body.from_date || null) : null,
          to_date: body.availability === 'Partially Available' ? (body.to_date || null) : null,
          updated_at: new Date().toISOString()
       };

       const { data: existingAvail } = await supabase.from('availability_details').select('id').eq('employee_id', employee_id).single();
       if (existingAvail) {
          await supabase.from('availability_details').update(availUpdate).eq('employee_id', employee_id);
       } else {
          await supabase.from('availability_details').insert([{ employee_id, ...availUpdate }]);
       }
    }

    // Return the updated full object (Sequential Fetch)
    const { data: freshEmp } = await supabase.from('employees')
      .select('*, availability_details(availability, hours_available, from_date, to_date)')
      .eq('employee_id', employee_id)
      .single();

    if (freshEmp) {
      // Fetch related data manually
      const [ec, es, stars, ewd, pm, roleData] = await Promise.all([
         supabase.from('employee_clusters').select('clusters(cluster_name)').eq('employee_id', employee_id),
         supabase.from('employee_skills').select('skills(skill_name)').eq('employee_id', employee_id),
         supabase.from('employee_stars').select('stars').eq('employee_id', employee_id).order('created_at', { ascending: false }),
         supabase.from('employee_working_days').select('working_days(day_name)').eq('employee_id', employee_id),
         supabase.from('project_members').select('member_role, projects(project_name)').eq('employee_id', employee_id),
         freshEmp.role_id ? supabase.from('roles').select('role_name, role_type').eq('id', freshEmp.role_id).single() : { data: null }
      ]);

      const freshData = {
          ...freshEmp,
          employee_clusters: ec.data || [],
          employee_skills: es.data || [],
          employee_stars: stars.data || [],
          employee_working_days: ewd.data || [],
          project_members: pm.data || [],
          roles: roleData.data || null
      };
    
      const transformed = transformEmployee(freshData);
      res.json({ success: true, message: "Employee updated", data: transformed });
      
      try {
          sendNotificationToUser(employee_id, {
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

// UPDATE STARS (via employee_stars table)
export const updateEmployeeStars = async (req, res) => {
  const { employee_id } = req.params;
  const { stars, given_by } = req.body;

  if (stars === undefined) return res.status(400).json({ error: "Stars value is required" });

  try {
    const { data, error } = await supabase
      .from('employee_stars')
      .insert([{ employee_id, stars, given_by }])
      .select();

    if (error) throw error;
    res.json({ success: true, message: "Stars recorded successfully", data });
  } catch (err) {
    console.error("Star update error →", err);
    res.status(500).json({ error: "Failed to record stars" });
  }
};

// GET DASHBOARD METRICS
export const getDashboardMetrics = async (req, res) => {
  try {
    const { range = 'All' } = req.query;

    // 1. Fetch employees (Use Admin Client if available to bypass RLS for aggregate stats)
    const client = supabaseAdmin || supabase;
    
    // Check if client is null (if key not in env and admin var is null)
    if (!client) throw new Error("Supabase client not initialized");

    const { data: employees, error } = await client
      .from('employees')
      .select(`
        *,
        availability_details ( availability, hours_available, from_date, to_date )
      `);

    if (error) throw error;
    if (!employees) return res.json({});

    const empIds = employees.map(e => e.employee_id);

    // 2. Fetch Roles
    const roleIds = [...new Set(employees.map(e => e.role_id).filter(Boolean))];
    const { data: allRoles } = await client.from('roles').select('id, role_name, role_type').in('id', roleIds);

    // 3. Fetch Clusters
    const { data: allClusters } = await client
       .from('employee_clusters')
       .select('employee_id, clusters(cluster_name)')
       .in('employee_id', empIds);

    // Merge in memory
    const enrichedEmps = employees.map(emp => {
       const role = allRoles?.find(r => r.id === emp.role_id);
       const clusters = allClusters?.filter(c => c.employee_id === emp.employee_id);
       return {
          ...emp,
          roles: role,
          employee_clusters: clusters
       };
    });
    
    const empsToProcess = enrichedEmps;

    // 4. Fetch Projects for Stats
    const { data: allProjects } = await client
       .from('projects')
       .select('status');

    let openProjects = 0;
    let ongoingProjects = 0;
    
    if (allProjects) {
        allProjects.forEach(p => {
             const s = (p.status || "").trim().toLowerCase();
             if (s === 'open') openProjects++;
             if (s === 'ongoing') ongoingProjects++;
        });
    }

    const metrics = {
      partialHoursDistribution: {},
      clusters: { "MEBM": 0, "M&T": 0, "S&PS Insitu": 0, "S&PS Exsitu": 0 },
      roles: {},
      totalPeople: 0,
      openProjectsCount: openProjects,
      ongoingProjectsCount: ongoingProjects,
      totalPartialHours: 0,
      totalAvailableHours: 0,
      partialEmployeeCount: 0,
      availableEmployeeCount: 0,
      occupiedEmployeeCount: 0
    };

    // --- Date Logic ---
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let calcStart = new Date(today);
    let calcEnd = null;

    if (range === 'Daily') {
        calcEnd = new Date(today);
        calcEnd.setHours(23, 59, 59, 999);
    } else if (range === 'Weekly') {
        // End of current week (Sunday)
        const day = today.getDay(); // 0 is Sun
        const diff = 7 - day; // Days remaining till next Sunday (if today is Sun, diff=7? No, today.getDate() + (7-day))
        // Actually, if today is Sunday (0), end is today. If today is Mon(1), end is +6.
        // Let's standardise: Week ends on SUNDAY.
        // If today is Sunday(0), we want today.
        const d = new Date(today);
        d.setDate(today.getDate() + (day === 0 ? 0 : 7 - day)); 
        d.setHours(23, 59, 59, 999);
        calcEnd = d;
    } else if (range === 'Monthly') {
        // Last day of current month
        const d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        d.setHours(23, 59, 59, 999);
        calcEnd = d;
    } else {
        // 'All' or others: Default to just today's snapshot x 1 day? 
        // Or specific requirements? 
        // User didn't specify 'All', but logic implies 'All' usually shows total capacity/snapshot.
        // We'll treat 'All' as a single day snapshot for consistency with previous logic, 
        // OR distinct logic. Let's make 'All' behave like 'Daily' but maybe we don't multiply by duration? 
        // Existing logic was just summing hours.
        // Lets treat 'All' as 'Daily' (Snapshot) effectively.
        calcEnd = new Date(today);
        calcEnd.setHours(23, 59, 59, 999);
    }

    const countWorkingDays = (d1, d2) => {
        if (d2 < d1) return 0;
        let count = 0;
        let current = new Date(d1);
        while (current <= d2) {
            const day = current.getDay();
            if (day !== 0 && day !== 6) { // Not Sun(0) or Sat(6)
                count++;
            }
            current.setDate(current.getDate() + 1);
        }
        return count;
    };

    empsToProcess.forEach(emp => {
       let r = emp.roles?.role_name;
       
       // Terminology Updates
       if (r === 'Head of Bluebird') r = 'Organization Head';
       if (r === 'Mission Leader' || r === 'Leader') r = 'Project Leader';

       if (r) metrics.roles[r] = (metrics.roles[r] || 0) + 1;
       
       const clusters = emp.employee_clusters?.map(ec => ec.clusters?.cluster_name) || [];
       clusters.forEach(c => {
         if (metrics.clusters.hasOwnProperty(c)) metrics.clusters[c]++;
         else if (c) metrics.clusters[c] = (metrics.clusters[c] || 0) + 1;
       });

       // EXCLUDE MANAGERS
       const roleName = (r || "").trim().toLowerCase();
       const roleType = (emp.roles?.role_type || "").trim().toLowerCase();

       if (roleName === 'manager' || roleType === 'manager') return;

       const availRaw = emp.availability || "";
       const avail = availRaw.trim().toLowerCase();

       if (avail === 'partially available') {
          metrics.partialEmployeeCount++;
          
          const det = emp.availability_details?.[0];
          // Determine generic hours if missing
          const dailyHours = (det && det.hours_available) ? det.hours_available : 0; 
          
          // Calculate valid intersection
          // Emp Range: from_date -> to_date
          // Filter Range: calcStart -> calcEnd
          let eStart = (det && det.from_date) ? new Date(det.from_date) : new Date(today); // Default to today if missing
          let eEnd = (det && det.to_date) ? new Date(det.to_date) : new Date(calcEnd); // Default to end of range if missing

          // Standardize
          if(eStart < today) eStart = new Date(today);
          
          // Intersection
          const start = eStart > calcStart ? eStart : calcStart;
          const end = eEnd < calcEnd ? eEnd : calcEnd;

          const days = countWorkingDays(start, end);
          
          if(dailyHours > 0 && days > 0) {
              const label = String(dailyHours);
              metrics.partialHoursDistribution[label] = (metrics.partialHoursDistribution[label] || 0) + 1;
              metrics.totalPartialHours += (days * dailyHours);
          }

       } else if (avail === 'available') {
          metrics.availableEmployeeCount++;
          const det = emp.availability_details?.[0];

          // Same logic for Available? Usually "Available" implies 8h/day unless details say otherwise
          // Usually "Available" doesn't have from/to dates in this system (implied indefinite).
          // But if they DO have dates, respect them.
          
          let eStart = (det && det.from_date) ? new Date(det.from_date) : new Date(today);
          let eEnd = (det && det.to_date) ? new Date(det.to_date) : new Date(calcEnd); // Indefinite -> till end of range

          if(eStart < today) eStart = new Date(today);

          const start = eStart > calcStart ? eStart : calcStart;
          const end = eEnd < calcEnd ? eEnd : calcEnd;

          const days = countWorkingDays(start, end);
          metrics.totalAvailableHours += (days * 8);

       } else {
          metrics.occupiedEmployeeCount++;
       }
    });

    metrics.totalPeople = metrics.availableEmployeeCount + metrics.partialEmployeeCount + metrics.occupiedEmployeeCount;

    res.json(metrics);
  } catch (err) {
    console.error("Dashboard metrics error →", err);
    res.status(500).json({ error: "Failed to fetch dashboard metrics" });
  }
};
