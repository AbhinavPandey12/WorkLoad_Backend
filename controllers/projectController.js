import supabase from '../db/supabaseClient.js';
import { broadcastNotification } from './notificationController.js';

// Get all projects with Manager Name and Members
export const getProjects = async (req, res) => {
    try {
        const { data: projects, error } = await supabase
            .from('projects')
            .select(`
                *,
                manager:employees!projects_manager_id_fkey ( name ),
                project_members ( employee_id, member_role, employees ( name ) )
            `)
            .order('updated_at', { ascending: false });

        if (error) throw error;

        const enrichedData = projects.map(p => ({
            ...p,
            manager_name: p.manager?.name || "Unknown",
            members: p.project_members?.map(m => ({
                employee_id: m.employee_id,
                name: m.employees?.name,
                role: m.member_role
            })) || []
        }));

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
                const { data: sData } = await supabase.from('skills').select('id').eq('skill_name', sName).single();
                if (sData) {
                    await supabase.from('project_required_skills').insert([{ project_id: project.project_id, skill_id: sData.id }]);
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
            description
        } = req.body;

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
                const { data: sData } = await supabase.from('skills').select('id').eq('skill_name', sName).single();
                if (sData) {
                    await supabase.from('project_required_skills').insert([{ project_id: id, skill_id: sData.id }]);
                }
            }
        }

        res.status(200).json(data[0]);
    } catch (error) {
        console.error("Error updating project:", error);
        res.status(500).json({ error: error.message });
    }
};

// Delete project
export const deleteProject = async (req, res) => {
    try {
        const { id } = req.params;
        
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
