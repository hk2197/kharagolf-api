/**
 * Comprehensive demo data seed for KHARAGOLF Enterprise
 * Usage: DATABASE_URL=... node scripts/seed-demo.mjs
 */

import pg from 'pg';
import bcryptjs from 'bcryptjs';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function today(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d;
}
function fmt(d) { return d.toISOString(); }

// Valid enum values from schema
// member_subscription_status: active, past_due, cancelled, expired, pending
// tournament_format: stroke_play, net_stroke, best_ball, scramble, skins, match_play, stableford, shamble
// league_format: stableford, stroke_play, net_stroke, match_play, bogey, eclectic, foursomes, greensomes, texas_scramble, waltz, alliance, better_ball, order_of_merit, shamble
// tee_box: blue, white, red, gold, black

const PASSWORD_HASH = await bcryptjs.hash('Golf@2026', 10);
const ORG_ID = 1;

console.log('🌱 Starting comprehensive demo seed...\n');
console.log('  Demo password for all new accounts: Golf@2026\n');

// ─────────────────────── 0. ORGANIZATION & ADMIN ──────────────────────
console.log('🏢 Seeding organization...');
const [existingOrg] = await q(`SELECT id FROM organizations WHERE id = $1`, [ORG_ID]);
if (!existingOrg) {
  await q(
    `INSERT INTO organizations (id, name, slug, subscription_tier, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    [ORG_ID, 'KharaGolf Club', 'kharagolf', 'enterprise', true]
  );
  console.log('  ✓ Organization created');
} else {
  console.log('  ✓ Organization already exists');
}

console.log('👑 Seeding admin user...');
const [existingAdmin] = await q(`SELECT id FROM app_users WHERE email = 'admin@kharagolf.com'`);
if (!existingAdmin) {
  const adminLocalId = `ep_admin_${Math.random().toString(36).slice(2, 12)}`;
  const [adminRow] = await q(
    `INSERT INTO app_users (replit_user_id, username, email, display_name, role, password_hash, email_verified, organization_id)
     VALUES ($1, $2, $3, $4, 'super_admin', $5, true, $6) RETURNING id`,
    [adminLocalId, 'admin', 'admin@kharagolf.com', 'System Admin', PASSWORD_HASH, ORG_ID]
  );
  await q(`INSERT INTO org_memberships (organization_id, user_id, role) VALUES ($1, $2, 'org_admin') ON CONFLICT DO NOTHING`, [ORG_ID, adminRow.id]);
  console.log('  ✓ Admin user created (admin@kharagolf.com / Golf@2026)');
} else {
  console.log('  ✓ Admin user already exists');
}

// ─────────────────────── 1. COURSES ──────────────────────────────────

console.log('📍 Seeding courses...');
const coursesData = [
  { name: 'JSW Vijaynagar Golf Club',   location: 'Vijaynagar, Karnataka',   holes: 18, par: 72, rating: 71.8, slope: 128, yardage: 6850 },
  { name: 'Royal Calcutta Golf Club',   location: 'Kolkata, West Bengal',     holes: 18, par: 72, rating: 72.4, slope: 132, yardage: 6920 },
  { name: 'DLF Golf & Country Club',    location: 'Gurugram, Haryana',        holes: 18, par: 72, rating: 73.1, slope: 136, yardage: 7200 },
  { name: 'Tollygunge Club',            location: 'Kolkata, West Bengal',     holes: 18, par: 70, rating: 68.9, slope: 119, yardage: 6120 },
  { name: 'ITC Classic Golf Resort',    location: 'Manesar, Haryana',         holes: 18, par: 72, rating: 72.0, slope: 130, yardage: 6980 },
  { name: 'Poona Club Golf Course',     location: 'Pune, Maharashtra',        holes: 18, par: 71, rating: 70.5, slope: 124, yardage: 6450 },
  { name: 'Kalhaar Blues & Greens',     location: 'Ahmedabad, Gujarat',       holes: 18, par: 72, rating: 71.2, slope: 127, yardage: 6780 },
  { name: 'Eagleton Golf Resort',       location: 'Bengaluru, Karnataka',     holes: 18, par: 72, rating: 71.6, slope: 129, yardage: 6800 },
];

function slugify(str) { return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

const courseIds = [];
const [pb] = await q(`SELECT id FROM courses WHERE name = 'Pebble Beach Golf Links'`);
if (pb) courseIds.push(pb.id);

for (const c of coursesData) {
  const [existing] = await q(`SELECT id FROM courses WHERE name = $1`, [c.name]);
  if (existing) {
    courseIds.push(existing.id);
  } else {
    const [row] = await q(
      `INSERT INTO courses (organization_id, name, slug, location, holes, par, rating, slope, yardage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [ORG_ID, c.name, slugify(c.name), c.location, c.holes, c.par, c.rating, c.slope, c.yardage]
    );
    courseIds.push(row.id);
  }
}
console.log(`  ✓ ${courseIds.length} courses ready`);

// ────────────────── 2. MEMBERSHIP TIERS ─────────────────────────────

