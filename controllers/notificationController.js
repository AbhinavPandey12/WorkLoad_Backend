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
    const { subscription, employee_id } = req.body;

    if (!subscription || !employee_id) {
        return res.status(400).json({ error: "Subscription and employee_id required" });
    }

    try {
        // 1. Check if subscription already exists for this user
        const { data: existing, error: fetchError } = await supabase
            .from('push_notifications')
            .select('id')
            .eq('employee_id', employee_id)
            .eq('endpoint', subscription.endpoint)
            .maybeSingle();

        if (fetchError) throw fetchError;

        if (!existing) {
            // 2. Insert new record
            const { error: insertError } = await supabase
                .from('push_notifications')
                .insert([{
                    employee_id,
                    endpoint: subscription.endpoint,
                    p256dh: subscription.keys?.p256dh,
                    auth: subscription.keys?.auth
                }]);

            if (insertError) throw insertError;
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
export const sendNotificationToUser = async (employee_id, payload) => {
    try {
        // Default Icon
        if (!payload.icon) payload.icon = '/Logo/Workload.png';
        if (!payload.image) payload.image = '/Logo/Workload.png';

        // 1. Fetch user subscriptions from separate table
        const { data: subs, error } = await supabase
            .from('push_notifications')
            .select('endpoint, p256dh, auth')
            .eq('employee_id', employee_id);

        if (error || !subs || subs.length === 0) return;

        // 2. Send to all subscriptions
        const notifications = (subs || []).filter(Boolean).map(subRecord => {
            const pushSubscription = {
                endpoint: subRecord.endpoint,
                keys: {
                    p256dh: subRecord.p256dh,
                    auth: subRecord.auth
                }
            };
            return webpush.sendNotification(pushSubscription, JSON.stringify(payload))
                .catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        // Subscription expired, could remove it here but complex async
                        // console.log(`Subscription expired for ${employee_id}`);
                    } else {
                        console.error('Push Error:', err);
                    }
                });
        });

        await Promise.all(notifications);
        // console.log(`Notification sent to ${employee_id}`);

    } catch (err) {
        console.error(`Failed to send notification to ${employee_id}:`, err);
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

        // 1. Fetch all employees to satisfy role filter
        let query = supabase.from('employees').select('employee_id, role_type');
        if (roleType) {
            query = query.neq('role_type', 'Manager');
        }
        const { data: employees, error: empError } = await query;
        if (empError) throw empError;

        const employeeIds = employees.map(e => e.employee_id);

        // 2. Fetch all subscriptions for these employees
        const { data: allSubs, error: subError } = await supabase
            .from('push_notifications')
            .select('endpoint, p256dh, auth, employee_id')
            .in('employee_id', employeeIds);

        if (subError) throw subError;

        const promises = (allSubs || []).map(subRecord => {
            const pushSubscription = {
                endpoint: subRecord.endpoint,
                keys: {
                    p256dh: subRecord.p256dh,
                    auth: subRecord.auth
                }
            };
            return webpush.sendNotification(pushSubscription, JSON.stringify(payload))
                .catch(e => console.error(`Broadcast item error for emp ${subRecord.employee_id}:`, e.message));
        });

        await Promise.all(promises);
        // console.log(`Broadcast sent to ${employees.length} employees`);

    } catch (err) {
        console.error("Broadcast error:", err);
    }
};
