import axios from 'axios';
import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises'; // Added for robust streaming

// Helper to get __dirname equivalent in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_MEETING_API_URL = process.env.ZOHO_MEETING_API_URL || 'https://meeting.zoho.com/api/v1';
const GCP_BUCKET_NAME = process.env.GCP_BUCKET_NAME;
const GCP_SERVICE_ACCOUNT_KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_KEY;

// Status file location relative to syncService.js
const STATUS_FILE = path.join(__dirname, 'status.json'); 

// --- Initialization ---

let storage;
let bucket;
let uploadedRecordings = {};

try {
    if (!GCP_BUCKET_NAME || !GCP_SERVICE_ACCOUNT_KEY_JSON) {
        console.warn("[GCP] GCP environment variables are missing. Sync will not run.");
    } else {
        const credentials = JSON.parse(GCP_SERVICE_ACCOUNT_KEY_JSON);
        storage = new Storage({
            credentials: credentials,
            projectId: credentials.project_id,
        });
        bucket = storage.bucket(GCP_BUCKET_NAME);
    }
} catch (e) {
    console.error("[GCP] Failed to initialize GCP Storage. Ensure GCP_SERVICE_ACCOUNT_KEY is valid JSON.", e.message);
}

function loadStatus() {
    if (fs.existsSync(STATUS_FILE)) {
        try {
            uploadedRecordings = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
            console.log(`[SyncService] Loaded tracking status for ${Object.keys(uploadedRecordings).length} recordings.`);
        } catch (e) {
            console.warn("[SyncService] Could not parse status file. Starting fresh tracking.");
            uploadedRecordings = {};
        }
    }
}

function updateStatus(meetingId) {
    uploadedRecordings[meetingId] = new Date().toISOString();
    fs.writeFileSync(STATUS_FILE, JSON.stringify(uploadedRecordings, null, 2));
}

// --- Zoho API Functions ---

async function getAccessToken() {
    if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
        throw new Error("Zoho credentials (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN) are missing.");
    }
    console.log("[Zoho] Fetching new Access Token...");
    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
        params: {
            refresh_token: ZOHO_REFRESH_TOKEN,
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token',
        }
    });
    if (response.data && response.data.access_token) {
        console.log("[Zoho] Token fetched successfully.");
        return response.data.access_token;
    }
    throw new Error("Failed to retrieve Zoho Access Token.");
}

async function fetchRecordings(accessToken) {
    console.log("[Zoho] Fetching recent recordings...");
    
    const response = await axios.get(`${ZOHO_MEETING_API_URL}/recordings`, {
        headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`
        },
        params: {
            page: 1,
            per_page: 50,
        }
    });

    if (response.data && response.data.data) {
        console.log(`[Zoho] Found ${response.data.data.length} recordings.`);
        return response.data.data;
    }
    return [];
}

// --- Streaming Logic ---

async function streamToGCS(recording, accessToken) {
    const meetingId = recording.meetingId;
    const downloadUrl = recording.download_url;
    const destination = `${meetingId}.mp4`;

    if (!downloadUrl) {
        console.warn(`[GCS] Recording ${meetingId} has no download URL. Skipping.`);
        return false;
    }

    if (downloadUrl.includes('.m3u8')) {
        console.warn(`[GCS] Detected M3U8 stream for ${meetingId}. Skipping as local disk storage (required for FFmpeg conversion) is prohibited.`);
        return false;
    }

    console.log(`[GCS] Starting stream upload for ${meetingId} to ${destination}...`);

    try {
        // 1. Get the video stream from Zoho, ensuring the access token is used for protected download URLs
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream',
            headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`
            }
        });

        // 2. Create a write stream to GCS
        const gcsFile = bucket.file(destination);
        const gcsStream = gcsFile.createWriteStream({
            metadata: {
                contentType: 'video/mp4',
            },
            resumable: true, // Recommended for large files
        });

        // 3. Pipe the Zoho stream directly to the GCS stream using pipeline for robust error handling
        await pipeline(response.data, gcsStream);

        console.log(`[GCS] Upload successful for ${meetingId}.`);
        return true;

    } catch (error) {
        console.error(`[GCS] Failed to stream recording ${meetingId}:`, error.message);
        return false;
    }
}

// --- Main Sync Function ---

let isSyncRunning = false;
let lastRunStatus = {
    status: 'Idle',
    timestamp: new Date().toISOString(),
    processedCount: 0,
    totalRecordings: 0,
    error: null,
};

async function runSync() {
    if (isSyncRunning) {
        console.log("[SyncService] Sync already running. Skipping this trigger.");
        return lastRunStatus;
    }

    if (!storage || !bucket) {
        const errorMsg = "GCP Storage is not initialized. Check environment variables.";
        console.error(`[SyncService] ${errorMsg}`);
        lastRunStatus = { status: 'Error', timestamp: new Date().toISOString(), processedCount: 0, totalRecordings: 0, error: errorMsg };
        return lastRunStatus;
    }

    isSyncRunning = true;
    lastRunStatus = { status: 'Running', timestamp: new Date().toISOString(), processedCount: 0, totalRecordings: 0, error: null };
    loadStatus(); // Reload status before starting

    let accessToken;
    let processedCount = 0;
    let totalRecordings = 0;
    let error = null;

    try {
        accessToken = await getAccessToken();
    } catch (e) {
        error = e.message;
        console.error(`[SyncService] Authentication failed: ${error}`);
        isSyncRunning = false;
        lastRunStatus = { status: 'Error', timestamp: new Date().toISOString(), processedCount, totalRecordings, error };
        return lastRunStatus;
    }
    
    try {
        const recordings = await fetchRecordings(accessToken);
        totalRecordings = recordings.length;

        for (const recording of recordings) {
            const meetingId = recording.meetingId;

            if (uploadedRecordings[meetingId]) {
                console.log(`[SyncService] Recording ${meetingId} already processed. Skipping.`);
                continue;
            }

            // Pass the accessToken to streamToGCS
            const success = await streamToGCS(recording, accessToken);

            if (success) {
                updateStatus(meetingId);
                processedCount++;
            }
        }

        lastRunStatus = { 
            status: 'Completed', 
            timestamp: new Date().toISOString(), 
            processedCount, 
            totalRecordings, 
            error: null 
        };
        console.log(`[SyncService] Sync process completed. Uploaded ${processedCount} new recordings.`);

    } catch (processError) {
        error = processError.message;
        console.error(`[SyncService] Sync failed during processing: ${error}`);
        lastRunStatus = { status: 'Error', timestamp: new Date().toISOString(), processedCount, totalRecordings, error };
    } finally {
        isSyncRunning = false;
    }
    
    return lastRunStatus;
}

function getSyncStatus() {
    return lastRunStatus;
}

export {
    runSync,
    getSyncStatus,
};