console.log('🏅 Seeding membership tiers...');
const tiersData = [
  { name: 'Platinum', description: 'Unlimited access, priority bookings, pro-shop credit, complimentary guest rounds', annual_fee: 75000, grace: 30 },
  { name: 'Gold',     description: '48 rounds per year, guest privileges, two coaching sessions included',               annual_fee: 45000, grace: 21 },
  { name: 'Silver',   description: '24 rounds per year, locker access, 10% pro-shop discount',                          annual_fee: 25000, grace: 14 },
  { name: 'Corporate',description: 'Block of 5 memberships, boardroom access, branded event naming rights',              annual_fee: 200000,grace: 30 },
  { name: 'Junior',   description: 'Under-25: 12 rounds/year, junior coaching programme, handicap registration',         annual_fee: 12000, grace: 14 },
  { name: 'Senior',   description: 'Over-60: off-peak unlimited access, social membership benefits',                     annual_fee: 18000, grace: 21 },
];

const tierIds = {};
for (const t of tiersData) {
  const [ex] = await q(`SELECT id FROM membership_tiers WHERE organization_id=$1 AND name=$2`, [ORG_ID, t.name]);
  if (ex) { tierIds[t.name] = ex.id; }
  else {
    const [row] = await q(
      `INSERT INTO membership_tiers (organization_id, name, description, annual_fee, currency, grace_period_days, is_active, billing_period)
       VALUES ($1,$2,$3,$4,'INR',$5,true,'annual') RETURNING id`,
      [ORG_ID, t.name, t.description, t.annual_fee, t.grace]
    );
    tierIds[t.name] = row.id;
  }
}
console.log(`  ✓ ${Object.keys(tierIds).length} membership tiers`);

// ──────────────────── 3. APP USERS ─────────────────────────────────

console.log('👤 Seeding player accounts...');
const playersProfiles = [
  { first: 'Arjun',    last: 'Sharma',          email: 'arjun.sharma@demo.com',         hcp: 8.4 },
  { first: 'Priya',    last: 'Kapoor',           email: 'priya.kapoor@demo.com',          hcp: 14.2 },
  { first: 'Rahul',    last: 'Mehta',            email: 'rahul.mehta@demo.com',           hcp: 5.1 },
  { first: 'Deepika',  last: 'Singh',            email: 'deepika.singh@demo.com',         hcp: 18.7 },
  { first: 'Vikram',   last: 'Nair',             email: 'vikram.nair@demo.com',           hcp: 2.3 },
  { first: 'Ananya',   last: 'Patel',            email: 'ananya.patel@demo.com',          hcp: 11.5 },
  { first: 'Rohan',    last: 'Joshi',            email: 'rohan.joshi@demo.com',           hcp: 6.8 },
  { first: 'Kavya',    last: 'Reddy',            email: 'kavya.reddy@demo.com',           hcp: 16.3 },
  { first: 'Aditya',   last: 'Kumar',            email: 'aditya.kumar@demo.com',          hcp: 3.9 },
  { first: 'Neha',     last: 'Gupta',            email: 'neha.gupta@demo.com',            hcp: 22.1 },
  { first: 'Sanjay',   last: 'Malhotra',         email: 'sanjay.malhotra@demo.com',       hcp: 12.0 },
  { first: 'Pooja',    last: 'Iyer',             email: 'pooja.iyer@demo.com',            hcp: 9.6 },
  { first: 'Amit',     last: 'Bose',             email: 'amit.bose@demo.com',             hcp: 7.2 },
  { first: 'Shreya',   last: 'Pillai',           email: 'shreya.pillai@demo.com',         hcp: 13.4 },
  { first: 'Karan',    last: 'Shah',             email: 'karan.shah@demo.com',            hcp: 4.7 },
  { first: 'Divya',    last: 'Verma',            email: 'divya.verma@demo.com',           hcp: 19.8 },
  { first: 'Suresh',   last: 'Rao',              email: 'suresh.rao@demo.com',            hcp: 1.2 },
  { first: 'Meera',    last: 'Nambiar',          email: 'meera.nambiar@demo.com',         hcp: 10.9 },
  { first: 'Prakash',  last: 'Choudhary',        email: 'prakash.choudhary@demo.com',     hcp: 15.6 },
  { first: 'Anjali',   last: 'Saxena',           email: 'anjali.saxena@demo.com',         hcp: 24.0 },
  { first: 'Rajesh',   last: 'Khanna',           email: 'rajesh.khanna@demo.com',         hcp: 0.8 },
  { first: 'Sunita',   last: 'Agarwal',          email: 'sunita.agarwal@demo.com',        hcp: 17.3 },
  { first: 'Vinod',    last: 'Tiwari',           email: 'vinod.tiwari@demo.com',          hcp: 11.1 },
  { first: 'Geeta',    last: 'Chatterjee',       email: 'geeta.chatterjee@demo.com',      hcp: 20.5 },
  { first: 'Mohan',    last: 'Das',              email: 'mohan.das@demo.com',             hcp: 6.3 },
  { first: 'Ritu',     last: 'Singhania',        email: 'ritu.singhania@demo.com',        hcp: 8.9 },
  { first: 'Harish',   last: 'Bhatt',            email: 'harish.bhatt@demo.com',          hcp: 3.5 },
  { first: 'Swati',    last: 'Jain',             email: 'swati.jain@demo.com',            hcp: 12.7 },
  { first: 'Neeraj',   last: 'Pandey',           email: 'neeraj.pandey@demo.com',         hcp: 7.6 },
  { first: 'Kavita',   last: 'Srivastava',       email: 'kavita.srivastava@demo.com',     hcp: 15.0 },
];

