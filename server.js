const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.VERCEL ? '/tmp/data' : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'analytics.json');

// Ensure data directory exists
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {}

// -------------------------------------------------------------
// Database Layer (Zero-Dependency JSON Datastore with In-Memory Cache)
// -------------------------------------------------------------
let db = {
  visitors: {},
  sessions: {},
  events: [],
  loginAttempts: []
};

// Load existing database from disk if available
try {
  if (fs.existsSync(DB_FILE)) {
    const rawData = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(rawData);
    if (!db.visitors) db.visitors = {};
    if (!db.sessions) db.sessions = {};
    if (!db.events) db.events = [];
    if (!db.loginAttempts) db.loginAttempts = [];
  }
} catch (err) {
  console.error('[DB] Error loading database, initializing fresh store:', err.message);
}

let saveTimeout = null;
function persistDb() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(function() {
    try {
      const tempFile = DB_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (e) {
      console.error('[DB] Failed to persist analytics database:', e.message);
    }
  }, 200);
}

// -------------------------------------------------------------
// Admin Authentication (PBKDF2 Salted Hashing & Timing-Safe Check)
// -------------------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '3788';
const SALT_HEX = crypto.randomBytes(16).toString('hex');
const ADMIN_HASH_HEX = crypto.pbkdf2Sync(ADMIN_PASSWORD, SALT_HEX, 100000, 64, 'sha512').toString('hex');

function verifyPassword(input) {
  if (typeof input !== 'string') return false;
  try {
    const inputHash = crypto.pbkdf2Sync(input, SALT_HEX, 100000, 64, 'sha512').toString('hex');
    if (inputHash.length !== ADMIN_HASH_HEX.length) return false;
    return crypto.timingSafeEqual(Buffer.from(inputHash), Buffer.from(ADMIN_HASH_HEX));
  } catch (err) {
    return false;
  }
}

// Admin Sessions Store (token -> { createdAt, lastActive })
const adminSessions = {};
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(function(cookie) {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_session;
  if (!token || !adminSessions[token]) return false;
  const sess = adminSessions[token];
  const now = Date.now();
  if (now - sess.lastActive > SESSION_TTL_MS) {
    delete adminSessions[token];
    return false;
  }
  sess.lastActive = now;
  return true;
}

function isRateLimited(ip) {
  const tenMinsAgo = Date.now() - 10 * 60 * 1000;
  const recentFails = db.loginAttempts.filter(function(att) {
    return att.ip === ip && !att.success && att.timestamp > tenMinsAgo;
  });
  return recentFails.length >= 5;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.connection.remoteAddress || '127.0.0.1';
}

// Helper to parse JSON request body
function readJsonBody(req, callback) {
  let body = '';
  req.on('data', function(chunk) {
    body += chunk;
    if (body.length > 1e6) { // 1MB limit
      req.connection.destroy();
    }
  });
  req.on('end', function() {
    try {
      const parsed = body ? JSON.parse(body) : {};
      callback(null, parsed);
    } catch (e) {
      callback(e);
    }
  });
}

function sendJson(res, statusCode, data, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private'
  }, extraHeaders || {});
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

