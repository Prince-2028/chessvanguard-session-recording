const axios = require('axios');
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Configuration ---
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_MEETING_API_URL = process.env.ZOHO_MEETING_API_URL || 'https://meeting.zoho.com/api/v1';
const GCP_BUCKET_NAME = process.env.GCP_BUCKET_NAME;
const GCP_SERVICE_ACCOUNT_KEY_JSON = process.env.GCP_SERVICE_ACCOUNT_KEY;

const STATUS_FILE = path.join(__dirname, 'status.json');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN || !GCP_BUCKET_NAME || !GCP_SERVICE_ACCOUNT_KEY_JSON) {
    console.error("Missing required environment variables. Please check ZOHO_* and GCP_* secrets.");
    process.exit(1);
}

// --- Initialization ---

// Set up GCP credentials using the provided JSON key content
let storage;
let bucket;
try {
    const credentials = JSON.parse(GCP_SERVICE_ACCOUNT_KEY_JSON);
    storage = new Storage({
        credentials: credentials,
        projectId: credentials.project_id,
    });
    bucket = storage.bucket(GCP_BUCKET_NAME);
} catch (e) {
    console.error("Failed to initialize GCP Storage. Ensure GCP_SERVICE_ACCOUNT_KEY is valid JSON.", e);
    process.exit(1);
}


// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Load or initialize status tracking
let uploadedRecordings = {};
if (fs.existsSync(STATUS_FILE)) {
    try {
        uploadedRecordings = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        console.log(`Loaded tracking status for ${Object.keys(uploadedRecordings).length} recordings.`);
    } catch (e) {
        console.warn("Could not parse status file. Starting fresh tracking.");
    }
}

// --- Zoho API Functions ---

async function getAccessToken() {
    console.log("Fetching new Zoho Access Token using Refresh Token...");
    const response = await axios.post(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, null, {
        params: {
            refresh_token: ZOHO_REFRESH_TOKEN,
            client_id: ZOHO_CLIENT_ID,
            client_secret: ZOHO_CLIENT_SECRET,
            grant_type: 'refresh_token',
        }
    });
    if (response.data && response.data.access_token) {
        console.log("Token fetched successfully.");
        return response.data.access_token;
    }
    throw new Error("Failed to retrieve Zoho Access Token. Response: " + JSON.stringify(response.data));
}

async function fetchRecordings(accessToken) {
    console.log("Fetching recent recordings...");
    
    const response = await axios.get(`${ZOHO_MEETING_API_URL}/recordings`, {
        headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`
        },
        params: {
            // Fetch up to 50 recordings per run
            page: 1,
            per_page: 50,
        }
    });

    if (response.data && response.data.data) {
        console.log(`Found ${response.data.data.length} recordings.`);
        return response.data.data;
    }
    return [];
}

// --- Core Sync Logic ---

function updateStatus(meetingId) {
    uploadedRecordings[meetingId] = new Date().toISOString();
    fs.writeFileSync(STATUS_FILE, JSON.stringify(uploadedRecordings, null, 2));
}

async function downloadAndConvert(recording, accessToken) {
    const meetingId = recording.meetingId;
    const downloadUrl = recording.download_url;
    const fileName = `${meetingId}.mp4`;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    if (!downloadUrl) {
        console.warn(`Recording ${meetingId} has no download URL. Skipping.`);
        return null;
    }

    console.log(`Processing recording ${meetingId}.`);

    // Check if the URL suggests an M3U8 stream (HLS)
    if (downloadUrl.includes('.m3u8')) {
        console.log(`Detected M3U8 stream for ${meetingId}. Using ffmpeg for conversion.`);
        
        try {
            // Use ffmpeg to download and convert HLS stream to MP4
            const ffmpegCommand = `ffmpeg -i "${downloadUrl}" -c copy -bsf:a aac_adtstoasc "${filePath}" -y`;
            
            execSync(ffmpegCommand, { stdio: 'inherit' });
            
            console.log(`Successfully converted and saved ${fileName}`);
            return filePath;

        } catch (error) {
            console.error(`FFmpeg conversion failed for ${meetingId}. Ensure ffmpeg is installed and the URL is accessible.`);
            return null;
        }

    } else {
        // Assume direct MP4 download (or similar binary file)
        console.log(`Downloading direct file for ${meetingId}...`);
        
        const response = await axios({
            method: 'get',
            url: downloadUrl,
            responseType: 'stream',
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                console.error(`Error during download stream for ${meetingId}:`, err.message);
                reject(err);
            });
        });

        console.log(`Successfully downloaded ${fileName}`);
        return filePath;
    }
}

async function uploadToGCS(filePath, meetingId) {
    const destination = `${meetingId}.mp4`;
    console.log(`Uploading ${filePath} to GCS bucket ${GCP_BUCKET_NAME} as ${destination}...`);

    await bucket.upload(filePath, {
        destination: destination,
        metadata: {
            contentType: 'video/mp4',
        },
    });

    console.log(`Upload successful for ${meetingId}.`);
}

async function cleanup(filePath) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up local file: ${filePath}`);
    }
}

async function main() {
    let accessToken;
    try {
        accessToken = await getAccessToken();
    } catch (e) {
        console.error("FATAL: Could not authenticate with Zoho.");
        process.exit(1);
    }
    
    const recordings = await fetchRecordings(accessToken);

    for (const recording of recordings) {
        const meetingId = recording.meetingId;

        if (uploadedRecordings[meetingId]) {
            console.log(`Recording ${meetingId} already processed. Skipping.`);
            continue;
        }

        let filePath = null;
        try {
            filePath = await downloadAndConvert(recording, accessToken);

            if (filePath) {
                await uploadToGCS(filePath, meetingId);
                updateStatus(meetingId);
            }
        } catch (processError) {
            console.error(`Failed to process recording ${meetingId}:`, processError.message);
        } finally {
            if (filePath) {
                await cleanup(filePath);
            }
        }
    }

    console.log("Sync process completed successfully.");
}

main();