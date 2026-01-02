import axios from 'axios';
import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';
import cron from 'node-cron';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const {
    ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN,
    ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.com',
    ZOHO_MEETING_API_URL = 'https://meeting.zoho.com/api/v1',
    GCP_BUCKET_NAME,
    GCP_SERVICE_ACCOUNT_KEY,
    SYNC_CRON_SCHEDULE = '*/30 * * * *' // Default: every 30 mins
} = process.env;

const STATUS_FILE = path.join(__dirname, 'status.json');

// --- Initialization ---
let storage = null;
let bucket = null;
let uploadedRecordings = {};

function initGCP() {
    if (!GCP_BUCKET_NAME || !GCP_SERVICE_ACCOUNT_KEY) {
        console.error("❌ [GCP] Missing GCP_BUCKET_NAME or GCP_SERVICE_ACCOUNT_KEY.");
        return false;
    }
    try {
        const credentials = JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
        storage = new Storage({
            credentials,
            projectId: credentials.project_id,
        });
        bucket = storage.bucket(GCP_BUCKET_NAME);
        console.log("✅ [GCP] Storage initialized.");
        return true;
    } catch (e) {
        console.error(`❌ [GCP] Failed to initialize: ${e.message}`);
        return false;
    }
}

function loadStatus() {
    if (fs.existsSync(STATUS_FILE)) {
        try {
            uploadedRecordings = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            console.log(`[Status] Loaded ${Object.keys(uploadedRecordings).length} tracked recordings.`);
        } catch (e) {
            uploadedRecordings = {};
        }
    }
}

function saveStatus(meetingId) {
    uploadedRecordings[meetingId] = new Date().toISOString();
    fs.writeFileSync(STATUS_FILE, JSON.stringify(uploadedRecordings, null, 2));
}

// --- Zoho Functions ---
async function getAccessToken() {
    console.log("[Zoho] Refreshing access token...");
    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
        params: {
            refresh_token: ZOHO_REFRESH_TOKEN,
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token',
        }
    });
    return response.data.access_token;
}

async function fetchRecordings(token) {
    console.log("[Zoho] Fetching recordings...");
    const response = await axios.get(`${ZOHO_MEETING_API_URL}/recordings`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { page: 1, per_page: 50 }
    });
    return response.data.data || [];
}

async function streamToGCS(recording, token) {
    const meetingId = recording.meetingId;
    const downloadUrl = recording.download_url;
    const dest = `${meetingId}.mp4`;

    if (!downloadUrl || downloadUrl.includes('.m3u8')) {
        console.warn(`[Skip] ${meetingId}: No direct download link available.`);
        return false;
    }

    console.log(`[Sync] Uploading ${meetingId} -> gs://${GCP_BUCKET_NAME}/${dest}...`);
    try {
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream',
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });

        const file = bucket.file(dest);
        const writeStream = file.createWriteStream({
            metadata: { contentType: 'video/mp4' },
            resumable: true
        });

        await pipeline(response.data, writeStream);
        return true;
    } catch (e) {
        console.error(`[Error] ${meetingId} upload failed: ${e.message}`);
        return false;
    }
}

// --- Main Runner ---
async function runSync() {
    console.log(`\n--- Sync Started: ${new Date().toLocaleString()} ---`);
    if (!initGCP()) return;
    loadStatus();

    try {
        const token = await getAccessToken();
        const recordings = await fetchRecordings(token);
        
        let count = 0;
        for (const rec of recordings) {
            if (uploadedRecordings[rec.meetingId]) continue;
            
            const success = await streamToGCS(rec, token);
            if (success) {
                saveStatus(rec.meetingId);
                count++;
            }
        }
        console.log(`--- Sync Finished. Uploaded ${count} new recordings. ---`);
    } catch (e) {
        console.error(`--- Sync Aborted: ${e.message} ---`);
    }
}

// Schedule Job
cron.schedule(SYNC_CRON_SCHEDULE, () => {
    runSync();
});

// Run immediately on start
runSync();