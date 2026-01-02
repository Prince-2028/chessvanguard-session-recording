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
    ZOHO_MEETING_API_URL = 'https://meeting.zoho.in/meeting/api/v2',
    ZOHO_ZSOID,
    GCP_BUCKET_NAME,
    GCP_SERVICE_ACCOUNT_KEY
} = process.env;

const STATUS_FILE = path.join(__dirname, 'status.json');

// --- Initialization ---
let storage = null;
let bucket = null;
let uploadedRecordings = {};

async function initGCP() {
    if (!GCP_BUCKET_NAME || !GCP_SERVICE_ACCOUNT_KEY) {
        console.error("❌ [GCP] Missing GCP_BUCKET_NAME or GCP_SERVICE_ACCOUNT_KEY in environment.");
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
        
        const bucketName = GCP_BUCKET_NAME.trim();
        bucket = storage.bucket(bucketName);
        
        const [exists] = await bucket.exists();
        if (!exists) {
            console.error(`❌ [GCP] Bucket "${bucketName}" not found in project "${credentials.project_id}".`);
            return false;
        }

        console.log(`✅ [GCP] Storage initialized. Target bucket: ${bucketName}`);
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

function saveStatus(recordingId) {
    uploadedRecordings[recordingId] = new Date().toISOString();
    fs.writeFileSync(STATUS_FILE, JSON.stringify(uploadedRecordings, null, 2));
}

// --- Zoho Functions ---
async function getAccessToken() {
    const url = `${ZOHO_ACCOUNTS_URL}/oauth/v2/token`;
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
        console.error(`❌ [Zoho Auth] Failed: ${e.message}`);
        throw e;
    }
}

async function fetchRecordings(token) {
    if (!ZOHO_ZSOID) {
        throw new Error("Missing ZOHO_ZSOID in environment variables.");
    }
    const url = `${ZOHO_MEETING_API_URL}/${ZOHO_ZSOID}/recordings.json`;
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });
        return response.data.recordings || [];
    } catch (e) {
        console.error(`❌ [Zoho API] Failed to fetch recordings: ${e.message}`);
        throw e;
    }
}

async function streamToGCS(recording, token) {
    const { recordingId, downloadUrl, topic, status } = recording;
    const dest = `${recordingId}.mp4`;

    if (status !== 'UPLOADED') {
        console.log(`[Skip] ${topic} (${recordingId}): Status is '${status}', not 'UPLOADED'.`);
        return false;
    }

    if (!downloadUrl) {
        console.warn(`[Skip] ${topic} (${recordingId}): No downloadUrl found.`);
        return false;
    }

    console.log(`[Sync] 🚀 Starting upload to GCP: ${topic} (${recordingId})`);
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
                metadata: { recordingId, topic, zohoStatus: status }
            },
            resumable: true
        });

        await pipeline(response.data, writeStream);
        console.log(`[Sync] ✅ Successfully uploaded to GCP: ${topic} (${recordingId})`);
        return true;
    } catch (e) {
        console.error(`❌ [Sync Error] GCP upload failed for ${recordingId}: ${e.message}`);
        return false;
    }
}

async function deleteFromZoho(recordingId, token) {
    // Exact URL pattern provided: https://meeting.zoho.in/api/v2/{zsoid}/recordings/{recordingId}.json
    const url = `https://meeting.zoho.in/api/v2/${ZOHO_ZSOID}/recordings/${recordingId}.json`;
    console.log(`[Cleanup] 🗑️ Deleting from Zoho: ${recordingId}`);
    try {
        await axios.delete(url, {
            headers: { Authorization: `Zoho-oauthtoken ${token}` }
        });
        console.log(`[Cleanup] ✅ Successfully deleted from Zoho: ${recordingId}`);
        return true;
    } catch (e) {
        console.error(`❌ [Cleanup Error] Zoho deletion failed for ${recordingId}: ${e.message}`);
        return false;
    }
}

// --- Main Runner ---
async function runSync() {
    console.log(`\n--- Sync Session Started: ${new Date().toLocaleString()} ---`);
    const gcpReady = await initGCP();
    if (!gcpReady) {
        console.error("Aborting sync due to GCP initialization failure.");
        process.exit(1);
    }
    
    loadStatus();

    try {
        const token = await getAccessToken();
        const recordings = await fetchRecordings(token);
        
        console.log(`[Zoho] Found ${recordings.length} total recordings.`);
        
        let count = 0;
        for (const rec of recordings) {
            const { recordingId, topic } = rec;
            
            if (uploadedRecordings[recordingId]) {
                console.log(`[Status] Already synced: ${topic} (${recordingId})`);
                continue;
            }
            
            const success = await streamToGCS(rec, token);
            if (success) {
                // Save to local status first to ensure we don't try to re-upload if deletion fails
                saveStatus(recordingId);
                
                // Delete from Zoho using the Zoho API URL provided
                 await deleteFromZoho(recordingId, token);
                
                count++;
            }
        }
        console.log(`\n--- Sync Session Finished. ${count} recordings processed. ---`);
    } catch (e) {
        console.error(`\n--- Sync Session Aborted: ${e.message} ---`);
        process.exit(1);
    }
}

// Run immediately
runSync();