const userMap = {};
for (const p of playersProfiles) {
  const [ex] = await q(`SELECT id FROM app_users WHERE email=$1`, [p.email]);
  let uid;
  if (ex) {
    uid = ex.id;
  } else {
    const localId = `ep_${Math.random().toString(36).slice(2, 12)}`;
    const [row] = await q(
      `INSERT INTO app_users (replit_user_id, username, email, display_name, role, password_hash, email_verified, organization_id)
       VALUES ($1,$2,$3,$4,'player',$5,true,$6) RETURNING id`,
      [localId, p.email.split('@')[0], p.email, `${p.first} ${p.last}`, PASSWORD_HASH, ORG_ID]
    );
    uid = row.id;
    await q(
      `INSERT INTO org_memberships (organization_id, user_id, role) VALUES ($1,$2,'player') ON CONFLICT DO NOTHING`,
      [ORG_ID, uid]
    );
  }
  userMap[p.email] = { id: uid, ...p };
}
console.log(`  ✓ ${Object.keys(userMap).length} player accounts`);

// ──────────────────── 4. CLUB MEMBERS ─────────────────────────────────

console.log('🃏 Seeding club members...');
// Valid: active, past_due, cancelled, expired, pending
const subStatuses = ['active', 'active', 'active', 'active', 'past_due', 'cancelled', 'expired'];
const tierNamesList = Object.keys(tierIds);
let memberCount = 0;
let memberNum = 1000;

for (const [email, u] of Object.entries(userMap)) {
  const [ex] = await q(`SELECT id FROM club_members WHERE organization_id=$1 AND email=$2`, [ORG_ID, email]);
  if (!ex) {
    const tierName = pick(tierNamesList);
    const joinDays = rnd(-730, -30);
    const joinDate = today(joinDays).toISOString().split('T')[0];
    const renewalDate = today(joinDays + 365).toISOString().split('T')[0];
    await q(
      `INSERT INTO club_members (organization_id, tier_id, user_id, member_number, first_name, last_name, email, handicap_index, join_date, renewal_date, subscription_status, show_in_directory)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
      [ORG_ID, tierIds[tierName], u.id, `KGC${memberNum}`,
       u.first, u.last, email, u.hcp.toFixed(1), joinDate, renewalDate, pick(subStatuses)]
    );
    memberCount++;
    memberNum++;
  }
}

// Non-portal members (no userId)
const nonPortal = [
  { first: 'Dhruv',   last: 'Kapadia',        email: 'dhruv.kapadia@demo.com',     hcp: 9.2 },
  { first: 'Laleh',   last: 'Mirza',           email: 'laleh.mirza@demo.com',       hcp: 5.4 },
  { first: 'Brijesh', last: 'Acharya',         email: 'brijesh.acharya@demo.com',   hcp: 11.8 },
  { first: 'Tarini',  last: 'Bhat',            email: 'tarini.bhat@demo.com',       hcp: 22.3 },
  { first: 'Gopal',   last: 'Krishnamurthy',   email: 'gopal.k@demo.com',           hcp: 3.1 },
  { first: 'Shyam',   last: 'Sundar',          email: 'shyam.sundar@demo.com',      hcp: 14.5 },
  { first: 'Vidya',   last: 'Ramachandran',    email: 'vidya.rc@demo.com',          hcp: 7.8 },
  { first: 'Pavan',   last: 'Kulkarni',        email: 'pavan.kulkarni@demo.com',    hcp: 18.4 },
];
for (const m of nonPortal) {
  const [ex] = await q(`SELECT id FROM club_members WHERE organization_id=$1 AND email=$2`, [ORG_ID, m.email]);
  if (!ex) {
    const tierName = pick(tierNamesList);
    const joinDays = rnd(-500, -10);
    const joinDate = today(joinDays).toISOString().split('T')[0];
    const renewalDate = today(joinDays + 365).toISOString().split('T')[0];
    await q(
      `INSERT INTO club_members (organization_id, tier_id, member_number, first_name, last_name, email, handicap_index, join_date, renewal_date, subscription_status, show_in_directory)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
      [ORG_ID, tierIds[tierName], `KGC${memberNum}`,
       m.first, m.last, m.email, m.hcp.toFixed(1), joinDate, renewalDate, pick(['active', 'active', 'past_due'])]
    );
    memberCount++;
    memberNum++;
  }
}
console.log(`  ✓ ${memberCount} club members`);

// ──────────────────── 5. TOURNAMENTS ─────────────────────────────────

console.log('🏆 Seeding tournaments...');

function genHoleScores(hcp) {
  const pars = [4,3,5,4,4,3,5,4,4, 4,3,5,4,4,3,5,4,4];
  return pars.map(holePar => {
    let delta;
    if (hcp <= 5)       delta = pick([-1,0,0,0,1,1]);
    else if (hcp <= 12) delta = pick([0,0,1,1,1,2]);
    else if (hcp <= 20) delta = pick([0,1,1,2,2,3]);
    else                delta = pick([1,1,2,2,3,3,4]);
    return Math.max(1, holePar + delta);
  });
}

