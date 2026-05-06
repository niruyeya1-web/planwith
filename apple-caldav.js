// netlify/functions/apple-caldav.js
// Creates an Apple Calendar event via CalDAV (iCloud)
// User provides their Apple ID + App-Specific Password

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { appleId, appPassword, iso, time, title, desc, guestName } = body;

  if (!appleId || !appPassword || !iso || !time) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing required fields' })
    };
  }

  try {
    // Step 1: Discover CalDAV principal URL
    const davBase  = 'https://caldav.icloud.com';
    const authHeader = 'Basic ' + Buffer.from(`${appleId}:${appPassword}`).toString('base64');

    // Find principal
    const principalRes = await fetch(`${davBase}/.well-known/caldav`, {
      method: 'PROPFIND',
      headers: {
        'Authorization': authHeader,
        'Depth':         '0',
        'Content-Type':  'application/xml',
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`
    });

    if (!principalRes.ok && principalRes.status !== 207) {
      throw new Error(`Apple auth failed (${principalRes.status}) — check Apple ID and App-Specific Password`);
    }

    const principalXML = await principalRes.text();

    // Extract principal path (simple regex for <href>)
    const principalMatch = principalXML.match(/<current-user-principal[^>]*>\s*<href[^>]*>([^<]+)<\/href>/i)
                        || principalXML.match(/<href[^>]*>(\/[^<]*principal[^<]*)<\/href>/i);
    const principalPath = principalMatch ? principalMatch[1] : null;

    // Step 2: Find calendar home
    let calendarPath;
    if (principalPath) {
      const homeRes = await fetch(`${davBase}${principalPath}`, {
        method: 'PROPFIND',
        headers: { 'Authorization': authHeader, 'Depth': '0', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop><cal:calendar-home-set/></d:prop>
</d:propfind>`
      });
      const homeXML = await homeRes.text();
      const homeMatch = homeXML.match(/<calendar-home-set[^>]*>\s*<href[^>]*>([^<]+)<\/href>/i);
      calendarPath = homeMatch ? homeMatch[1] : `/${appleId.split('@')[0]}/calendars/`;
    } else {
      calendarPath = `/${appleId.split('@')[0]}/calendars/`;
    }

    // Step 3: Build ICS content
    function pad(n) { return String(n).padStart(2, '0'); }
    const startDT = new Date(`${iso}T${time}:00`);
    const endDT   = new Date(startDT.getTime() + 60 * 60000);

    function icsDate(d) {
      return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    }

    const uid  = `planwith-${Date.now()}-${Math.random().toString(36).slice(2)}@planwith`;
    const now  = new Date().toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
    const icsBody = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//planwith//DE',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;TZID=Europe/Berlin:${icsDate(startDT)}`,
      `DTEND;TZID=Europe/Berlin:${icsDate(endDT)}`,
      `SUMMARY:${title} 🫶`,
      `DESCRIPTION:Gebucht von ${guestName}. Organisiert via planwith.${desc ? ' ' + desc : ''}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Erinnerung',
      'TRIGGER:-PT60M',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Step 4: PUT event to CalDAV
    const putUrl = `${davBase}${calendarPath}${uid}.ics`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'Authorization':  authHeader,
        'Content-Type':   'text/calendar; charset=utf-8',
        'If-None-Match':  '*'
      },
      body: icsBody
    });

    if (putRes.ok || putRes.status === 201 || putRes.status === 204) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ success: true, uid })
      };
    } else {
      const errText = await putRes.text();
      throw new Error(`CalDAV PUT failed (${putRes.status}): ${errText.slice(0, 200)}`);
    }

  } catch (err) {
    console.error('Apple CalDAV error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
