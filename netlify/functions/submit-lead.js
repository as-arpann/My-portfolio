// netlify/functions/submit-lead.js
//
// This runs on Netlify's server, NOT in the visitor's browser — so the
// Discord webhook URL below (read from an environment variable) is never
// exposed in page source or DevTools, unlike the old client-side version.
//
// Setup (one-time):
//   1. Netlify dashboard -> Site configuration -> Environment variables
//   2. Add a variable named DISCORD_WEBHOOK_URL with your webhook URL as the value
//   3. Redeploy the site
//
// If you ever suspect the OLD exposed webhook URL was abused, generate a new
// one in Discord (Channel Settings -> Integrations -> Webhooks -> regenerate)
// and update the environment variable — the old URL stops working instantly.

// Very small in-memory rate limiter. Note: this resets whenever Netlify spins
// up a fresh function instance, so it's a light speed bump against spam, not
// a hard guarantee. For real protection at scale, add a proper service
// (Netlify's own rate-limiting, Cloudflare Turnstile, or similar) later.
const recentSubmissions = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 submission per IP per minute
const MAX_FIELD_LENGTH = 1000;

function isRateLimited(ip) {
    const now = Date.now();
    const last = recentSubmissions.get(ip);
    if (last && now - last < RATE_LIMIT_WINDOW_MS) return true;
    recentSubmissions.set(ip, now);
    // keep the map small
    if (recentSubmissions.size > 500) {
        const cutoff = now - RATE_LIMIT_WINDOW_MS;
        for (const [key, ts] of recentSubmissions) {
            if (ts < cutoff) recentSubmissions.delete(key);
        }
    }
    return false;
}

function clean(value) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, MAX_FIELD_LENGTH);
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
        console.error('DISCORD_WEBHOOK_URL environment variable is not set.');
        return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured.' }) };
    }

    const ip =
        event.headers['x-nf-client-connection-ip'] ||
        (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        'unknown';

    if (isRateLimited(ip)) {
        // Return 200 so bots don't learn anything from the response,
        // but we simply don't forward it to Discord.
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    let data;
    try {
        data = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
    }

    const name = clean(data.name);
    const contactInfo = clean(data.contactInfo);
    const message = clean(data.message);
    const bizType = clean(data.bizType) || 'Not specified';
    const budget = clean(data.budget) || 'Not specified';

    if (!name || !contactInfo || !message) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
    }

    const payload = {
        username: 'Portfolio Lead Bot',
        embeds: [
            {
                title: '🚀 New Client Inquiry Received!',
                color: 3891199,
                fields: [
                    { name: '👤 Client/Shop Name', value: name, inline: true },
                    { name: '📞 Contact Info', value: contactInfo, inline: true },
                    { name: '🏪 Business Type', value: bizType, inline: true },
                    { name: '💰 Budget in Mind', value: budget, inline: true },
                    { name: '📝 Project Details', value: message }
                ],
                footer: { text: "Generated from Arpan's Local Business Portfolio" },
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error('Discord webhook responded with', response.status);
            return { statusCode: 502, body: JSON.stringify({ error: 'Could not deliver message.' }) };
        }

        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (err) {
        console.error('Error forwarding lead to Discord:', err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not deliver message.' }) };
    }
};
