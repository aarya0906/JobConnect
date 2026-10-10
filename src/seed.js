import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { db, transaction, UPLOAD_DIR } from './db.js';
import { hashPassword } from './auth.js';

export const DEMO_PASSWORD = 'Demo@1234';

const daysAgo = (d, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();

/** Builds a tiny, valid one-page PDF so demo applicants have a downloadable resume. */
function tinyPdf(lines) {
  const esc = (s) => s.replace(/[()\\]/g, '');
  const stream = lines.map((l, i) => `BT /F1 ${i === 0 ? 18 : 11} Tf 72 ${720 - i * 20} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const COMPANIES = [
  {
    email: 'employer@jobconnect.demo', name: 'Aria Mendes', company: 'Northwind Labs', industry: 'Software', size: '51-200',
    website: 'https://northwind.example.com', location: 'Berlin, Germany',
    about: 'Northwind Labs builds logistics software for mid-sized shipping firms. Small teams, long-term thinking, and a habit of shipping on Fridays.'
  },
  {
    email: 'hiring@halcyon.demo', name: 'Dev Kapoor', company: 'Halcyon Health', industry: 'Healthcare', size: '201-1000',
    website: 'https://halcyon.example.com', location: 'Mumbai, India',
    about: 'Halcyon Health runs outpatient clinics and a telehealth platform serving over a million patients across western India.'
  },
  {
    email: 'talent@meridian.demo', name: 'Sofia Laurent', company: 'Meridian Capital', industry: 'Finance', size: '201-1000',
    website: 'https://meridian.example.com', location: 'London, United Kingdom',
    about: 'Meridian Capital is an independent asset manager focused on infrastructure and renewable-energy investment.'
  },
  {
    email: 'people@obsidian.demo', name: 'Marcus Webb', company: 'Obsidian Studio', industry: 'Design', size: '11-50',
    website: 'https://obsidian.example.com', location: 'Remote',
    about: 'Obsidian Studio is a fully remote product design studio. We partner with startups on brand, product and interface design.'
  },
  {
    email: 'careers@lumen.demo', name: 'Priya Nair', company: 'Lumen Learning', industry: 'Education', size: '51-200',
    website: 'https://lumen.example.com', location: 'Pune, India',
    about: 'Lumen Learning creates adaptive study tools for secondary-school students and the teachers who support them.'
  }
];

// [companyIndex, title, category, type, mode, location, currency, min, max, daysAgo, description, requirements]
const JOBS = [
  [0, 'Senior Backend Engineer', 'Engineering', 'Full-time', 'Hybrid', 'Berlin, Germany', 'EUR', 78000, 98000, 1,
    'You will own the services that route and track more than 40,000 shipments a day. The team is small, so you will shape the architecture, review designs and mentor two mid-level engineers.\n\nYour first quarter: take over our carrier-integration service, cut its p95 latency in half and write the runbook the on-call team has been asking for.',
    'Five or more years building production backend systems\nStrong with Node.js, Go or Python and PostgreSQL\nExperience with queues and event-driven design\nComfortable owning a service end to end, including on-call'],
  [0, 'Product Designer', 'Design', 'Full-time', 'Remote', 'Anywhere', 'EUR', 62000, 80000, 2,
    'Design the dispatcher and driver tools used by thousands of logistics staff every day. You will work with two engineers and a product manager, from first sketch to shipped feature.\n\nWe care about dense, fast interfaces that stay readable at 6 a.m. in a warehouse office.',
    'Portfolio showing complex, data-heavy product work\nFluent in Figma and design systems\nComfortable running quick usability sessions with real users'],
  [0, 'Customer Success Manager', 'Customer Support', 'Full-time', 'On-site', 'Berlin, Germany', 'EUR', 48000, 60000, 6,
    'Be the main contact for a portfolio of 15 shipping clients. You will onboard new accounts, run quarterly reviews and bring customer problems back to the product team with clear evidence.',
    'Two or more years in a customer-facing SaaS role\nFluent English; German is a plus\nComfortable reading dashboards and talking through data'],

  [1, 'Registered Nurse – Outpatient', 'Healthcare', 'Full-time', 'On-site', 'Mumbai, India', 'INR', 480000, 720000, 1,
    'Join our Andheri clinic team supporting daily outpatient care, patient triage and follow-up. You will work in a team of six nurses with two visiting physicians.\n\nShifts are scheduled four weeks ahead, with no more than two night shifts a month.',
    'GNM or B.Sc. Nursing with active registration\nAt least two years of clinical experience\nGood communication in English, Hindi and Marathi'],
  [1, 'Data Analyst – Patient Operations', 'Data & Analytics', 'Full-time', 'Hybrid', 'Mumbai, India', 'INR', 900000, 1400000, 3,
    'Turn clinic and telehealth data into decisions. You will build dashboards on waiting times, no-show rates and follow-up adherence, and advise clinic managers on what to change.',
    'Strong SQL and one BI tool (Power BI, Tableau or Metabase)\nExperience with Python or R for analysis\nAbility to explain findings to non-technical colleagues'],
  [1, 'Telehealth Support Associate', 'Customer Support', 'Part-time', 'Remote', 'Anywhere in India', 'INR', 240000, 360000, 8,
    'Help patients book consultations, join video calls and resolve payment questions. Part-time shifts of four hours, including weekends.',
    'Clear written and spoken English or Hindi\nPatience and a calm manner with anxious callers\nA quiet workspace and reliable internet'],

  [2, 'Investment Analyst – Infrastructure', 'Finance', 'Full-time', 'Hybrid', 'London, United Kingdom', 'GBP', 65000, 85000, 2,
    'Support the infrastructure team on due diligence, financial modelling and portfolio monitoring across European wind and solar assets.',
    'Two to four years in investment banking, advisory or infrastructure funds\nExcellent Excel modelling\nCFA progress or equivalent is welcome'],
  [2, 'Compliance Officer', 'Operations', 'Full-time', 'On-site', 'London, United Kingdom', 'GBP', 58000, 72000, 5,
    'Maintain our compliance framework, run monitoring reviews and prepare filings for the FCA. You will report to the Head of Risk.',
    'Previous compliance experience in asset management\nKnowledge of FCA rules and AML requirements\nMeticulous and calm under deadlines'],
  [2, 'Graduate Finance Intern', 'Finance', 'Internship', 'On-site', 'London, United Kingdom', 'GBP', 24000, 26000, 9,
    'A six-month placement rotating between fund accounting, reporting and investor relations. A full-time offer is made to strong performers.',
    'Final-year or recent graduate in finance, economics or accounting\nStrong analytical skills\nCurious and willing to ask questions'],

  [3, 'Brand Designer', 'Design', 'Contract', 'Remote', 'Anywhere', 'USD', 4500, 6500, 1,
    'Six-month contract designing identities, guidelines and launch material for early-stage startups. Monthly pay, flexible hours, async-first team.',
    'Strong typography and layout skills\nExperience delivering complete brand systems\nPortfolio that shows process, not just outcomes'],
  [3, 'Frontend Engineer', 'Engineering', 'Full-time', 'Remote', 'Anywhere', 'USD', 85000, 115000, 4,
    'Build the interactive prototypes and production interfaces we deliver to clients. You will work closely with designers who care about detail.',
    'Deep knowledge of HTML, CSS and TypeScript\nExperience with React or a similar framework\nAn eye for motion, spacing and accessibility'],

  [4, 'Curriculum Content Writer', 'Education', 'Full-time', 'Hybrid', 'Pune, India', 'INR', 600000, 900000, 3,
    'Write clear lessons, worked examples and practice questions for Class 9–12 mathematics and science, working with subject experts and our learning scientists.',
    'Degree in science, mathematics or education\nStrong explanatory writing\nExperience teaching or tutoring is a big plus'],
  [4, 'Growth Marketing Manager', 'Marketing', 'Full-time', 'Hybrid', 'Pune, India', 'INR', 1400000, 2000000, 5,
    'Own acquisition for our student app, from campaigns and creators to referral loops. You will manage a small budget and report on outcomes, not impressions.',
    'Four or more years in consumer growth marketing\nComfortable with attribution and funnel analysis\nExperience marketing to students or parents'],
  [4, 'Sales Executive – Schools', 'Sales', 'Full-time', 'On-site', 'Pune, India', 'INR', 420000, 700000, 7,
    'Introduce Lumen to schools across Maharashtra, run product demos and help principals plan pilots. Travel within the state is expected.',
    'One or more years of B2B or education sales\nConfident presenter\nValid driving licence']
];

const SEEKERS = [
  { email: 'seeker@jobconnect.demo', name: 'Riya Sharma', headline: 'Product designer with 5 years in logistics and fintech', location: 'Pune, India', phone: '+91 98200 11122', skills: 'Figma, Design systems, User research, Prototyping, SQL', about: 'I design operational tools that people use all day. Recently led a redesign that cut onboarding time for dispatchers by a third.' },
  { email: 'tom.becker@jobconnect.demo', name: 'Tom Becker', headline: 'Backend engineer · Node.js, Go, PostgreSQL', location: 'Berlin, Germany', phone: '', skills: 'Node.js, Go, PostgreSQL, Kafka, AWS', about: 'Seven years building reliable APIs. I enjoy on-call when the runbooks are good, and writing them when they are not.' },
  { email: 'ananya.iyer@jobconnect.demo', name: 'Ananya Iyer', headline: 'Data analyst · healthcare and public policy', location: 'Mumbai, India', phone: '', skills: 'SQL, Power BI, Python, Statistics', about: 'I like finding the one number that explains why a clinic is running late.' },
  { email: 'james.okoro@jobconnect.demo', name: 'James Okoro', headline: 'Finance graduate, CFA Level II candidate', location: 'London, United Kingdom', phone: '', skills: 'Financial modelling, Excel, Valuation, Reporting', about: 'Recent graduate with an internship at an infrastructure fund. Looking for a first analyst role.' }
];

export async function seedDemoData() {
  const pass = await hashPassword(DEMO_PASSWORD);
  const employerIds = [];
  const jobIds = [];
  const seekerIds = [];

  transaction(() => {
    const insUser = db.prepare('INSERT INTO users (name, email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?,?)');
    COMPANIES.forEach((c, i) => {
      const id = Number(insUser.run(c.name, c.email, pass.hash, pass.salt, 'employer', daysAgo(40 - i)).lastInsertRowid);
      employerIds.push(id);
      db.prepare('INSERT INTO companies (user_id, name, industry, size, website, location, about) VALUES (?,?,?,?,?,?,?)')
        .run(id, c.company, c.industry, c.size, c.website, c.location, c.about);
    });

    JOBS.forEach(([ci, title, category, type, mode, location, currency, min, max, ago, description, requirements]) => {
      const id = Number(db.prepare(`INSERT INTO jobs (employer_id, title, category, type, work_mode, location, currency, salary_min, salary_max, description, requirements, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(employerIds[ci], title, category, type, mode, location, currency, min, max, description, requirements, daysAgo(ago, ago * 3), daysAgo(ago, ago * 3)).lastInsertRowid);
      jobIds.push(id);
    });

    SEEKERS.forEach((s, i) => {
      const id = Number(insUser.run(s.name, s.email, pass.hash, pass.salt, 'seeker', daysAgo(30 - i)).lastInsertRowid);
      seekerIds.push(id);
      const file = `${crypto.randomUUID()}.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIR, file), tinyPdf([s.name, s.headline, s.location, '', 'Skills: ' + s.skills, '', s.about]));
      db.prepare('INSERT INTO profiles (user_id, headline, location, phone, skills, about, resume_file, resume_name, resume_size, resume_uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, s.headline, s.location, s.phone, s.skills, s.about, file, `${s.name.replace(' ', '_')}_Resume.pdf`, fs.statSync(path.join(UPLOAD_DIR, file)).size, daysAgo(10));
    });

    // [seekerIndex, jobIndex, status, daysAgo, note]
    const apps = [
      [0, 1, 'interview', 2, 'I redesigned dispatch tooling at my last company and would love to bring that experience to Northwind.'],
      [0, 10, 'reviewing', 1, 'Brand and product are both close to my heart. Portfolio link is in my resume.'],
      [0, 3, 'rejected', 6, ''],
      [1, 0, 'shortlisted', 1, 'Your carrier-integration problem is one I have solved before. Happy to share how.'],
      [1, 11, 'applied', 0, ''],
      [2, 4, 'shortlisted', 2, 'I have built exactly these dashboards for a hospital network.'],
      [2, 3, 'applied', 3, ''],
      [3, 6, 'reviewing', 2, 'I interned in infrastructure investing and would like to continue in that space.'],
      [3, 8, 'applied', 1, 'Excited about the rotation structure.'],
      [1, 1, 'applied', 4, '']
    ];
    for (const [si, ji, status, ago, note] of apps) {
      const prof = db.prepare('SELECT resume_file, resume_name FROM profiles WHERE user_id = ?').get(seekerIds[si]);
      db.prepare('INSERT INTO applications (job_id, seeker_id, cover_note, resume_file, resume_name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(jobIds[ji], seekerIds[si], note, prof.resume_file, prof.resume_name, status, daysAgo(ago, 2), daysAgo(ago));
    }
    db.prepare('INSERT INTO saved_jobs (user_id, job_id) VALUES (?,?)').run(seekerIds[0], jobIds[2]);
    db.prepare('INSERT INTO saved_jobs (user_id, job_id) VALUES (?,?)').run(seekerIds[0], jobIds[11]);
  });
}

// Allow `npm run seed` to be used directly (only when the database is empty).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) {
    console.log('Database already contains users — skipping seed.');
  } else {
    await seedDemoData();
    console.log(`Demo data created. Log in with employer@jobconnect.demo or seeker@jobconnect.demo (password: ${DEMO_PASSWORD}).`);
  }
}
