import webpush from 'web-push';
import supabase from '../db/supabaseClient.js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Web Push
// It's better to do this in index.js, but we can do it here if imported.
// We'll export a setup function or just rely on env vars being set when this module loads.

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_MAILTO } = process.env;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("VAPID Keys missing in environment variables");
} else {
    webpush.setVapidDetails(
        VAPID_MAILTO || 'mailto:test@example.com',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

// ----------------------
// SUBSCRIBE ENDPOINT
// ----------------------
export const subscribe = async (req, res) => {
    const { subscription, empid } = req.body;

    if (!subscription || !empid) {
        return res.status(400).json({ error: "Subscription and empid required" });
    }

    try {
        // 1. Get current subscriptions for user
        const { data: user, error: fetchError } = await supabase
            .from('employees')
            .select('push_subscriptions')
            .eq('empid', empid)
            .single();

        if (fetchError) throw fetchError;

        let subscriptions = [];
        if (user && user.push_subscriptions) {
            // Handle JSONB or Text
            if (typeof user.push_subscriptions === 'string') {
                try {
                    subscriptions = JSON.parse(user.push_subscriptions);
                } catch (e) {
                    subscriptions = [];
                }
            } else if (Array.isArray(user.push_subscriptions)) {
                subscriptions = user.push_subscriptions;
            }
        }

        // 2. Add new subscription if not exists (check endpoint)
        const exists = subscriptions.some(s => s.endpoint === subscription.endpoint);
        if (!exists) {
            subscriptions.push(subscription);

            // 3. Update DB
            const { error: updateError } = await supabase
                .from('employees')
                .update({ push_subscriptions: subscriptions }) // Supabase handles array->jsonb
                .eq('empid', empid);

            if (updateError) throw updateError;
        }

        res.status(201).json({ success: true, message: "Subscribed successfully" });

    } catch (err) {
        console.error("Subscription error:", err);
        res.status(500).json({ error: "Failed to save subscription" });
    }
};

// ----------------------
// SEND NOTIFICATION HELPER (Internal)
// ----------------------
export const sendNotificationToUser = async (empid, payload) => {
    try {
        // Default Icon
        if (!payload.icon) payload.icon = '/Logo/Workload.png';
        if (!payload.image) payload.image = '/Logo/Workload.png'; // Show vivid logo as main image

        // 1. Fetch user subscriptions
        const { data: user, error } = await supabase
            .from('employees')
            .select('push_subscriptions')
            .eq('empid', empid)
            .single();

        if (error || !user || !user.push_subscriptions) return;

        let subscriptions = [];
        if (typeof user.push_subscriptions === 'string') {
            try { subscriptions = JSON.parse(user.push_subscriptions); } catch (e) { }
        } else {
            subscriptions = user.push_subscriptions;
        }

        if (!Array.isArray(subscriptions) || subscriptions.length === 0) return;

        // 2. Send to all subscriptions
        const notifications = subscriptions.map(sub => {
            return webpush.sendNotification(sub, JSON.stringify(payload))
                .catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        // Subscription expired, could remove it here but complex async
                        // console.log(`Subscription expired for ${empid}`);
                    } else {
                        console.error('Push Error:', err);
                    }
                });
        });

        await Promise.all(notifications);
        // console.log(`Notification sent to ${empid}`);

    } catch (err) {
        console.error(`Failed to send notification to ${empid}:`, err);
    }
};

// ----------------------
// BROADCAST TO ROLE (Internal)
// ----------------------
export const broadcastNotification = async (roleType, payload) => {
    try {
        // Default Icon
        if (!payload.icon) payload.icon = '/Logo/Workload.png';
        if (!payload.image) payload.image = '/Logo/Workload.png';

        // Fetch all users with role_type (case insensitive ideally, or just exact)
        // Assuming role_type is what distinguishes IC vs Manager. 
        // Or check `role` field.
        // User request: "all the IC should receive a notification"

        // Let's filter by role_type != 'Manager' or role_type = 'IC'? 
        // Let's assume anyone NOT a manager is an IC for safety, or check logic.
        // Better: Fetch all, filter in memory or DB.

        let query = supabase.from('employees').select('empid, push_subscriptions, role_type');

        if (roleType) {
            // This might need adjustment based on exact role strings
            query = query.neq('role_type', 'Manager'); // Broadcast to non-managers (ICs)
        }

        const { data: employees, error } = await query;

        if (error) throw error;

        const promises = employees.map(emp => {
            // Reuse logic or just manual send
            if (!emp.push_subscriptions) return Promise.resolve();

            let subs = emp.push_subscriptions;
            if (typeof subs === 'string') {
                try { subs = JSON.parse(subs); } catch { return Promise.resolve(); }
            }
            if (!Array.isArray(subs)) return Promise.resolve();

            return Promise.all(subs.map(sub =>
                webpush.sendNotification(sub, JSON.stringify(payload)).catch(e => console.error(e.message))
            ));
        });

        await Promise.all(promises);
        // console.log(`Broadcast sent to ${employees.length} employees`);

    } catch (err) {
        console.error("Broadcast error:", err);
    }
};
