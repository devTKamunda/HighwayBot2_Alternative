// appUtils/refreshFileMediaIds.js
import cron from 'node-cron';
import connection from '../db.js';
import { getOrUploadFileMediaId } from '../mediaController/mediaUtils.js';

const BUSINESS_PHONE_NUMBER_ID = process.env.MY_PHONE_NUMBER_ID;
const REFRESH_INTERVAL_DAYS = 10;

let isRunning = false;

function hasValidFileData(fileData) {
  if (fileData == null) return false;
  if (Buffer.isBuffer(fileData)) return fileData.length > 0;
  if (typeof fileData === 'string') return fileData.trim().length > 0;
  return true;
}

function buildDocumentFilename(file) {
  const baseName =
    String(file.title || 'document')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim() || 'document';
  const ext =
    String(file.file_type || 'pdf')
      .replace(/^\./, '')
      .replace(/[^a-zA-Z0-9]/g, '') || 'pdf';

  return /\.[a-z0-9]+$/i.test(baseName) ? baseName : `${baseName}.${ext}`;
}

async function refreshFileMediaIds({ force = false } = {}) {
  if (isRunning) {
    console.log('[Media Refresh] Previous refresh is still running. Skipping.');
    return;
  }

  if (!BUSINESS_PHONE_NUMBER_ID) {
    console.error('[Media Refresh] MY_PHONE_NUMBER_ID is not configured.');
    return;
  }

  isRunning = true;

  try {
    console.log(
      force
        ? '[Media Refresh] Starting forced document media ID refresh (ignoring last upload time)...'
        : `[Media Refresh] Starting scheduled document media ID refresh (files older than ${REFRESH_INTERVAL_DAYS} days or never uploaded)...`
    );

    const query = force
      ? `
        SELECT *
        FROM files
        WHERE file_data IS NOT NULL
          AND OCTET_LENGTH(file_data) > 0
        ORDER BY id ASC
      `
      : `
        SELECT *
        FROM files
        WHERE file_data IS NOT NULL
          AND OCTET_LENGTH(file_data) > 0
          AND (
            media_uploaded_at IS NULL
            OR media_uploaded_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
          )
        ORDER BY id ASC
      `;

    const params = force ? [] : [REFRESH_INTERVAL_DAYS];
    const [files] = await connection.execute(query, params);

    if (files.length === 0) {
      console.log('[Media Refresh] No document media IDs need refreshing.');
      return;
    }

    console.log(
      `[Media Refresh] ${files.length} document(s) queued for media ID refresh.`
    );

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    // Process sequentially to avoid uploading multiple large documents at once.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (!hasValidFileData(file.file_data)) {
        skipped++;
        console.warn(
          `[Media Refresh] Skipping "${file.title}" (ID ${file.id}): empty or invalid file_data.`
        );
        continue;
      }

      try {
        const filename = buildDocumentFilename(file);

        const mediaId = await getOrUploadFileMediaId(
          file,
          BUSINESS_PHONE_NUMBER_ID,
          filename,
          true
        );

        if (!mediaId) {
          throw new Error('getOrUploadFileMediaId returned no mediaId');
        }

        succeeded++;
        console.log(
          `[Media Refresh] Refreshed media ID for "${file.title}" (ID ${file.id}, file: ${filename}).`
        );
      } catch (error) {
        failed++;
        console.error(
          `[Media Refresh] Failed for "${file.title}" (ID ${file.id}):`,
          error.response?.data || error.message
        );
      }

      // Brief pause between uploads to keep API calls paced.
      if (i < files.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    console.log(
      `[Media Refresh] Completed. Successful: ${succeeded}; Failed: ${failed}; Skipped: ${skipped}.`
    );
  } catch (error) {
    console.error(
      '[Media Refresh] Job failed:',
      error.response?.data || error.message
    );
  } finally {
    isRunning = false;
  }
}

// Run daily at 03:00 in Zimbabwe.
cron.schedule(
  '0 3 * * *',
  () => {
    refreshFileMediaIds().catch((err) => {
      console.error('[Media Refresh] Unhandled cron error:', err);
    });
  },
  {
    timezone: 'Africa/Harare',
  }
);

console.log('[Media Refresh] Scheduled daily at 03:00 Africa/Harare.');

export { refreshFileMediaIds };