// -------------------------------------------------------------
// Analytics Aggregation Logic
// -------------------------------------------------------------
function getFilteredData(range) {
  const now = Date.now();
  let cutoff = 0;
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else if (range === '7d') {
    cutoff = now - 7 * 24 * 60 * 60 * 1000;
  } else if (range === '30d') {
    cutoff = now - 30 * 24 * 60 * 60 * 1000;
  }

  const filteredSessions = [];
  const sessionVisitorMap = {};
  const activeCutoff = now - 60 * 1000; // Active within last 60 seconds
  let activeUsersCount = 0;
  let totalReplyClicks = 0;
  let totalBottomClicks = 0;
  let totalDuration = 0;
  let longestDuration = 0;

  const sessionIds = Object.keys(db.sessions);
  for (let i = 0; i < sessionIds.length; i++) {
    const s = db.sessions[sessionIds[i]];
    const sTime = new Date(s.startTime).getTime();
    if (sTime >= cutoff) {
      filteredSessions.push(s);
      sessionVisitorMap[s.visitorId] = true;
      if (s.lastActivity && new Date(s.lastActivity).getTime() >= activeCutoff) {
        activeUsersCount++;
      }
      const dur = s.durationSeconds || 0;
      totalDuration += dur;
      if (dur > longestDuration) longestDuration = dur;
      if (s.replyClicks) totalReplyClicks += s.replyClicks;
      if (s.bottomClicks) totalBottomClicks += s.bottomClicks;
    }
  }

  const totalVisits = filteredSessions.length;
  const uniqueVisitors = Object.keys(sessionVisitorMap).length;
  
  // Returning visitors count: visitors with > 1 total sessions
  let returningVisitors = 0;
  Object.keys(sessionVisitorMap).forEach(function(vId) {
    if (db.visitors[vId] && db.visitors[vId].totalSessions > 1) {
      returningVisitors++;
    }
  });

  const avgDuration = totalVisits > 0 ? Math.round(totalDuration / totalVisits) : 0;

  // Device Breakdown
  const deviceCounts = { Desktop: 0, Mobile: 0, Tablet: 0 };
  filteredSessions.forEach(function(s) {
    const dev = s.deviceType || 'Desktop';
    if (deviceCounts[dev] !== undefined) {
      deviceCounts[dev]++;
    } else {
      deviceCounts.Desktop++;
    }
  });
  const devicePercentages = {};
  ['Desktop', 'Mobile', 'Tablet'].forEach(function(d) {
    devicePercentages[d] = totalVisits > 0 ? Math.round((deviceCounts[d] / totalVisits) * 100) : 0;
  });

  // Daily visit trend (last 7 days or matching range)
  const daysTrend = {};
  const numDays = range === '30d' ? 30 : 7;
  for (let d = numDays - 1; d >= 0; d--) {
    const dt = new Date(now - d * 24 * 60 * 60 * 1000);
    const dateKey = dt.toISOString().slice(0, 10);
    daysTrend[dateKey] = 0;
  }
  filteredSessions.forEach(function(s) {
    const dateKey = s.startTime.slice(0, 10);
    if (daysTrend[dateKey] !== undefined) {
      daysTrend[dateKey]++;
    }
  });
  const trendList = Object.keys(daysTrend).map(function(k) {
    const parts = k.split('-');
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = mNames[parseInt(parts[1], 10) - 1];
    return {
      date: k,
      label: month + ' ' + parseInt(parts[2], 10),
      visits: daysTrend[k]
    };
  });

  // Recent Sessions list (sorted desc by start time, up to 30)
  const recentSessions = filteredSessions.slice().sort(function(a, b) {
    return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
  }).slice(0, 30).map(function(s) {
    const isOnline = s.lastActivity && (new Date(s.lastActivity).getTime() >= activeCutoff);
    const maskedVid = 'vis_' + (s.visitorId ? s.visitorId.slice(-4) : 'anon');
    return {
      sessionId: s.sessionId,
      visitorId: maskedVid,
      deviceType: s.deviceType || 'Desktop',
      startTime: s.startTime,
      durationSeconds: s.durationSeconds || 0,
      eventsCount: s.eventsCount || 0,
      replyClicks: s.replyClicks || 0,
      isOnline: !!isOnline
    };
  });

  // Filter events within cutoff & return latest 40
  const filteredEvents = db.events.filter(function(ev) {
    return new Date(ev.timestamp).getTime() >= cutoff;
  }).slice(-40).reverse().map(function(ev) {
    const maskedVid = 'vis_' + (ev.visitorId ? ev.visitorId.slice(-4) : 'anon');
    return {
      id: ev.id,
      timestamp: ev.timestamp,
      eventType: ev.eventType,
      metadata: ev.metadata,
      visitorId: maskedVid,
      deviceType: ev.deviceType || 'Desktop'
    };
  });

  return {
    overview: {
      totalVisits: totalVisits,
      uniqueVisitors: uniqueVisitors,
      returningVisitors: returningVisitors,
      activeUsers: activeUsersCount,
      avgSessionDuration: avgDuration,
      longestSessionDuration: longestDuration,
      totalReplyClicks: totalReplyClicks,
      totalBottomClicks: totalBottomClicks
    },
    trend: trendList,
    devices: {
      counts: deviceCounts,
      percentages: devicePercentages
    },
    sessions: recentSessions,
    events: filteredEvents
  };
}

