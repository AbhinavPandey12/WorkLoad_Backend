import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import employeeRoutes from './routes/employeeRoutes.js';
import authRoutes from './routes/authRoutes.js';
import projectRoutes from './routes/projectRoutes.js';

dotenv.config();

const app = express();

// -----------------------------
// Middleware
// -----------------------------
app.use(cors({
    origin: (origin, callback) => {
        // Allow local development
        if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
            return callback(null, true);
        }
        // Allow any Vercel deployment
        if (origin.endsWith('.vercel.app')) {
            return callback(null, true);
        }
        // Specific allowing if needed, but the above covers most cases
        callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    credentials: true
}));

app.use(express.json());



// -----------------------------
// Backend Health Check
// -----------------------------
app.get('/', (req, res) => {
    res.send('Backend is running');
});

// -----------------------------
// App Routes
// -----------------------------
app.use('/api/employees', employeeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);

// -----------------------------
// Notification Routes
// -----------------------------
import { subscribe } from './controllers/notificationController.js';
app.post('/api/notifications/subscribe', subscribe);

// 404 Handler
app.use((req, res) => {

    res.status(404).send('Route not found');
});

// -----------------------------
// Start Server
// -----------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () =>
    console.log(`Backend running on port ${PORT}`)
);

// Start Scheduler
import startScheduler from './utils/scheduler.js';
startScheduler();

// Health Check
app.get("/health", (req, res) => res.json({ status: "ok" }));

export default app;
