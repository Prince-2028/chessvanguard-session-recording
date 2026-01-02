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
const PORT = process.env.PORT || 8080; 

// Middleware to parse JSON bodies
app.use(express.json());

// --- API Endpoints (Must be defined before static serving/catch-all) ---

// API Endpoint to manually trigger sync
app.post('/api/sync', (req, res) => {
    console.log("Manual sync triggered via API.");
    
    // Run sync asynchronously. Errors are handled internally by runSync 
    // and reflected in getSyncStatus(). We do not await it here.
    runSync(); 
    
    // Return immediate status (which might contain the initial configuration error)
    res.json({ 
        message: "Sync process started successfully. Check logs for details.",
        status: getSyncStatus()
    });
});

// API Endpoint to get current sync status
app.get('/api/status', (req, res) => {
    res.json(getSyncStatus());
});

// --- Static File Serving and Catch-all ---

// Serve static files from the Vite build output
app.use(express.static(path.join(__dirname, 'dist')));

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