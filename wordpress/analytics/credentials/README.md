# Google Analytics Credentials

This directory should contain your Google service account credentials file.

## Setup Instructions

1. **Create a Google Cloud Project**:

   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one
   - Enable the Google Analytics Data API

2. **Create Service Account**:

   - Navigate to IAM & Admin > Service Accounts
   - Click "Create Service Account"
   - Enter a name (e.g., "ga-analytics-reader")
   - Click "Create and Continue"
   - Skip role assignment for now (we'll add GA permissions separately)
   - Click "Done"

3. **Generate Credentials**:

   - Click on the created service account
   - Go to the "Keys" tab
   - Click "Add Key" > "Create new key"
   - Select "JSON" format
   - Download the file and save it as `ga-service-account.json` in this directory

4. **Grant Google Analytics Access**:
   - Go to [Google Analytics](https://analytics.google.com/)
   - Select your property
   - Go to Admin > Property > Property Access Management
   - Click the "+" button to add users
   - Enter the service account email (found in the JSON file)
   - Select "Viewer" role
   - Click "Add"

## File Structure

After setup, this directory should contain:

```text
credentials/
├── README.md (this file)
└── ga-service-account.json (your credentials - DO NOT COMMIT)
```

## Security Notes

- **Never commit credentials to version control**
- The `.gitignore` file should exclude `*.json` files in this directory
- Keep credentials file permissions restricted (600)
- Rotate credentials periodically for security

## Verification

To verify your setup works:

```bash
cd /path/to/analytics
./run_analysis.sh test
```

This will test the connection and validate your credentials.
