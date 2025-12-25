import supabase from '../db/supabaseClient.js';
import { broadcastNotification } from './notificationController.js';

// Get all projects with Manager Name, Members, and Skills
export const getProjects = async (req, res) => {
    try {
        // 1. Fetch raw projects
        const { data: projects, error } = await supabase
            .from('projects')
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) throw error;
        if (!projects || projects.length === 0) return res.status(200).json([]);

        const projectIds = projects.map(p => p.project_id);
        const managerIds = [...new Set(projects.map(p => p.manager_id).filter(Boolean))];

        // 2. Fetch managers
        const { data: managers } = await supabase
            .from('employees')
            .select('employee_id, name')
            .in('employee_id', managerIds);

        // 3. Fetch members
        const { data: members } = await supabase
            .from('project_members')
            .select('project_id, employee_id, member_role, employees(name)')
            .in('project_id', projectIds);

        // 4. Fetch Skills
        const { data: skillsData } = await supabase
            .from('project_required_skills')
            .select('project_id, skills(skill_name)')
            .in('project_id', projectIds);

        // 5. Enrich data
        const enrichedData = projects.map(p => {
            const manager = managers?.find(m => m.employee_id === p.manager_id);
            const pMembers = members?.filter(m => m.project_id === p.project_id) || [];
            
            // Extract skills for this project
            const pSkills = skillsData
                ?.filter(s => s.project_id === p.project_id)
                .map(s => s.skills?.skill_name)
                .filter(Boolean) || [];

            // Flatten POCs
            const poc1Member = pMembers.find(m => m.member_role === 'POC1');
            const poc2Member = pMembers.find(m => m.member_role === 'POC2');
            const poc3Member = pMembers.find(m => m.member_role === 'POC3');

            return {
                ...p,
                manager_name: manager?.name || "Unknown",
                required_skills: pSkills, // Add skills here
                poc1: poc1Member?.employees?.name || "",
                poc2: poc2Member?.employees?.name || "",
                poc3: poc3Member?.employees?.name || "",
                members: pMembers.map(m => ({
                    employee_id: m.employee_id,
                    name: m.employees?.name || "Unknown",
                    role: m.member_role
                }))
            };
        });

        res.status(200).json(enrichedData);
    } catch (error) {
        console.error("Get projects error:", error);
        res.status(500).json({ error: error.message });
    }
};

// Create a new project
export const createProject = async (req, res) => {
    try {
        let {
            manager_id,
            project_name,
            required_skills,
            start_date,
            end_date,
            status,
            description,
            employee1_id,
            employee2_id,
            poc1_id,
            poc2_id,
            poc3_id
        } = req.body;

        // Parse skills if string
        if (typeof required_skills === 'string') {
            required_skills = required_skills.split(',').map(s => s.trim()).filter(Boolean);
        }

        // 1. Insert Project
        const { data: project, error: pError } = await supabase
            .from('projects')
            .insert([
                {
                    manager_id,
                    project_name,
                    status: status || 'Open',
                    description,
                    start_date,
                    end_date
                }
            ])
            .select()
            .single();

        if (pError) throw pError;

        // 2. Insert Members (Exactly 2 Employees as per rule + optional POCs)
        const members = [];
        if (employee1_id) members.push({ project_id: project.project_id, employee_id: employee1_id, member_role: 'Employee' });
        if (employee2_id) members.push({ project_id: project.project_id, employee_id: employee2_id, member_role: 'Employee' });
        
        // Use POC ids if provided
        if (poc1_id) members.push({ project_id: project.project_id, employee_id: poc1_id, member_role: 'POC1' });
        if (poc2_id) members.push({ project_id: project.project_id, employee_id: poc2_id, member_role: 'POC2' });
        if (poc3_id) members.push({ project_id: project.project_id, employee_id: poc3_id, member_role: 'POC3' });

        if (members.length > 0) {
            const { error: mError } = await supabase.from('project_members').insert(members);
            if (mError) throw mError;
        }

        // 3. Handle Required Skills
        if (Array.isArray(required_skills)) {
            for (const sName of required_skills) {
                // Upsert skill to ensure it exists
                const { data: sData, error: sError } = await supabase
                    .from('skills')
                    .upsert({ skill_name: sName }, { onConflict: 'skill_name' })
                    .select('id')
                    .single();
                
                if (sData) {
                    await supabase.from('project_required_skills').insert([{ project_id: project.project_id, skill_id: sData.id }]);
                } else if (sError) {
                     console.error("Error upserting skill:", sName, sError);
                     // Fallback check if it exists (race condition or upsert fail)
                     const { data: existing } = await supabase.from('skills').select('id').eq('skill_name', sName).single();
                     if (existing) {
                        await supabase.from('project_required_skills').insert([{ project_id: project.project_id, skill_id: existing.id }]);
                     }
                }
            }
        }

        res.status(201).json(project);

        // Broadcast
        broadcastNotification("IC", {
            title: "New Activity Available",
            message: `A new activity "${project_name}" has been posted.`,
            url: "/inline-activities"
        });
    } catch (error) {
        console.error("Error creating project:", error);
        res.status(500).json({ error: error.message });
    }
};

