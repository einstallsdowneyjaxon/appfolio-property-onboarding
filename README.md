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

On the VPS, run the headed bootstrap once to create and save the onboarding AppFolio session:

```bash
cd /root/appfolio-property-onboarding
mkdir -p /root/appfolio-property-onboarding/.playwright-appfolio-profile
xvfb-run -a npm run appfolio:onboarding-login
```

Complete AppFolio login/MFA in the launched browser. When the AppFolio dashboard/app shell is visible, return to the terminal, type `DONE`, and press Enter. The script closes Chromium cleanly so the profile is saved.

After that, production jobs can run headless through PM2.

## Notes

- Renewal bot auth is intentionally separate and untouched.
- Do not run onboarding against `/root/appfolio-renewal/.playwright-appfolio-profile`.
- Google OAuth token/client paths are onboarding-owned runtime files. They are not committed.
- The onboarding Google auth module reuses an existing saved token and fails if the token/client JSON is missing.