// tournament_format enum: stroke_play, net_stroke, best_ball, scramble, skins, match_play, stableford, shamble
const tournamentsToCreate = [
  { name: 'Club Championship 2025',         format: 'stroke_play', status: 'completed', sOff: -120, eOff: -119, fee: 2500, pub: true,  cIdx: 2, rounds: 2, maxP: 80 },
  { name: 'Monsoon Cup 2025',               format: 'stableford',  status: 'completed', sOff: -90,  eOff: -88,  fee: 1500, pub: true,  cIdx: 0, rounds: 1, maxP: 60 },
  { name: "President's Trophy 2025",        format: 'stroke_play', status: 'completed', sOff: -60,  eOff: -58,  fee: 3000, pub: true,  cIdx: 1, rounds: 1, maxP: 48 },
  { name: 'Winter Classic 2025',            format: 'scramble',    status: 'completed', sOff: -45,  eOff: -44,  fee: 1200, pub: true,  cIdx: 3, rounds: 1, maxP: 48 },
  { name: 'New Year Open 2026',             format: 'stroke_play', status: 'completed', sOff: -30,  eOff: -29,  fee: 2000, pub: true,  cIdx: 4, rounds: 1, maxP: 72 },
  { name: "Founder's Cup February 2026",    format: 'stableford',  status: 'completed', sOff: -20,  eOff: -19,  fee: 1800, pub: false, cIdx: 5, rounds: 1, maxP: 40, membOnly: true },
  { name: 'Spring Championship 2026',       format: 'stroke_play', status: 'active',    sOff: -5,   eOff: 2,    fee: 2500, pub: true,  cIdx: 0, rounds: 2, maxP: 80 },
  { name: 'Stableford Challenge Apr 2026',  format: 'stableford',  status: 'active',    sOff: -2,   eOff: 1,    fee: 1500, pub: false, cIdx: 4, rounds: 1, maxP: 40, membOnly: true, membFee: 1000 },
  { name: 'Summer Invitational 2026',       format: 'stroke_play', status: 'upcoming',  sOff: 20,   eOff: 21,   fee: 3500, pub: true,  cIdx: 2, rounds: 2, maxP: 64 },
  { name: 'Four-Ball Better Ball Cup',      format: 'best_ball',   status: 'upcoming',  sOff: 35,   eOff: 36,   fee: 2000, pub: false, cIdx: 5, rounds: 1, maxP: 32, membOnly: true, membFee: 1500 },
  { name: 'Independence Day Scramble',      format: 'scramble',    status: 'upcoming',  sOff: 45,   eOff: 45,   fee: 1800, pub: true,  cIdx: 6, rounds: 1, maxP: 60 },
  { name: 'Pro-Am Classic 2026',            format: 'stroke_play', status: 'upcoming',  sOff: 60,   eOff: 62,   fee: 5000, pub: true,  cIdx: 0, rounds: 3, maxP: 48 },
  { name: 'Bogey League Open Day',          format: 'stroke_play', status: 'upcoming',  sOff: 75,   eOff: 75,   fee: 1000, pub: true,  cIdx: 7, rounds: 1, maxP: 36 },
  { name: 'Greensomes Pairs Trophy',        format: 'best_ball',   status: 'draft',     sOff: 90,   eOff: 91,   fee: 3000, pub: false, cIdx: 1, rounds: 2, maxP: 40 },
  { name: 'Skins Game — Charity Cup',       format: 'skins',       status: 'upcoming',  sOff: 55,   eOff: 55,   fee: 2500, pub: true,  cIdx: 3, rounds: 1, maxP: 20 },
];

const tournamentIds = [];
for (const t of tournamentsToCreate) {
  const courseId = courseIds[t.cIdx] ?? courseIds[0];
  const [ex] = await q(`SELECT id FROM tournaments WHERE organization_id=$1 AND name=$2`, [ORG_ID, t.name]);
  if (ex) { tournamentIds.push({ id: ex.id, ...t }); continue; }
  const [row] = await q(
    `INSERT INTO tournaments (organization_id, course_id, name, format, status, start_date, end_date, entry_fee, currency, is_public, members_only, member_entry_fee, max_players, rounds, allow_spectators, self_posting, handicap_allowance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'INR',$9,$10,$11,$12,$13,true,true,100) RETURNING id`,
    [ORG_ID, courseId, t.name, t.format, t.status,
     fmt(today(t.sOff)), fmt(today(t.eOff)),
     t.fee, t.pub, t.membOnly ?? false, t.membFee ?? null, t.maxP, t.rounds]
  );
  tournamentIds.push({ id: row.id, ...t });
}
console.log(`  ✓ ${tournamentIds.length} tournaments`);

// ──────────────────── 6. PLAYERS + SCORES ─────────────────────────────

console.log('⛳ Seeding tournament players and scores...');
const teeBoxesArr = ['white', 'blue', 'red', 'white', 'white', 'gold'];
const usersArr = Object.values(userMap);
let totalPlayers = 0, totalScores = 0;