function getSessionDetail(sessionId) {
  const s = db.sessions[sessionId] || {
    sessionId: sessionId,
    visitorId: 'unknown',
    startTime: new Date().toISOString(),
    durationSeconds: 0,
    deviceType: 'Desktop'
  };

  const activeCutoff = Date.now() - 60 * 1000;
  const isOnline = s.lastActivity && (new Date(s.lastActivity).getTime() >= activeCutoff);
  const maskedVid = 'vis_' + (s.visitorId ? s.visitorId.slice(-4) : 'anon');

  const events = db.events.filter(function(e) {
    return e.sessionId === sessionId;
  }).sort(function(a, b) {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  const buttonClicks = {};
  const sectionDwell = {
    'Front Page (Month Gate)': 0,
    'Intro Story (4 Slides)': 0,
    'Lamp & Balloons': 0,
    'Cake & Candles': 0,
    'Memory Photos': 0,
    'Birthday Games': 0,
    'Apology Section': 0,
    'Outro & Replay': 0
  };

  const monthGate = {
    wrongAttempts: 0,
    wrongMonths: [],
    correctSelected: false,
    correctMonth: 'October',
    dwellSec: 0
  };

  const music = {
    totalPlayDurationSec: 0,
    playCount: 0,
    completedOnce: false
  };

  const scrollAnimation = {
    activeDurationSec: 0,
    finishTimeSec: 0,
    restartsCount: 0,
    finished: false
  };

  const lampBalloons = {
    popDelays: [],
    allPopped: false
  };

  const cake = {
    dwellBeforeBlowSec: 0,
    candlesBlown: false
  };

  const photos = {
    dwellTimes: {
      'Photo 1': 0,
      'Photo 2': 0,
      'Photo 3': 0,
      'Photo 4': 0,
      'Photo 5': 0,
      'Chat Screenshot': 0
    },
    tapCounts: {
      'Photo 1': 0,
      'Photo 2': 0,
      'Photo 3': 0,
      'Photo 4': 0,
      'Photo 5': 0,
      'Chat Screenshot': 0
    }
  };

  const game = {
    totalDurationSec: 0,
    playCount: 0,
    lockButtonClicks: 0,
    scores: {
      g1Player: 0,
      g1Shubham: 0,
      g2Player: 0,
      g2Shubham: 0,
      g3Player: 0,
      g3Shubham: 0
    }
  };

  const apology = {
    dwellSec: 0,
    screenshotViewed: false
  };

  const replay = {
    clicks: 0
  };

  // Reconcile and calculate metrics from chronological events
  events.forEach(function(ev) {
    const meta = ev.metadata || {};
    const type = ev.eventType;

    if (type === 'button_click') {
      const btn = meta.button || 'Button';
      buttonClicks[btn] = (buttonClicks[btn] || 0) + 1;
    } else if (type === 'reply_click') {
      replay.clicks = (replay.clicks || 0) + 1;
      buttonClicks['replayButton'] = (buttonClicks['replayButton'] || 0) + 1;
    } else if (type === 'bottom_button_click') {
      const btn = meta.button || 'Bottom Action';
      buttonClicks[btn] = (buttonClicks[btn] || 0) + 1;
    } else if (type === 'section_dwell') {
      const sec = meta.section || 'General';
      sectionDwell[sec] = (sectionDwell[sec] || 0) + (meta.dwellSec || 0);
      if (sec === 'Front Page (Month Gate)') monthGate.dwellSec = (monthGate.dwellSec || 0) + (meta.dwellSec || 0);
      if (sec === 'Apology Section') apology.dwellSec = (apology.dwellSec || 0) + (meta.dwellSec || 0);
    } else if (type === 'month_selection') {
      if (!meta.isCorrect) {
        monthGate.wrongAttempts = (monthGate.wrongAttempts || 0) + 1;
        if (meta.month && monthGate.wrongMonths.indexOf(meta.month) === -1) {
          monthGate.wrongMonths.push(meta.month);
        }
      } else {
        monthGate.correctSelected = true;
      }
    } else if (type === 'music_update') {
      if (meta.totalPlayDurationSec !== undefined) music.totalPlayDurationSec = Math.max(music.totalPlayDurationSec, meta.totalPlayDurationSec);
      if (meta.playCount !== undefined) music.playCount = Math.max(music.playCount, meta.playCount);
      if (meta.completedOnce) music.completedOnce = true;
    } else if (type === 'music_play') {
      music.playCount = (music.playCount || 0) + 1;
    } else if (type === 'scroll_update') {
      if (meta.activeDurationSec !== undefined) scrollAnimation.activeDurationSec = Math.max(scrollAnimation.activeDurationSec, meta.activeDurationSec);
      if (meta.finishTimeSec !== undefined) {
        scrollAnimation.finishTimeSec = meta.finishTimeSec;
        scrollAnimation.finished = true;
      }
      if (meta.restartsCount !== undefined) scrollAnimation.restartsCount = (scrollAnimation.restartsCount || 0) + meta.restartsCount;
    } else if (type === 'lamp_balloon_pop') {
      const exists = lampBalloons.popDelays.some(function(p) { return p.balloon === meta.balloonIndex; });
      if (!exists) {
        lampBalloons.popDelays.push({
          balloon: meta.balloonIndex,
          delayFromLampSec: meta.delayFromLampSec || 0,
          delayFromPrevPopSec: meta.delayFromPrevPopSec || 0,
          timestamp: ev.timestamp
        });
      }
      if (lampBalloons.popDelays.length >= 4) lampBalloons.allPopped = true;
    } else if (type === 'cake_candles_blown') {
      cake.dwellBeforeBlowSec = meta.dwellBeforeBlowSec || 0;
      cake.candlesBlown = true;
    } else if (type === 'photo_dwell') {
      const p = meta.photo || 'Photo';
      photos.dwellTimes[p] = (photos.dwellTimes[p] || 0) + (meta.dwellSec || 0);
    } else if (type === 'photo_tap') {
      const p = meta.photo || 'Photo';
      photos.tapCounts[p] = (photos.tapCounts[p] || 0) + 1;
      buttonClicks['Tap: ' + p] = (buttonClicks['Tap: ' + p] || 0) + 1;
    } else if (type === 'game_update') {
      if (meta.durationSec) game.totalDurationSec = (game.totalDurationSec || 0) + meta.durationSec;
      if (meta.playCount) game.playCount = (game.playCount || 0) + meta.playCount;
      if (meta.lockButtonClicks) game.lockButtonClicks = (game.lockButtonClicks || 0) + meta.lockButtonClicks;
      if (meta.scores) game.scores = Object.assign(game.scores, meta.scores);
    } else if (type === 'game_lock_click') {
      game.lockButtonClicks = (game.lockButtonClicks || 0) + 1;
      buttonClicks['gameLockBtn'] = (buttonClicks['gameLockBtn'] || 0) + 1;
    } else if (type === 'apology_dwell') {
      apology.dwellSec = (apology.dwellSec || 0) + (meta.dwellSec || 0);
      apology.screenshotViewed = true;
    }
  });

  return {
    session: {
      sessionId: s.sessionId,
      visitorId: maskedVid,
      rawVisitorId: s.visitorId,
      deviceType: s.deviceType || 'Desktop',
      startTime: s.startTime,
      lastActivity: s.lastActivity || s.startTime,
      durationSeconds: s.durationSeconds || 0,
      eventsCount: events.length || s.eventsCount || 0,
      isOnline: !!isOnline
    },
    analytics: {
      buttonClicks: buttonClicks,
      sectionDwell: sectionDwell,
      monthGate: monthGate,
      music: music,
      scrollAnimation: scrollAnimation,
      lampBalloons: lampBalloons,
      cake: cake,
      photos: photos,
      game: game,
      apology: apology,
      replay: replay
    },
    events: events.map(function(ev) {
      return {
        id: ev.id,
        timestamp: ev.timestamp,
        eventType: ev.eventType,
        metadata: ev.metadata
      };
    })
  };
}

// -------------------------------------------------------------
// HTTP Request Router & Static File Handler
// -------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg'
};

function requestHandler(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const ip = getClientIp(req);

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // -----------------------------------------------------------
  // 1. PUBLIC ANALYTICS TRACKING APIS
  // -----------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/track/event') {
    readJsonBody(req, function(err, payload) {
      if (err || !payload) {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
      }

      const visitorId = String(payload.visitorId || '').slice(0, 64);
      const sessionId = String(payload.sessionId || '').slice(0, 64);
      const eventType = String(payload.eventType || '').slice(0, 64);
      const deviceType = payload.deviceType === 'Mobile' || payload.deviceType === 'Tablet' ? payload.deviceType : 'Desktop';
      const metadata = payload.metadata || {};
      const nowIso = new Date().toISOString();

      if (!visitorId || !sessionId || !eventType) {
        return sendJson(res, 400, { ok: false, error: 'Missing required fields' });
      }

      // Upsert visitor
      if (!db.visitors[visitorId]) {
        db.visitors[visitorId] = {
          visitorId: visitorId,
          firstSeen: nowIso,
          lastSeen: nowIso,
          totalSessions: 1,
          deviceType: deviceType
        };
      } else {
        db.visitors[visitorId].lastSeen = nowIso;
        db.visitors[visitorId].deviceType = deviceType;
      }

      // Upsert session
      if (!db.sessions[sessionId]) {
        db.sessions[sessionId] = {
          sessionId: sessionId,
          visitorId: visitorId,
          deviceType: deviceType,
          startTime: nowIso,
          lastActivity: nowIso,
          durationSeconds: 0,
          eventsCount: 1,
          replyClicks: eventType === 'reply_click' ? 1 : 0,
          bottomClicks: eventType === 'bottom_button_click' ? 1 : 0
        };
      } else {
        const s = db.sessions[sessionId];
        s.lastActivity = nowIso;
        s.eventsCount = (s.eventsCount || 0) + 1;
        const dur = Math.max(0, Math.floor((new Date(nowIso).getTime() - new Date(s.startTime).getTime()) / 1000));
        s.durationSeconds = dur;
        if (eventType === 'reply_click') {
          s.replyClicks = (s.replyClicks || 0) + 1;
        }
        if (eventType === 'bottom_button_click') {
          s.bottomClicks = (s.bottomClicks || 0) + 1;
        }
      }

      // Append event
      const evId = 'ev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      db.events.push({
        id: evId,
        sessionId: sessionId,
        visitorId: visitorId,
        eventType: eventType,
        metadata: metadata,
        deviceType: deviceType,
        timestamp: nowIso
      });

      // Keep events bounded to prevent unbounded memory growth (keep last 5000 events)
      if (db.events.length > 5000) {
        db.events = db.events.slice(-5000);
      }

      persistDb();
      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/track/heartbeat') {
    readJsonBody(req, function(err, payload) {
      if (err || !payload) {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
      }

      const visitorId = String(payload.visitorId || '').slice(0, 64);
      const sessionId = String(payload.sessionId || '').slice(0, 64);
      const deviceType = payload.deviceType === 'Mobile' || payload.deviceType === 'Tablet' ? payload.deviceType : 'Desktop';
      const nowIso = new Date().toISOString();

      if (!visitorId || !sessionId) {
        return sendJson(res, 400, { ok: false, error: 'Missing IDs' });
      }

      if (db.visitors[visitorId]) {
        db.visitors[visitorId].lastSeen = nowIso;
      }
      if (db.sessions[sessionId]) {
        const s = db.sessions[sessionId];
        s.lastActivity = nowIso;
        s.deviceType = deviceType;
        const dur = Math.max(0, Math.floor((new Date(nowIso).getTime() - new Date(s.startTime).getTime()) / 1000));
        s.durationSeconds = dur;
      }

      persistDb();
      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  // -----------------------------------------------------------
  // 2. ADMIN AUTHENTICATION APIS
  // -----------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    // Check rate limit
    if (isRateLimited(ip)) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Too many failed login attempts. Please wait 10 minutes.'
      });
    }

    readJsonBody(req, function(err, payload) {
      if (err || !payload || typeof payload.password !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'Invalid request' });
      }

      const inputPassword = payload.password;
      const isMatch = verifyPassword(inputPassword);

      if (!isMatch) {
        db.loginAttempts.push({
          ip: ip,
          timestamp: Date.now(),
          success: false
        });
        persistDb();
        return sendJson(res, 401, {
          ok: false,
          error: 'Wrong password'
        });
      }

      // Successful login
      db.loginAttempts.push({
        ip: ip,
        timestamp: Date.now(),
        success: true
      });
      persistDb();

      const sessionToken = crypto.randomBytes(32).toString('hex');
      adminSessions[sessionToken] = {
        createdAt: Date.now(),
        lastActive: Date.now()
      };

      const cookieVal = 'admin_session=' + sessionToken + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200';
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': cookieVal
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    const cookies = parseCookies(req);
    const token = cookies.admin_session;
    if (token && adminSessions[token]) {
      delete adminSessions[token];
    }
    const clearCookie = 'admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': clearCookie
    });
  }

  // -----------------------------------------------------------
  // 3. PROTECTED ADMIN ANALYTICS APIS
  // -----------------------------------------------------------
  if (pathname.indexOf('/api/admin/') === 0) {
    if (!isAuthenticated(req)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    const range = parsedUrl.query.range || 'all';

    if (pathname === '/api/admin/analytics/all') {
      const data = getFilteredData(range);
      return sendJson(res, 200, { ok: true, data: data });
    }

    if (pathname === '/api/admin/analytics/overview') {
      const data = getFilteredData(range);
      return sendJson(res, 200, { ok: true, data: data.overview });
    }

    if (pathname === '/api/admin/analytics/sessions') {
      const data = getFilteredData(range);
      return sendJson(res, 200, { ok: true, data: data.sessions });
    }

    if (pathname === '/api/admin/analytics/devices') {
      const data = getFilteredData(range);
      return sendJson(res, 200, { ok: true, data: data.devices });
    }

    if (pathname === '/api/admin/analytics/events') {
      const data = getFilteredData(range);
      return sendJson(res, 200, { ok: true, data: data.events });
    }

    if (pathname === '/api/admin/analytics/active-users') {
      const data = getFilteredData('all');
      return sendJson(res, 200, { ok: true, activeUsers: data.overview.activeUsers });
    }

    if (pathname === '/api/admin/analytics/session') {
      const sessionId = parsedUrl.query.id;
      if (!sessionId) {
        return sendJson(res, 400, { ok: false, error: 'Missing session ID' });
      }
      const detail = getSessionDetail(sessionId);
      return sendJson(res, 200, { ok: true, data: detail });
    }

    return sendJson(res, 404, { ok: false, error: 'Endpoint not found' });
  }

  // -----------------------------------------------------------
  // 4. STATIC FILE SERVING
  // -----------------------------------------------------------
  let reqPath = decodeURI(pathname);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.join(__dirname, reqPath);

  // Prevent directory traversal
  if (path.relative(__dirname, filePath).indexOf('..') !== -1) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, function() {
    console.log('Server running on http://localhost:' + PORT);
  });
}

module.exports = requestHandler;
