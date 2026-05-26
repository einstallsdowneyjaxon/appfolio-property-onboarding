# Property Onboarding

React/Vite upload UI plus AppFolio property onboarding automation.

## AppFolio Onboarding Auth

Property onboarding uses its own dedicated AppFolio Chromium profile. Do not point it at the renewal bot profile.

Production profile path:

```bash
/root/appfolio-property-onboarding/.playwright-appfolio-profile
```

Production `.env.local` should include:

```bash
APPFOLIO_URL=https://thetgpm.appfolio.com
PLAYWRIGHT_USER_DATA_DIR=/root/appfolio-property-onboarding/.playwright-appfolio-profile
HEADLESS=true
GOOGLE_OAUTH_CLIENT_JSON=/root/appfolio-property-onboarding/client_secret.json
GOOGLE_OAUTH_TOKEN_PATH=/root/appfolio-property-onboarding/.appfolio-google-token.json
```

The property runner fails loudly if the onboarding profile directory is missing or does not look like a Chromium profile. This prevents Playwright from silently creating an empty unauthenticated profile.

## First-Time AppFolio Login

The most reliable bootstrap path is to complete AppFolio login/MFA in a visible browser on the VPS itself. This creates the Linux Chromium profile directly at:

```bash
/root/appfolio-property-onboarding/.playwright-appfolio-profile
```

Do not use plain `xvfb-run` for MFA. It starts a browser, but the display is invisible.

### Visible VPS Login With noVNC

Install the visible desktop pieces once:

```bash
cd /root/appfolio-property-onboarding
apt-get update
apt-get install -y xvfb fluxbox x11vnc novnc websockify
```

Start the noVNC display helper:

```bash
npm run appfolio:onboarding-novnc
```

From your local computer, open an SSH tunnel to the VPS:

```bash
ssh -L 6080:127.0.0.1:6080 root@YOUR_VPS_IP
```

Then open this URL on your local computer:

```text
http://127.0.0.1:6080/vnc.html
```

In a second VPS terminal, run the login bootstrap against that visible display:

```bash
pm2 stop property-onboarding
mkdir -p /root/appfolio-property-onboarding/.playwright-appfolio-profile
DISPLAY=:99 npm run appfolio:onboarding-login
```

Complete AppFolio login/MFA in the launched browser. When the AppFolio dashboard/app shell is visible, return to the terminal, type `DONE`, and press Enter. The script closes Chromium cleanly so the profile is saved.

After that, production jobs can run headless through PM2.

### Local Profile Copy Alternative

Copying a Chromium profile from Windows/macOS to Linux is not the preferred path because browser cookies may be encrypted differently by each operating system. Use noVNC first. Only try local profile copying if the VPS-visible login path is unavailable.

## Notes

- Renewal bot auth is intentionally separate and untouched.
- Do not run onboarding against `/root/appfolio-renewal/.playwright-appfolio-profile`.
- Google OAuth token/client paths are onboarding-owned runtime files. They are not committed.
- The onboarding Google auth module reuses an existing saved token and fails if the token/client JSON is missing.
