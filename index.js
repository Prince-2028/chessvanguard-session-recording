import axios from 'axios';
import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const {
    ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN,
    ZOHO_ACCOUNTS_URL = 'https://accounts.zoho.in',
    ZOHO_MEETING_API_URL = 'https://meeting.zoho.in/api/v1',
    GCP_BUCKET_NAME,
    GCP_SERVICE_ACCOUNT_KEY
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
        let credentials;
        if (GCP_SERVICE_ACCOUNT_KEY.endsWith('.json') || fs.existsSync(GCP_SERVICE_ACCOUNT_KEY)) {
            const keyPath = path.isAbsolute(GCP_SERVICE_ACCOUNT_KEY) 
                ? GCP_SERVICE_ACCOUNT_KEY 
                : path.join(__dirname, GCP_SERVICE_ACCOUNT_KEY);
            credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        } else {
            credentials = JSON.parse(GCP_SERVICE_ACCOUNT_KEY);
        }

        storage = new Storage({
            credentials,
            projectId: credentials.project_id,
        });
        bucket = storage.bucket(GCP_BUCKET_NAME);
        console.log(`✅ [GCP] Storage initialized for bucket: ${GCP_BUCKET_NAME}`);
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
            console.log(`[Status] Loaded ${Object.keys(uploadedRecordings).length} previously synced recordings.`);
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
    const url = `${ZOHO_ACCOUNTS_URL}/oauth/v2/token`;
    console.log(`[Zoho] Refreshing access token from: ${url}`);
    try {
        const response = await axios.post(url, null, {
            params: {
                refresh_token: ZOHO_REFRESH_TOKEN,
                client_id: ZOHO_CLIENT_ID,
                client_secret: ZOHO_CLIENT_SECRET,
                grant_type: 'refresh_token',
            }
        });
        if (response.data.error) {
            throw new Error(`Zoho Auth Error: ${response.data.error}`);
        }
        return response.data.access_token;
    } catch (e) {
        console.error(`❌ [Zoho Auth] Failed at ${url}: ${e.message}`);
        throw e;
    }
}

async function fetchRecordings(token) {
    const url = `${ZOHO_MEETING_API_URL}/recordings`;
    console.log(`[Zoho] Fetching recordings from: ${url}`);
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params: { page: 1, per_page: 50 }
        });
        return response.data.data || [];
    } catch (e) {
        console.error(`❌ [Zoho API] Failed to fetch recordings from ${url}: ${e.message}`);
        throw e;
    }
}

async function streamToGCS(recording, token) {
    const meetingId = recording.meetingId;
    const downloadUrl = recording.download_url;
    const topic = recording.topic || 'Unknown Topic';
    const dest = `${meetingId}.mp4`;

    if (!downloadUrl || downloadUrl.includes('.m3u8')) {
        console.warn(`[Skip] ${meetingId} (${topic}): No direct download link available.`);
        return false;
    }

    console.log(`[Sync] 🚀 Starting upload for: ${topic} (${meetingId})`);
    try {
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream',
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });

        const file = bucket.file(dest);
        const writeStream = file.createWriteStream({
            metadata: { 
                contentType: 'video/mp4',
                metadata: { meetingId, topic }
            },
            resumable: true
        });

        await pipeline(response.data, writeStream);
        console.log(`[Sync] ✅ Successfully uploaded: ${topic} (${meetingId})`);
        return true;
    } catch (e) {
        console.error(`❌ [Sync Error] ${meetingId} upload failed: ${e.message}`);
        return false;
    }
}

// --- Main Runner ---
async function runSync() {
    console.log(`\n--- Sync Session Started: ${new Date().toLocaleString()} ---`);
    if (!initGCP()) return;
    loadStatus();

    try {
        const token = await getAccessToken();
        const recordings = await fetchRecordings(token);
        
        console.log(`[Zoho] Found ${recordings.length} total recordings.`);
        
        let count = 0;
        for (const rec of recordings) {
            if (uploadedRecordings[rec.meetingId]) {
                console.log(`[Status] Already synced: ${rec.topic} (${rec.meetingId})`);
                continue;
            }
            
            const success = await streamToGCS(rec, token);
            if (success) {
                saveStatus(rec.meetingId);
                count++;
            }
        }
        console.log(`\n--- Sync Session Finished. ${count} new recordings uploaded. ---`);
    } catch (e) {
        console.error(`\n--- Sync Session Aborted: ${e.message} ---`);
        console.error(`Tip: If you got a 404, check if your ZOHO_ACCOUNTS_URL or ZOHO_MEETING_API_URL are correct for your region (e.g., .eu, .in, .com.au).`);
        process.exit(1);
    }
}

// Run immediately
runSync();