// Update project status
export const updateProjectStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const { data, error } = await supabase
            .from('projects')
            .update({ status, updated_at: new Date().toISOString() })
            .eq('project_id', id)
            .select();

        if (error) throw error;

        res.status(200).json(data[0]);
    } catch (error) {
        console.error("Error updating project status:", error);
        res.status(500).json({ error: error.message });
    }
};

// Update entire project
export const updateProject = async (req, res) => {
    try {
        const { id } = req.params;
        let {
            manager_id,
            project_name,
            required_skills,
            start_date,
            end_date,
            status,
            description,
            poc1,
            poc2,
            poc3
        } = req.body;

        // Parse skills if string
        if (typeof required_skills === 'string') {
            required_skills = required_skills.split(',').map(s => s.trim()).filter(Boolean);
        }

        const updatePayload = {
            project_name,
            manager_id,
            start_date,
            end_date,
            status,
            description,
            updated_at: new Date().toISOString()
        }

        const { data, error } = await supabase
            .from('projects')
            .update(updatePayload)
            .eq('project_id', id)
            .select();

        if (error) throw error;

        // Skills update (wipe and replace)
        if (Array.isArray(required_skills)) {
            await supabase.from('project_required_skills').delete().eq('project_id', id);
            for (const sName of required_skills) {
                // Upsert skill to ensure it exists
                const { data: sData, error: sError } = await supabase
                    .from('skills')
                    .upsert({ skill_name: sName }, { onConflict: 'skill_name' })
                    .select('id')
                    .single();

                if (sData) {
                    await supabase.from('project_required_skills').insert([{ project_id: id, skill_id: sData.id }]);
                } else if (sError) {
                     console.error("Error upserting skill:", sName, sError);
                     const { data: existing } = await supabase.from('skills').select('id').eq('skill_name', sName).single();
                     if (existing) {
                        await supabase.from('project_required_skills').insert([{ project_id: id, skill_id: existing.id }]);
                     }
                }
            }
        }

        // Handle POC Updates (Resolve Names to IDs and Update)
        const pocs = [
            { role: 'POC1', name: poc1 },
            { role: 'POC2', name: poc2 },
            { role: 'POC3', name: poc3 }
        ];

        for (const p of pocs) {
            // Always remove existing POC for this role first to keep it clean or replace
            await supabase.from('project_members')
                .delete()
                .eq('project_id', id)
                .eq('member_role', p.role);

            if (p.name && p.name.trim() !== "") {
               // Find Employee ID by Name
               const { data: emp } = await supabase.from('employees')
                   .select('employee_id')
                   .eq('name', p.name.trim()) // Exact match
                   .single();
               
               if (emp) {
                   await supabase.from('project_members').insert([
                       { project_id: id, employee_id: emp.employee_id, member_role: p.role }
                   ]);
               } else {
                   // Optional: Could handle case where POC name doesn't exist (ignore or error?)
                   // proceeding with ignore
               }
            }
        }


        // --- Re-Fetch Enriched Data ---
        // Fetch raw project again (in case updates changed things)
        const { data: updatedProject, error: uError } = await supabase
            .from('projects')
            .select('*')
            .eq('project_id', id)
            .single();
        
        if (uError) throw uError;

        // Fetch Manager
        const { data: manager } = await supabase
            .from('employees')
            .select('employee_id, name')
            .eq('employee_id', updatedProject.manager_id)
            .single();

        // Fetch Members
        const { data: members } = await supabase
            .from('project_members')
            .select('project_id, employee_id, member_role, employees(name)')
            .eq('project_id', id);

        // Fetch Skills
        const { data: skillsData } = await supabase
            .from('project_required_skills')
            .select('project_id, skills(skill_name)')
            .eq('project_id', id);

        // Flatten Skills
        const pSkills = skillsData
            ?.map(s => s.skills?.skill_name)
            .filter(Boolean) || [];

        // Flatten POCs
        const pMembers = members || [];
        const poc1Member = pMembers.find(m => m.member_role === 'POC1');
        const poc2Member = pMembers.find(m => m.member_role === 'POC2');
        const poc3Member = pMembers.find(m => m.member_role === 'POC3');

        const enrichedResponse = {
            ...updatedProject,
            manager_name: manager?.name || "Unknown",
            required_skills: pSkills,
            poc1: poc1Member?.employees?.name || "",
            poc2: poc2Member?.employees?.name || "",
            poc3: poc3Member?.employees?.name || "",
            members: pMembers.map(m => ({
                employee_id: m.employee_id,
                name: m.employees?.name || "Unknown",
                role: m.member_role
            }))
        };

        res.status(200).json(enrichedResponse);
    } catch (error) {
        console.error("Error updating project:", error);
        res.status(500).json({ error: error.message });
    }
};

// Delete project
export const deleteProject = async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate UUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!id || !uuidRegex.test(id)) {
            return res.status(400).json({ error: "Invalid Project ID Format" });
        }

        // Cascading deletes should be handled by DB constraints (project_members, project_required_skills)
        const { error } = await supabase
            .from('projects')
            .delete()
            .eq('project_id', id);

        if (error) throw error;

        res.status(200).json({ message: "Project deleted successfully" });
    } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ error: error.message });
    }
};
