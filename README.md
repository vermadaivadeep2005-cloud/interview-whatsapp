# Interview WhatsApp System

An AI-moderated WhatsApp interview system for conducting structured research interviews.

## Setup Instructions

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Environment Variables:**
   Copy the sample environment file and fill in your actual credentials:
   ```bash
   cp .env.sample .env
   ```

3. **Run the Application Locally:**
   ```bash
   npm run dev
   ```

## Nudge Worker Cron Job Setup

The nudge worker (`src/nudge-worker.ts`) is designed to check for inactive sessions (10 hours stale) and send them a gentle reminder, while marking sessions over 24 hours stale as abandoned. 

For this to work automatically in production, it needs to be run periodically (e.g., every 30 minutes) using a scheduled task or cron job.

### Option 1: Linux crontab (Recommended for Production Servers)
If you are deploying on a Linux server (Ubuntu, Debian, etc.), use the built-in `cron`.

1. Open your cron editor:
   ```bash
   crontab -e
   ```
2. Add the following line to run the nudge job every 30 minutes. Be sure to replace `/path/to/project` with the actual path to your repository:
   ```bash
   */30 * * * * cd /path/to/project && npm run nudge >> /path/to/project/nudge.log 2>&1
   ```

### Option 2: PM2 (If you are using PM2 to manage your Node process)
If you run your server with PM2, you can use a community module like `pm2-cron` or simply start the script in cron mode via PM2:

```bash
pm2 start npm --name "whatsapp-nudge-worker" -- cron "* * * * *" -- run nudge
```
*(Adjust the cron syntax in the string to your preferred interval, such as `"*/30 * * * *"`)*

### Option 3: Windows Task Scheduler (For Windows Environments)
If you are hosting this on a Windows machine:

1. Open **Task Scheduler** from the Start Menu.
2. Click **Create Task...** on the right sidebar.
3. On the **General** tab, name it "WhatsApp Nudge Worker".
4. On the **Triggers** tab, click **New...**:
   - Begin the task: On a schedule
   - Choose **Daily**
   - Under Advanced settings, check **Repeat task every:** and type **30 minutes**, for a duration of **Indefinitely**.
5. On the **Actions** tab, click **New...**:
   - Action: **Start a program**
   - Program/script: `npm.cmd` (or the full path to your npm executable)
   - Add arguments: `run nudge`
   - Start in: `C:\Users\Indra\Desktop\InterviewWhatsapp\interview-whatsapp` (Your project root folder)
6. Save the task. It will now automatically trigger the nudge worker every 30 minutes in the background.

## Scripts

- `npm run dev`: Starts the Express webhook server with auto-reloading.
- `npm run seed`: Seeds the database with the initial active protocol.
- `npm run test-cli`: Runs a CLI simulation of the interview bot.
- `npm run nudge`: Manually triggers the nudge worker.
- `npm run audit-db`: Runs batch auditing on responses.
