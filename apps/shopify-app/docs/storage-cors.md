# Storage CORS + Lifecycle Configuration Runbook

## Purpose

After the presigned-upload feature ships (Task 3), the app no longer buffers model uploads to the app server. Instead, browsers directly upload GLB files to the storage bucket using presigned PUT URLs. This architecture requires Cross-Origin Resource Sharing (CORS) rules on the bucket — without them, the browser's same-origin policy blocks the PUT request and the upload fails.

This is a **hard prerequisite**: the old buffered upload path is removed, so uploads only work once CORS is live.

## Determining Your Storage Provider

Check the Vercel environment for your deployment:

- **If `S3_ENDPOINT` is set** → You are using **Cloudflare R2** (or another S3-compatible service)
- **If `S3_ENDPOINT` is unset** → You are using **AWS S3**

**Important:** The app's public origin (the Vercel domain serving the embedded admin iframe) must be used in the CORS rule. Typically this is `https://<your-app>.vercel.app` or your custom domain if configured.

## Step 1: Apply the CORS Rule

### CORS Configuration

Create a file `cors.json` with the following content, replacing `<app-origin>` with your actual app origin (e.g., `https://myapp.vercel.app`):

```json
[
  {
    "AllowedOrigins": ["<app-origin>"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3000
  }
]
```

### AWS S3

S3 wraps CORS rules in a `CORSRules` object. Create a file named `cors-s3.json`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["<app-origin>"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3000
    }
  ]
}
```

Apply the rule using the AWS CLI:

```bash
aws s3api put-bucket-cors \
  --bucket <S3_BUCKET> \
  --cors-configuration file://cors-s3.json
```

**Note:** Replace `<S3_BUCKET>` with your actual bucket name (e.g., `my-org-models`).

To verify the rule was applied:

```bash
aws s3api get-bucket-cors --bucket <S3_BUCKET>
```

### Cloudflare R2

Apply the CORS rule using either the dashboard or the Wrangler CLI.

**Option A: Wrangler CLI**

```bash
wrangler r2 bucket cors put <bucket-name> --file cors.json
```

**Option B: R2 Dashboard**

1. Navigate to your R2 bucket in the Cloudflare dashboard
2. Go to **Settings** → **CORS policy**
3. Paste the JSON array from above:
   ```json
   [
     {
       "AllowedOrigins": ["<app-origin>"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```
4. Click **Save**

To verify the rule was applied via CLI:

```bash
wrangler r2 bucket cors get <bucket-name>
```

## Step 2: Add the Lifecycle Rule

Orphaned uploads (those abandoned before the `finalize` endpoint is called) should be cleaned up automatically. Add a lifecycle rule to expire objects under the `uploads/` prefix after 1 day.

### AWS S3

Create a file named `lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "DeleteAbandonedUploads",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "uploads/"
      },
      "Expiration": {
        "Days": 1
      }
    }
  ]
}
```

Apply the rule:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket <S3_BUCKET> \
  --lifecycle-configuration file://lifecycle.json
```

To verify:

```bash
aws s3api get-bucket-lifecycle-configuration --bucket <S3_BUCKET>
```

### Cloudflare R2

**Option A: Wrangler CLI**

Create a file named `lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "DeleteAbandonedUploads",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "uploads/"
      },
      "Expiration": {
        "Days": 1
      }
    }
  ]
}
```

Apply:

```bash
wrangler r2 bucket lifecycle put <bucket-name> --file lifecycle.json
```

**Option B: R2 Dashboard**

1. Navigate to your R2 bucket
2. Go to **Settings** → **Object lifecycle rules**
3. Click **Create lifecycle rule**
4. Set:
   - **Prefix:** `uploads/`
   - **Expiration:** Delete after 1 day
5. Click **Save**

To verify via CLI:

```bash
wrangler r2 bucket lifecycle get <bucket-name>
```

## Step 3: End-to-End Verification

After CORS and lifecycle rules are applied, verify the entire flow works:

1. **Deploy or run the app** pointing to the configured bucket (with the updated `S3_ENDPOINT` or AWS credentials in Vercel env, or locally).

2. **Open the admin Models page** in your Shopify app (navigate to the embedded iframe showing the model management UI).

3. **Upload a full-res model file** (`gripz_G_yellow.glb`, approximately 8.8 MB — this is the file that previously returned a 413 Payload Too Large error with the buffered path).

4. **Observe the upload behavior:**
   - The progress bar should advance from 0% to 100%
   - After reaching 100%, the UI should show "Calibrating…" while the backend processes the mesh
   - Once calibration completes, a "Model calibrated" banner should appear
   - The new model should be visible in the models list

5. **Verify cleanup in storage:**
   - Check that no orphaned objects remain under the `uploads/` prefix (they should have been deleted by the `finalize` endpoint)
   - Confirm that exactly one permanent object with a UUID filename (e.g., `<uuid>.glb`) exists at the root level of the bucket

**If verification fails:**

- **Upload hangs at 0%:** CORS rule may not be configured. Check the browser console for CORS errors. Verify the app origin matches exactly (including protocol and port).
- **Upload succeeds but calibration fails:** The temporary object is still deleted before calibration, so nothing is left to clean up. The lifecycle rule only handles the case where finalize is never called.
- **Orphaned objects remain under `uploads/`:** Verify the lifecycle rule was applied with the correct prefix and expiration time.

## Summary

| Step | AWS S3 | Cloudflare R2 |
|------|--------|---------------|
| **CORS** | `aws s3api put-bucket-cors --bucket <name> --cors-configuration file://cors-s3.json` | `wrangler r2 bucket cors put <name> --file cors.json` or dashboard |
| **Lifecycle** | `aws s3api put-bucket-lifecycle-configuration --bucket <name> --lifecycle-configuration file://lifecycle.json` | `wrangler r2 bucket lifecycle put <name> --file lifecycle.json` or dashboard |

---

**Last Updated:** 2026-09-04
