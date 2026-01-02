import express from 'express';
import cron from 'node-cron';
import path from 'path';
import { runSync, getSyncStatus } from './src/server/syncService.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config(); 

// Helper to get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the Vite build output
app.use(express.static(path.join(__dirname, 'dist')));

// API Endpoint to manually trigger sync
app.post('/api/sync', async (req, res) => {
    console.log("Manual sync triggered via API.");
    try {
        // Run sync asynchronously and return immediate status
        runSync(); 
        res.json({ 
            message: "Sync process started successfully. Check logs for details.",
            status: getSyncStatus()
        });
    } catch (error) {
        console.error("Error starting manual sync:", error.message);
        res.status(500).json({ error: "Failed to start sync process." });
    }
});

// API Endpoint to get current sync status
app.get('/api/status', (req, res) => {
    res.json(getSyncStatus());
});

// Catch-all route to serve the React app for client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- Cron Job Scheduler ---
// Runs the sync logic every 30 minutes
cron.schedule('*/30 * * * *', () => {
    console.log('--- CRON JOB: Starting scheduled Zoho Sync ---');
    runSync();
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Scheduled sync job started (runs every 30 minutes).');
    
    // Initial run on startup
    console.log('--- Initial Sync Run ---');
    runSync();
});