for (const t of tournamentIds) {
  if (t.status === 'draft') continue;
  const count = Math.min(rnd(14, 22), usersArr.length);
  const pool2 = [...usersArr].sort(() => Math.random() - 0.5).slice(0, count);

  for (const u of pool2) {
    const [exP] = await q(`SELECT id FROM players WHERE tournament_id=$1 AND email=$2`, [t.id, u.email]);
    let pid;
    if (exP) {
      pid = exP.id;
    } else {
      const [p] = await q(
        `INSERT INTO players (tournament_id, user_id, first_name, last_name, email, handicap_index, tee_box, payment_status, checked_in, registered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',true,NOW()) RETURNING id`,
        [t.id, u.id, u.first, u.last, u.email, u.hcp.toFixed(1), pick(teeBoxesArr)]
      );
      pid = p.id;
      totalPlayers++;
    }

    if (t.status === 'completed' || t.status === 'active') {
      const roundsToScore = t.status === 'completed' ? t.rounds : 1;
      for (let round = 1; round <= roundsToScore; round++) {
        const [exS] = await q(`SELECT id FROM scores WHERE player_id=$1 AND round=$2 LIMIT 1`, [pid, round]);
        if (!exS) {
          const holes = genHoleScores(u.hcp);
          const pars = [4,3,5,4,4,3,5,4,4, 4,3,5,4,4,3,5,4,4];
          for (let hole = 1; hole <= 18; hole++) {
            const par = pars[hole - 1];
            await q(
              `INSERT INTO scores (tournament_id, player_id, round, hole_number, strokes, putts, fairway_hit, gir_hit, is_verified, submitted_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW())`,
              [t.id, pid, round, hole, holes[hole - 1], rnd(1, 3),
               par > 3 ? Math.random() > 0.4 : null,
               Math.random() > 0.55]
            );
            totalScores++;
          }
        }
      }
    }
  }
}
console.log(`  ✓ ${totalPlayers} player entries, ${totalScores} new score records`);

// ──────────────────── 7. LEAGUES ─────────────────────────────────────

console.log('🏟️ Seeding leagues...');
// league_format enum: stableford, stroke_play, net_stroke, match_play, bogey, eclectic, foursomes, greensomes, texas_scramble, waltz, alliance, better_ball, order_of_merit, shamble
const leaguesToCreate = [
  { name: 'Monsoon Stableford Series 2026', fmt: 'stableford',   type: 'individual', status: 'active',   maxM: 40, fee: 5000, pub: true,  rounds: 8,  sOff: -30, eOff: 150 },
  { name: 'Corporate Cup League 2026',      fmt: 'stroke_play',  type: 'team',       status: 'active',   maxM: 60, fee: 8000, pub: false, rounds: 6,  sOff: -20, eOff: 160, membOnly: true },
  { name: 'Ladies Golf League 2026',        fmt: 'stableford',   type: 'individual', status: 'active',   maxM: 30, fee: 4000, pub: true,  rounds: 10, sOff: -15, eOff: 180 },
  { name: 'Junior Development League',      fmt: 'stroke_play',  type: 'individual', status: 'upcoming', maxM: 20, fee: 2000, pub: true,  rounds: 6,  sOff: 30,  eOff: 200 },
  { name: 'Weekend Warriors Series',        fmt: 'bogey',        type: 'individual', status: 'active',   maxM: 50, fee: 3000, pub: false, rounds: 12, sOff: -45, eOff: 120, membOnly: true, membFee: 2000 },
  { name: 'OOM Championship 2026',          fmt: 'order_of_merit',type: 'individual',status: 'upcoming', maxM: 80, fee: 10000,pub: true,  rounds: 10, sOff: 60,  eOff: 300 },
  { name: 'Match Play Championship 2026',   fmt: 'match_play',   type: 'individual', status: 'active',   maxM: 32, fee: 6000, pub: false, rounds: 5,  sOff: -10, eOff: 90,  membOnly: true },
  { name: 'Senior Classic Series',          fmt: 'stableford',   type: 'individual', status: 'active',   maxM: 24, fee: 3500, pub: false, rounds: 8,  sOff: -25, eOff: 130 },
  { name: 'Eclectic Trophy 2026',           fmt: 'eclectic',     type: 'individual', status: 'active',   maxM: 40, fee: 4000, pub: true,  rounds: 12, sOff: -60, eOff: 200 },
  { name: 'Alliance League Spring',         fmt: 'alliance',     type: 'individual', status: 'upcoming', maxM: 36, fee: 5000, pub: false, rounds: 8,  sOff: 25,  eOff: 180 },
];

const newLeagueIds = [];
for (const l of leaguesToCreate) {
  const courseId = pick(courseIds);
  const [ex] = await q(`SELECT id FROM leagues WHERE organization_id=$1 AND name=$2`, [ORG_ID, l.name]);
  if (ex) { newLeagueIds.push({ id: ex.id, status: l.status, rounds: l.rounds }); continue; }
  const [row] = await q(
    `INSERT INTO leagues (organization_id, course_id, name, format, type, status, max_members, entry_fee, currency, is_public, members_only, member_entry_fee, rounds_count, season_start, season_end, handicap_allowance, tiebreaker_method, points_per_win, points_per_draw, points_per_loss)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'INR',$9,$10,$11,$12,$13,$14,100,'countback',2,1,0) RETURNING id`,
    [ORG_ID, courseId, l.name, l.fmt, l.type, l.status,
     l.maxM, l.fee, l.pub, l.membOnly ?? false, l.membFee ?? null,
     l.rounds, fmt(today(l.sOff)), fmt(today(l.eOff))]
  );
  newLeagueIds.push({ id: row.id, status: l.status, rounds: l.rounds });
}

