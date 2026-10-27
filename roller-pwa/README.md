# Roller plant toolroom PWA
```bash
npm install
cp .env.local.example .env.local   # add Supabase URL + anon key
npx supabase link --project-ref YOUR_REF && npx supabase db push
npm run dev   # / kiosk, /cnc, /dashboard
```
Install on Android: open the HTTPS URL in Chrome > menu > Add to Home screen.
# Toolroom
