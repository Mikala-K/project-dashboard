# project-dashboard
Project tracking with time allocation, calendar-blocking, prioritized tasking, ticketing and detail logging features

## How it works

- `index.html`, `styles.css`, `app.js`: the dashboard page, served by GitHub Pages
- Data lives in the Google Sheet "WIPP Project Dashboard DB" and comes in through n8n webhooks (folder "Project Dashboard" in n8n)
- Open it with your personal key on the end of the link: `?key=...`. The key is saved on that device so the home screen icon works
- Add `&preview=maintenance` to the link to see the maintenance gauge styles
