import supabase from "../db/supabaseClient.js";
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
  try {
    // 1. Fetch basic info, roles, and availability
    const { data: employees, error } = await supabase
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
    const { data: ecData } = await supabase
      .from('employee_clusters')
      .select('employee_id, clusters(cluster_name)')
      .in('employee_id', empIds);
    
    // 3. Batch fetch skills
    const { data: esData } = await supabase
      .from('employee_skills')
      .select('employee_id, skills(skill_name)')
      .in('employee_id', empIds);

    // 4. Batch fetch stars (latest)
    const { data: starsData } = await supabase
      .from('employee_stars')
      .select('employee_id, stars, created_at')
      .in('employee_id', empIds)
      .order('created_at', { ascending: false });

    // 5. Batch fetch working days
    const { data: ewdData } = await supabase
      .from('employee_working_days')
      .select('employee_id, working_days(day_name)')
      .in('employee_id', empIds);

    // 6. Batch fetch project memberships
    const { data: pmData } = await supabase
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

    // Return the updated full object
    const { data: freshData } = await supabase.from('employees')
      .select(`
        *,
        roles ( role_name, role_type ),
        employee_clusters ( clusters ( cluster_name ) ),
        employee_skills ( skills ( skill_name ) ),
        project_members ( member_role, projects ( project_name ) ),
        availability_details ( availability, hours_available, from_date, to_date ),
        employee_stars ( stars, created_at ),
        employee_working_days ( working_days ( day_name ) )
      `)
      .eq('employee_id', employee_id)
      .order('created_at', { foreignTable: 'employee_stars', ascending: false })
      .single();
    
    if (freshData) {
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
    const { data: employees, error } = await supabase
      .from('employees')
      .select(`
        *,
        roles ( role_name ),
        employee_clusters ( clusters ( cluster_name ) ),
        availability_details ( availability, hours_available )
      `);

    if (error) throw error;

    const metrics = {
      partialHoursDistribution: {},
      clusters: { "MEBM": 0, "M&T": 0, "S&PS Insitu": 0, "S&PS Exsitu": 0 },
      roles: {},
      totalPartialHours: 0,
      totalAvailableHours: 0,
      partialEmployeeCount: 0,
      availableEmployeeCount: 0
    };

    employees.forEach(emp => {
       const r = emp.roles?.role_name;
       if (r) metrics.roles[r] = (metrics.roles[r] || 0) + 1;
       
       const clusters = emp.employee_clusters?.map(ec => ec.clusters?.cluster_name) || [];
       clusters.forEach(c => {
         if (metrics.clusters.hasOwnProperty(c)) metrics.clusters[c]++;
         else if (c) metrics.clusters[c] = (metrics.clusters[c] || 0) + 1;
       });

       const avail = emp.availability;
       if (avail === 'Partially Available') {
          const det = emp.availability_details?.[0];
          if (det && det.hours_available) {
             const label = String(det.hours_available);
             metrics.partialHoursDistribution[label] = (metrics.partialHoursDistribution[label] || 0) + 1;
             metrics.totalPartialHours += det.hours_available;
             metrics.partialEmployeeCount++;
          }
       } else if (avail === 'Available') {
          metrics.totalAvailableHours += 8;
          metrics.availableEmployeeCount++;
       }
    });

    res.json(metrics);
  } catch (err) {
    console.error("Dashboard metrics error →", err);
    res.status(500).json({ error: "Failed to fetch dashboard metrics" });
  }
};
