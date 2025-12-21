import cron from 'node-cron';
import supabase from './db/supabaseClient.js';
import { sendNotificationToUser } from './controllers/notificationController.js';

const startScheduler = () => {
    console.log("Starting Inactivity Scheduler...");

    // Run every day at 10:00 AM
    cron.schedule('0 10 * * *', async () => {
        // console.log("Running Inactivity Check...");
        try {
            const fifteenDaysAgo = new Date();
            fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
            const cutoff = fifteenDaysAgo.toISOString();

            // Fetch users with:
            // 1. Role is NOT Manager
            // 2. updated_at < 15 days ago
            
            // Supabase Select with Join
            const { data: employees, error } = await supabase
                .from('employees')
                .select(`
                    empid, 
                    name, 
                    updated_at, 
                    roles ( role_name )
                `)
                .lt('updated_at', cutoff); // updated_at is older than cutoff

            if (error) throw error;

            let count = 0;
            for (const emp of employees) {
                const roleName = emp.roles ? emp.roles.role_name : "";

                // Exclude Managers
                if (roleName === "Manager") continue;

                // Send Notification
                sendNotificationToUser(emp.empid, {
                    title: "Update Your Details",
                    message: "It's been 15 days since your last update! Please update your Skills and Availability in the Details screen.",
                    url: "/details",
                    icon: '/Logo/Workload.png',
                    image: '/Logo/Workload.png'
                });
                count++;
            }
            // console.log(`Inactivity Check Complete. Sent ${count} notifications.`);

        } catch (err) {
            console.error("Scheduler Error:", err);
        }
    });
};

export default startScheduler;
