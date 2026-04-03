# WordPress Plugin Analytics

This directory contains tools for analyzing WordPress plugin usage through Google Analytics data.

**Location**: `wordpress/analytics/` - Analytics tools for the WordPress chatbot plugin.

## Overview

The WordPress plugin tracks comprehensive user interactions with the chatbot, including:

- **Popup Engagement**: Open/close events, interaction methods, session duration
- **Search Promotion**: 50% scroll trigger effectiveness, conversion rates from search pages
- **Feature Usage**: Frequency of different chatbot features (NPS, language help, etc.)
- **User Behavior**: Question submission patterns, source link clicks, expert referrals

## Setup Instructions

### 1. Install Dependencies

```bash
cd wordpress/analytics
uv sync --locked --package mega-rag-chatbot-wordpress-analytics --no-default-groups
```

### 2. Google Analytics Setup

1. **Create Google Cloud Project**:

   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable the Google Analytics Data API

2. **Create Service Account**:

   - Go to IAM & Admin > Service Accounts
   - Create a new service account
   - Download the JSON credentials file
   - Save it securely (e.g., `~/credentials/ga-service-account.json`)

3. **Grant Analytics Access**:
   - Go to Google Analytics > Admin > Property > Property Access Management
   - Add the service account email with "Viewer" permissions

### 3. Configuration

Copy the example config and update with your settings:

```bash
cp config.json.example config.json
```

Edit `config.json` with your:

- Google Analytics property ID: `266581873`
- Path to your service account credentials JSON file

## Usage

### Basic Analysis

Analyze the last 30 days with default settings:

```bash
python wordpress_plugin_analytics.py \
  --property-id 266581873 \
  --credentials /path/to/credentials.json
```

### Custom Time Period

Analyze the last 7 days:

```bash
python wordpress_plugin_analytics.py \
  --property-id 266581873 \
  --credentials /path/to/credentials.json \
  --days 7
```

### Generate Charts and Reports

Create visualizations and save detailed JSON report:

```bash
python wordpress_plugin_analytics.py \
  --property-id 266581873 \
  --credentials /path/to/credentials.json \
  --days 30 \
  --charts \
  --output report_$(date +%Y%m%d).json
```

### Verbose Output

Enable detailed logging:

```bash
python wordpress_plugin_analytics.py \
  --property-id 266581873 \
  --credentials /path/to/credentials.json \
  --verbose
```

## Key Metrics Analyzed

### 1. Popup Engagement

- **Popup Open Rate**: Percentage of page views that result in popup opens
- **User Engagement Rate**: Percentage of users who interact with the popup
- **Open Methods**: How users open the popup (bubble click, keyboard shortcut, etc.)
- **Close Methods**: How users close the popup (close button, escape key, click away)

### 2. Search Promotion Effectiveness

The plugin shows a search bubble when users scroll 50% down search result pages. This analyzes:

- **Search Page Views**: Total views of search result pages
- **Search to Popup Conversion**: How many search page visits result in popup opens
- **Search to Question Conversion**: How many search visits result in actual questions
- **Top Search Pages**: Which search pages drive the most engagement

### 3. Feature Usage Frequency

Tracks usage of all chatbot features:

- **Question Submission**: Core chatbot usage
- **Full Page Chat**: Users clicking to expanded chat experience
- **Contact Human**: Intercom integration usage
- **Language Help**: Multi-language feature usage
- **NPS Surveys**: User feedback submission and dismissal
- **Source Links**: Users clicking on reference materials
- **Ask Experts**: Referrals to human experts
- **Suggestion Clicks**: AI-generated suggestion chip interactions

## Sample Output

```text
================================================================================
WORDPRESS PLUGIN ANALYTICS REPORT
================================================================================

Analysis Period: 30 days
Report Generated: 2025-09-16T14:30:00

📊 POPUP ENGAGEMENT METRICS
   Total Page Views: 45,230
   Total Users: 12,450
   Popup Opens: 2,261 (5.0% of page views)
   User Engagement Rate: 18.2% of users

🔍 SEARCH PROMOTION METRICS
   Search Page Views: 8,920
   Search Users: 3,240
   Questions from Search: 156
   Search to Question Rate: 1.75%

🎯 FEATURE USAGE SUMMARY
   Most Popular Feature: question_submit
   Top 5 Features:
     1. question_submit: 1,847 events
     2. popup_open: 2,261 events
     3. source_link_click: 423 events
     4. popup_close: 1,890 events
     5. fullpage_click: 89 events

💡 SUGGESTION ENGAGEMENT
   Suggestion Click Rate: 16.89% of questions

💡 KEY FINDINGS
   • High popup engagement: 5.0% of page views result in popup opens
   • Effective search promotion: 1.8% of search page visits convert to questions

🎯 RECOMMENDATIONS
   • Consider promoting underutilized features: language_click, ask_experts_click
```

## Output Files

The script can generate several types of output:

### JSON Report

Detailed analytics data in JSON format for further processing:

```json
{
  "report_metadata": {
    "generated_at": "2025-09-16T14:30:00",
    "analysis_period_days": 30,
    "property_id": "266581873"
  },
  "popup_engagement": { ... },
  "search_promotion": { ... },
  "feature_usage": { ... },
  "insights": { ... }
}
```

### Visualization Charts

When using `--charts`, generates PNG files:

- `popup_engagement.png`: Engagement rates and open methods
- `feature_usage.png`: Feature usage frequency ranking
- `daily_trends.png`: Daily trends for key metrics

## Troubleshooting

### Common Issues

1. **"Property not found" error**:

   - Verify the property ID is correct (266581873)
   - Ensure service account has access to the GA4 property

2. **"Credentials not found" error**:

   - Check the path to your JSON credentials file
   - Ensure the file has proper read permissions

3. **"No data returned" error**:

   - Verify the date range has data
   - Check that the WordPress plugin is properly tracking events
   - Confirm Google Analytics is receiving the events

4. **Import errors**:
   - Ensure the analytics package is synced: `uv sync --locked --package mega-rag-chatbot-wordpress-analytics --no-default-groups`
   - Check Python version compatibility (3.11)

### Debugging

Enable verbose logging to see detailed API calls:

```bash
python wordpress_plugin_analytics.py \
  --property-id 266581873 \
  --credentials /path/to/credentials.json \
  --verbose
```

### Verifying Event Tracking

To verify events are being tracked in Google Analytics:

1. Go to GA4 > Reports > Realtime
2. Interact with the chatbot on your website
3. Check that events appear in the realtime report
4. Look for events starting with `chatbot_vivek_`

## Advanced Usage

### Custom Event Analysis

The script can be extended to analyze additional events by modifying the `CHATBOT_EVENTS` dictionary in the Python
script.

### Automated Reporting

Set up automated daily/weekly reports using cron:

```bash
# Daily report at 9 AM
0 9 * * * cd /path/to/wordpress/analytics && python wordpress_plugin_analytics.py --property-id 266581873 --credentials /path/to/creds.json --days 1 --output daily_$(date +\%Y\%m\%d).json

# Weekly report on Mondays
0 9 * * 1 cd /path/to/wordpress/analytics && python wordpress_plugin_analytics.py --property-id 266581873 --credentials /path/to/creds.json --days 7 --charts --output weekly_$(date +\%Y\%m\%d).json
```

### Integration with Other Tools

The JSON output can be easily integrated with:

- Business intelligence tools (Tableau, Power BI)
- Slack/email reporting systems
- Custom dashboards
- Data warehouses

## Support

For issues or questions about the analytics system, contact the development team or check the main project
documentation.