// Fetch all leagues for this org to seed members in all
const allLeagues = await q(`SELECT id, status, rounds_count FROM leagues WHERE organization_id=$1`, [ORG_ID]);
console.log(`  ✓ ${allLeagues.length} total leagues`);

// ──────────────────── 8. LEAGUE MEMBERS & STANDINGS ──────────────────

console.log('📊 Seeding league members and standings...');
let leagueMemberCount = 0;

for (const lg of allLeagues) {
  if (lg.status === 'upcoming') continue;
  const count = Math.min(rnd(10, 18), usersArr.length);
  const members = [...usersArr].sort(() => Math.random() - 0.5).slice(0, count);
  let position = 1;
  for (const u of members) {
    const [ex] = await q(`SELECT id FROM league_members WHERE league_id=$1 AND email=$2`, [lg.id, u.email]);
    if (!ex) {
      const pts = rnd(15, 110);
      const played = rnd(2, Math.min(7, lg.rounds_count ?? 6));
      const [lm] = await q(
        `INSERT INTO league_members (league_id, user_id, first_name, last_name, email, handicap_index)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [lg.id, u.id, u.first, u.last, u.email, u.hcp.toFixed(1)]
      );
      await q(
        `INSERT INTO league_standings (league_id, member_id, total_points, rounds_played, position)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [lg.id, lm.id, pts, played, position]
      );
      leagueMemberCount++;
      position++;
    }
  }
}
console.log(`  ✓ ${leagueMemberCount} league member entries`);

// ──────────────────── 9. SPONSORS ─────────────────────────────────────

console.log('💼 Seeding sponsors...');
const sponsorsData = [
  { name: 'Tata Steel',        tier: 'Title Sponsor',       website: 'https://www.tatasteel.com' },
  { name: 'JSW Group',         tier: 'Gold Sponsor',         website: 'https://www.jsw.in' },
  { name: 'Mahindra Motors',   tier: 'Gold Sponsor',         website: 'https://www.mahindra.com' },
  { name: 'Bajaj Allianz',     tier: 'Silver Sponsor',       website: 'https://www.bajajallianz.com' },
  { name: 'HDFC Bank',         tier: 'Silver Sponsor',       website: 'https://www.hdfcbank.com' },
  { name: 'Titleist India',    tier: 'Equipment Partner',    website: 'https://www.titleist.com' },
  { name: 'Callaway Golf',     tier: 'Equipment Partner',    website: 'https://www.callawaygolf.com' },
  { name: 'Sun International', tier: 'Hospitality Partner',  website: 'https://www.sunhotel.com' },
];

for (const s of sponsorsData) {
  const [ex] = await q(`SELECT id FROM sponsors WHERE organization_id=$1 AND name=$2`, [ORG_ID, s.name]);
  if (!ex) {
    try {
      await q(
        `INSERT INTO sponsors (organization_id, name, tier, website_url, is_active) VALUES ($1,$2,$3,$4,true)`,
        [ORG_ID, s.name, s.tier, s.website]
      );
    } catch(e) { console.log('  Sponsor error:', e.message.slice(0, 80)); }
  }
}
const [sCount] = await q(`SELECT COUNT(*) as cnt FROM sponsors WHERE organization_id=$1`, [ORG_ID]);
console.log(`  ✓ ${sCount.cnt} sponsors`);

// ──────────────────── 10. SHOP PRODUCTS ─────────────────────────────────

console.log('🛍️ Seeding shop products...');
// shop_products columns: base_price, markup_price, stock_count, fulfillment_type
const products = [
  { name: 'KGC Polo Shirt (M)',           desc: 'Official club polo, moisture-wicking, UV protection, embroidered crest',     base: 1499, markup: 1799 },
  { name: 'KGC Polo Shirt (L)',           desc: 'Official club polo, moisture-wicking, UV protection, embroidered crest',     base: 1499, markup: 1799 },
  { name: 'KGC Polo Shirt (XL)',          desc: 'Official club polo, moisture-wicking, UV protection, embroidered crest',     base: 1499, markup: 1799 },
  { name: 'KGC Golf Cap',                 desc: 'Structured cap with embroidered club crest — one size fits all',             base: 699,  markup: 849 },
  { name: 'KGC Golf Bag Tag',             desc: 'Premium leather bag tag with raised club logo',                              base: 299,  markup: 399 },
  { name: 'KGC Umbrella',                 desc: 'Double-canopy wind-resistant golf umbrella, 62 inch',                       base: 1299, markup: 1499 },
  { name: 'KGC Microfibre Towel',         desc: 'Premium microfibre golf towel with club monogram, waffle weave',            base: 399,  markup: 499 },
  { name: 'KGC Rain Suit',                desc: 'Waterproof windproof full suit with taped seams and club branding',         base: 3999, markup: 4499 },
  { name: 'Pro V1 Golf Balls (Dozen)',     desc: 'Titleist Pro V1 — tour performance, low spin, consistent trajectory',      base: 4500, markup: 4999 },
  { name: 'Callaway Supersoft (Dozen)',    desc: 'Low compression, super-soft feel, excellent for mid-to-high handicappers', base: 2200, markup: 2499 },
  { name: 'Club Scorecard Holder',        desc: 'Genuine leather scorecard holder with pencil pocket and clip',              base: 349,  markup: 449 },
  { name: 'Green Fee Voucher (1 Round)',   desc: 'Valid for one weekend round at any partner course in 2026',                 base: 2000, markup: 2000 },
  { name: 'Coaching Session (1 Hour)',     desc: 'One-on-one with our club PGA professional — swing analysis included',      base: 1500, markup: 1500 },
  { name: 'Annual Silver Membership',     desc: 'Silver-tier annual membership — 24 rounds, locker, 10% pro-shop discount', base: 25000,markup: 25000 },
  { name: 'Annual Gold Membership',       desc: 'Gold-tier annual membership — 48 rounds, guest passes, coaching sessions', base: 45000,markup: 45000 },
  { name: 'Tournament Entry Voucher',     desc: 'Pre-paid entry for any club tournament in 2026 — gift the game!',           base: 3000, markup: 3000 },
  { name: 'Divot Repair Tool Set',        desc: 'Stainless divot tool + magnetic ball marker with club crest',               base: 249,  markup: 349 },
  { name: 'Golf Glove (Cabretta Leather)',desc: 'Premium cabretta leather, soft grip, excellent durability',                 base: 699,  markup: 849 },
  { name: 'GPS Rangefinder Bundle',       desc: 'Laser rangefinder + carry case — legal for club competitions',              base: 12999,markup: 14999 },
  { name: 'Practice Net & Mat Combo',    desc: 'Heavy-duty impact net (8x8ft) + rubber tee mat for garden practice',       base: 4999, markup: 5499 },
];

