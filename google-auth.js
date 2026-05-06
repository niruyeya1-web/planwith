// netlify/functions/google-auth.js
// Handles Google OAuth: exchanges code → tokens → creates calendar event

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SITE_URL             = process.env.URL || 'http://localhost:8888';
const REDIRECT_URI         = `${SITE_URL}/.netlify/functions/google-auth`;

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};

  // ── STEP 1: Redirect to Google OAuth ──────────────────────
  if (params.action === 'login') {
    const { iso, time, title, desc, name } = params;

    const state = Buffer.from(JSON.stringify({ iso, time, title, desc, name })).toString('base64url');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id',     GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar.events');
    authUrl.searchParams.set('access_type',   'online');
    authUrl.searchParams.set('prompt',        'consent');
    authUrl.searchParams.set('state',         state);

    return { statusCode: 302, headers: { Location: authUrl.toString() }, body: '' };
  }

  // ── STEP 2: OAuth Callback — exchange code → token → create event ──
  if (params.code && params.state) {
    try {
      // Decode state (booking info)
      const booking = JSON.parse(Buffer.from(params.state, 'base64url').toString());

      // Exchange code for access token
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code:          params.code,
          client_id:     GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri:  REDIRECT_URI,
          grant_type:    'authorization_code'
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(tokenData));

      // Build event datetime
      const { iso, time, title, desc, name } = booking;
      const startDT = new Date(`${iso}T${time}:00`);
      const endDT   = new Date(startDT.getTime() + 60 * 60000);

      // Create Google Calendar event
      const eventRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          summary:     `${title} 🫶 mit ${name}`,
          description: `Organisiert von ${name} via planwith.${desc ? '\n' + desc : ''}`,
          start: { dateTime: startDT.toISOString(), timeZone: 'Europe/Berlin' },
          end:   { dateTime: endDT.toISOString(),   timeZone: 'Europe/Berlin' },
          reminders: {
            useDefault: false,
            overrides:  [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 1440 }]
          }
        })
      });
      const eventData = await eventRes.json();
      if (!eventData.id) throw new Error('Event creation failed: ' + JSON.stringify(eventData));

      // Redirect back to app with success flag
      return {
        statusCode: 302,
        headers: { Location: `${SITE_URL}/#cal-success-google` },
        body: ''
      };

    } catch (err) {
      console.error('Google auth error:', err);
      return {
        statusCode: 302,
        headers: { Location: `${SITE_URL}/#cal-error?msg=${encodeURIComponent(err.message)}` },
        body: ''
      };
    }
  }

  return { statusCode: 400, body: 'Bad request' };
};