for (const p of products) {
  const [ex] = await q(`SELECT id FROM shop_products WHERE organization_id=$1 AND name=$2`, [ORG_ID, p.name]);
  if (!ex) {
    try {
      await q(
        `INSERT INTO shop_products (organization_id, name, description, base_price, markup_price, currency, stock_count, is_active, fulfillment_type)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,true,'manual')`,
        [ORG_ID, p.name, p.desc, p.base, p.markup, rnd(10, 150)]
      );
    } catch(e) {
      try {
        await q(
          `INSERT INTO shop_products (organization_id, name, description, base_price, markup_price, currency, is_active)
           VALUES ($1,$2,$3,$4,$5,'INR',true)`,
          [ORG_ID, p.name, p.desc, p.base, p.markup]
        );
      } catch(e2) { console.log('  Product error:', e2.message.slice(0, 80)); }
    }
  }
}
const [pCount] = await q(`SELECT COUNT(*) as cnt FROM shop_products WHERE organization_id=$1`, [ORG_ID]);
console.log(`  ✓ ${pCount.cnt} shop products`);

// ──────────────────── 11. ANNOUNCEMENTS ─────────────────────────────────

console.log('📢 Seeding announcements...');
// tournament_announcements columns: id, tournament_id, body, type, author_name, sent_by_user_id, sent_at
const annData = [
  { idx: 0, body: '🏆 Championship Results — Final: Congratulations to Rajesh Khanna (net 136) on winning the Club Championship 2025! Vikram Nair takes Gross Champion with 138. Full results on the leaderboard.', type: 'info', author: 'Tournament Committee' },
  { idx: 1, body: '🏆 Monsoon Cup 2025 — Results: Competition concluded with 54 participants. Top stableford: Vikram Nair 41 pts. Runner up: Arjun Sharma 39 pts. Ladies winner: Shreya Pillai 36 pts.', type: 'info', author: 'Tournament Committee' },
  { idx: 2, body: "🏆 President's Trophy — Final Results: Rahul Mehta wins with a net 68 in round 2, clinching the trophy by 2 shots. Congratulations! Full results on the leaderboard.", type: 'info', author: 'Tournament Director' },
  { idx: 6, body: '📋 Tee Time Pairings Released: Day 1 pairings for Spring Championship 2026 are live. All players please report to the starter 30 minutes before your tee time.', type: 'info', author: 'Competition Secretary' },
  { idx: 6, body: '⚠️ Weather Update — Morning Fog Delay: Due to morning fog on the 1st tee, all tee times have been pushed back by 45 minutes. Updated pairings will be posted shortly. Please stand by.', type: 'alert', author: 'Course Management' },
  { idx: 6, body: '🎉 Prize Giving — 6:30 PM Clubhouse: Prize ceremony in the main ballroom at 6:30 PM. All finalists please attend in smart casual attire. Complimentary cocktail hour from 6:00 PM.', type: 'info', author: 'Club Manager' },
  { idx: 7, body: '📌 Stableford Scoring Reminder: Max net double bogey applies today. Any hole where you pick up must be recorded as max score. Lateral water hazard penalty on hole 4 — one stroke, replay or drop zone.', type: 'info', author: 'Competition Secretary' },
  { idx: 7, body: '🔒 Members Only Event: This event is open to club members only. If you have not yet linked your portal account to your club membership, please visit the Player Portal before teeing off.', type: 'info', author: 'Club Secretary' },
];

for (const a of annData) {
  if (a.idx >= tournamentIds.length) continue;
  const tid = tournamentIds[a.idx].id;
  const [ex] = await q(`SELECT id FROM tournament_announcements WHERE tournament_id=$1 AND body=$2`, [tid, a.body]);
  if (!ex) {
    try {
      await q(
        `INSERT INTO tournament_announcements (tournament_id, body, type, author_name)
         VALUES ($1,$2,$3,$4)`,
        [tid, a.body, a.type, a.author]
      );
    } catch(e) {
      try {
        await q(`INSERT INTO tournament_announcements (tournament_id, body) VALUES ($1,$2)`, [tid, a.body]);
      } catch(e2) { console.log('  Ann error:', e2.message.slice(0, 80)); }
    }
  }
}
const [annCount] = await q(`SELECT COUNT(*) as cnt FROM tournament_announcements`);
console.log(`  ✓ ${annCount.cnt} announcements`);

// ──────────────────── 12. PRIZE CATEGORIES ─────────────────────────────

console.log('🥇 Seeding prize categories...');
const prizes = [
  { idx: 0, name: 'Overall Champion — Gross',       desc: 'Lowest gross score across 2 rounds',          val: 20000 },
  { idx: 0, name: 'Overall Champion — Net',         desc: 'Lowest net score across 2 rounds',            val: 15000 },
  { idx: 0, name: 'Runner Up — Net',                desc: 'Second lowest net score',                     val: 10000 },
  { idx: 0, name: 'Third Place — Net',              desc: 'Third lowest net score',                      val: 6000 },
  { idx: 0, name: 'Best Gross — Ladies',            desc: 'Lowest gross score, ladies section',           val: 10000 },
  { idx: 0, name: 'Best Net — Ladies',              desc: 'Lowest net score, ladies section',             val: 8000 },
  { idx: 0, name: 'Nearest to Pin — Hole 7',        desc: 'Closest to pin, round 1 — par 3',              val: 3500 },
  { idx: 0, name: 'Nearest to Pin — Hole 14',       desc: 'Closest to pin, round 2 — par 3',              val: 3500 },
  { idx: 0, name: 'Longest Drive — Men (Hole 5)',   desc: 'Longest drive in fairway, both rounds',        val: 3000 },
  { idx: 0, name: 'Longest Drive — Ladies (Hole 14)',desc: 'Longest drive in fairway, both rounds',       val: 3000 },
  { idx: 0, name: 'Hole-in-One (Any)',               desc: 'First hole in one recorded — sponsored by Titleist', val: 50000 },
  { idx: 6, name: 'Division A Winner (HCP 0–12)',   desc: 'Lowest net, handicap 0–12',                   val: 12000 },
  { idx: 6, name: 'Division B Winner (HCP 13–20)',  desc: 'Lowest net, handicap 13–20',                  val: 10000 },
  { idx: 6, name: 'Division C Winner (HCP 21+)',    desc: 'Lowest net, handicap 21+',                    val: 8000 },
  { idx: 6, name: 'Best Front 9',                   desc: 'Lowest gross on holes 1–9',                   val: 3000 },
  { idx: 6, name: 'Best Back 9',                    desc: 'Lowest gross on holes 10–18',                 val: 3000 },
  { idx: 6, name: 'Eagle Award',                    desc: 'First eagle recorded in competition',         val: 5000 },
  { idx: 1, name: 'Highest Stableford Points',      desc: 'Most stableford points in 18 holes',          val: 8000 },
  { idx: 1, name: 'Best Front 9 Stableford',        desc: 'Most stableford points, holes 1–9',           val: 3000 },
  { idx: 1, name: 'Best Back 9 Stableford',         desc: 'Most stableford points, holes 10–18',         val: 3000 },
];

for (const pc of prizes) {
  if (pc.idx >= tournamentIds.length) continue;
  const tid = tournamentIds[pc.idx].id;
  const [ex] = await q(`SELECT id FROM prize_categories WHERE tournament_id=$1 AND name=$2`, [tid, pc.name]);
  if (!ex) {
    try {
      await q(
        `INSERT INTO prize_categories (tournament_id, name, description, prize_value, currency)
         VALUES ($1,$2,$3,$4,'INR')`,
        [tid, pc.name, pc.desc, pc.val]
      );
    } catch(e) { console.log('  Prize error:', e.message.slice(0, 80)); }
  }
}
const [prizeCount] = await q(`SELECT COUNT(*) as cnt FROM prize_categories`);
console.log(`  ✓ ${prizeCount.cnt} prize categories`);

// ──────────────────── FINAL SUMMARY ─────────────────────────────────────

console.log('\n✅ Demo seed complete!\n');
const summaryTables = [
  ['courses',                   'Courses'],
  ['membership_tiers',          'Membership Tiers'],
  ['club_members',              'Club Members'],
  ['app_users',                 'App Users (total)'],
  ['tournaments',               'Tournaments'],
  ['players',                   'Tournament Players'],
  ['scores',                    'Score Records'],
  ['leagues',                   'Leagues'],
  ['league_members',            'League Members'],
  ['league_standings',          'League Standings'],
  ['sponsors',                  'Sponsors'],
  ['shop_products',             'Shop Products'],
  ['tournament_announcements',  'Announcements'],
  ['prize_categories',          'Prize Categories'],
];
for (const [tbl, label] of summaryTables) {
  const rows = await q(`SELECT COUNT(*) as cnt FROM ${tbl}`);
  console.log(`  ${label.padEnd(25)}: ${rows[0].cnt}`);
}
console.log('\n  Admin:    mkhara@kharachemicals.com  (existing password)');
console.log('  Players:  *.demo.com accounts         Password: Golf@2026');

await pool.end();
