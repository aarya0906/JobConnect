/* Dashboard — candidate and employer experiences in one hash-routed page. */
import {
  api, META, user, $, $$, esc, icon, initial, timeAgo, fmtDate, fmtSalary, fmtBytes, toast, openDrawer,
  statusBadge, formValues, showFieldErrors, withBusy, dropzoneHtml, wireDropzone, uploadResume, validateResume
} from './common.js';
import { jobCard, jobCardSkeletons } from './jobview.js';

if (!user) {
  location.replace('/login?next=/dashboard');
} else {
  main();
}

function main() {
  const view = $('#view');
  const isEmployer = user.role === 'employer';
  const firstName = user.name.split(' ')[0];
  const PIPE_COLORS = { applied: '#c0c0c0', reviewing: '#d6b46f', shortlisted: '#9ec1ff', interview: '#6b8fd6', hired: '#86cfa0', rejected: '#e28b8b' };
  let applicantsCache = [];
  let token = 0;

  /* ---------- Layout helpers ---------- */
  const head = (title, sub = '', actions = '') =>
    `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="chips">${actions}</div></div>`;
  const stat = (label, value, sub = '') =>
    `<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const empty = (title, text, action = '') => `<div class="empty"><h3>${title}</h3><p>${text}</p>${action}</div>`;
  const loading = () => { view.innerHTML = `<div class="loading"><span class="spinner"></span></div>`; };
  const errorState = (err) => { view.innerHTML = empty('Something went wrong', esc(err.message), '<button class="btn" data-action="reload">Try again</button>'); };
  const avatar = (name) => `<span class="avatar" aria-hidden="true">${esc(initial(name))}</span>`;

  /* ---------- Navigation ---------- */
  const NAV = isEmployer
    ? [['overview', 'Overview', 'dashboard'], ['jobs', 'My jobs', 'briefcase'], ['post', 'Post a job', 'plus'], ['applicants', 'Applicants', 'users'], ['company', 'Company profile', 'building']]
    : [['overview', 'Overview', 'dashboard'], ['applications', 'My applications', 'file'], ['saved', 'Saved jobs', 'bookmark'], ['profile', 'Profile & resume', 'user']];

  $('#sidebar').innerHTML = `
    <div class="who">${avatar(user.name)}<div><div class="name">${esc(user.name)}</div><div class="role">${isEmployer ? 'Employer account' : 'Candidate account'}</div></div></div>
    ${NAV.map(([id, label, ic]) => `<a class="side-link" href="#${id}" data-nav="${id}">${icon(ic)}${label}</a>`).join('')}
    <div class="side-spacer"></div>
    <a class="side-link" href="/jobs">${icon('search')}Browse jobs</a>`;

  const views = isEmployer
    ? { overview: employerOverview, jobs: employerJobs, post: postJob, applicants: employerApplicants, company: companyProfile }
    : { overview: seekerOverview, applications: seekerApplications, saved: seekerSaved, profile: seekerProfile };

  async function render(quiet = false) {
    const [name = 'overview', arg] = location.hash.slice(1).split('?')[0].split('/');
    const id = views[name] ? name : 'overview';
    $$('.side-link[data-nav]').forEach((a) => (a.dataset.nav === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    const mine = ++token;
    if (!quiet) loading();
    const scroll = quiet ? window.scrollY : 0;
    try {
      await views[id](arg, () => mine === token);
    } catch (err) {
      if (mine === token) errorState(err);
    }
    if (mine === token) { document.title = `${NAV.find((n) => n[0] === id)[1]} — JobConnect`; window.scrollTo(0, scroll); }
  }
  window.addEventListener('hashchange', () => render());
  document.addEventListener('jc:changed', () => render(true));

  /* ======================================================================
     CANDIDATE VIEWS
     ====================================================================== */
  async function seekerOverview() {
    const d = await api('/api/seeker/overview');
    const c = d.completeness;
    view.innerHTML = head(`Welcome back, ${esc(firstName)}`, 'Here is where your job search stands.', '<a class="btn btn-primary" href="/jobs">Browse jobs</a>') +
      `<div class="stats">
        ${stat('Applications', d.stats.applications, 'sent so far')}
        ${stat('In progress', d.stats.active, 'in review or shortlisted')}
        ${stat('Interviews', d.stats.interviews, 'invitations')}
        ${stat('Saved jobs', d.stats.saved, 'to revisit')}
      </div>
      <div class="cols"><div>
        <section class="card panel"><div class="panel-head"><h2>Recent applications</h2><a class="btn btn-sm" href="#applications">View all</a></div>
          ${d.recent.length ? `<div class="rows">${d.recent.map((a) => `<div class="row">${avatar(a.company_name)}
            <div class="grow"><div class="title"><a href="/jobs?job=${a.job_id}" data-job="${a.job_id}" style="text-decoration:none">${esc(a.title)}</a></div><div class="sub">${esc(a.company_name)} · applied ${timeAgo(a.created_at).toLowerCase()}</div></div>${statusBadge(a.status)}</div>`).join('')}</div>`
            : empty('No applications yet', 'Find a role you like and apply with your resume.', '<a class="btn btn-primary" href="/jobs">Browse jobs</a>')}
        </section>
        <section class="card panel"><div class="panel-head"><h2>New for you</h2><a class="btn btn-sm" href="/jobs">See more</a></div>
          <div class="job-list">${d.recommended.length ? d.recommended.map((j) => jobCard(j)).join('') : '<p class="muted">You\'ve seen everything for now. Check back soon.</p>'}</div></section>
      </div><div>
        <section class="card panel"><div class="panel-head"><h2>Profile strength</h2><strong>${c.percent}%</strong></div>
          <div class="progress" role="progressbar" aria-valuenow="${c.percent}" aria-valuemin="0" aria-valuemax="100"><i style="width:${c.percent}%"></i></div>
          <ul class="checklist">${c.checks.map((k) => `<li class="${k.ok ? 'ok' : ''}"><span class="tick">${icon('check')}</span>${esc(k.label)}</li>`).join('')}</ul>
          ${c.percent < 100 ? '<a class="btn btn-block" style="margin-top:20px" href="#profile">Complete your profile</a>' : ''}
        </section></div></div>`;
  }

  async function seekerApplications() {
    const { applications } = await api('/api/applications');
    view.innerHTML = head('My applications', 'Every role you have applied to, and where it stands.', '<a class="btn btn-primary" href="/jobs">Find more jobs</a>') +
      (applications.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Role</th><th>Applied</th><th>Status</th><th></th></tr></thead><tbody>
        ${applications.map((a) => `<tr><td><div class="strong">${esc(a.title)}</div><div class="muted small">${esc(a.company_name)} · ${esc(a.location)}${a.job_status === 'closed' ? ' · Role closed' : ''}</div></td>
          <td>${fmtDate(a.created_at)}<div class="muted small">${timeAgo(a.created_at)}</div></td><td>${statusBadge(a.status)}</td>
          <td><div class="actions"><button class="btn btn-sm" data-job="${a.job_id}">View job</button>
          ${['applied', 'reviewing', 'shortlisted', 'interview'].includes(a.status) ? `<button class="btn btn-sm btn-danger" data-action="withdraw" data-id="${a.id}">Withdraw</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>`
        : empty('No applications yet', 'When you apply to a job, it will show up here with live status updates.', '<a class="btn btn-primary" href="/jobs">Browse jobs</a>'));
  }

  async function seekerSaved() {
    const { jobs } = await api('/api/saved');
    view.innerHTML = head('Saved jobs', 'Roles you bookmarked. Open one to apply or remove it.') +
      (jobs.length ? `<div class="job-list">${jobs.map((j) => jobCard(j)).join('')}</div>`
        : empty('Nothing saved yet', 'Use “Save job” on any listing to keep it here for later.', '<a class="btn btn-primary" href="/jobs">Browse jobs</a>'));
  }

  async function seekerProfile() {
    const { profile: p, completeness: c } = await api('/api/profile');
    view.innerHTML = head('Profile & resume', 'Employers see this when you apply. Keep it current.') +
      `<div class="cols"><div>
        <section class="card panel"><div class="panel-head"><h2>Your details</h2></div>
          <form id="profile-form" novalidate><div class="form-grid">
            <div class="field"><label for="p-name">Full name</label><input class="input" id="p-name" name="name" value="${esc(p.name)}" required></div>
            <div class="field"><label for="p-email">Email</label><input class="input" id="p-email" value="${esc(p.email)}" disabled></div>
            <div class="field full"><label for="p-headline">Headline</label><input class="input" id="p-headline" name="headline" maxlength="120" value="${esc(p.headline)}" placeholder="e.g. Product designer with 5 years in fintech"></div>
            <div class="field"><label for="p-location">Location</label><input class="input" id="p-location" name="location" value="${esc(p.location)}" placeholder="City, Country"></div>
            <div class="field"><label for="p-phone">Phone</label><input class="input" id="p-phone" name="phone" value="${esc(p.phone)}" autocomplete="tel"></div>
            <div class="field full"><label for="p-skills">Skills</label><input class="input" id="p-skills" name="skills" value="${esc(p.skills)}" placeholder="Comma separated: Figma, SQL, Public speaking"><span class="hint">Separate skills with commas.</span></div>
            <div class="field full"><label for="p-about">Summary</label><textarea class="input" id="p-about" name="about" maxlength="2000" placeholder="A few lines about your experience and what you're looking for.">${esc(p.about)}</textarea></div>
          </div><button class="btn btn-primary" type="submit">Save changes</button></form></section>
      </div><div>
        <section class="card panel"><div class="panel-head"><h2>Resume</h2></div><div id="resume-panel"></div></section>
        <section class="card panel"><div class="panel-head"><h2>Profile strength</h2><strong id="pct">${c.percent}%</strong></div>
          <div class="progress"><i id="pbar" style="width:${c.percent}%"></i></div>
          <ul class="checklist" id="checks">${checks(c)}</ul></section>
      </div></div>`;

    const renderResume = (pr) => {
      const panel = $('#resume-panel');
      panel.innerHTML = pr.has_resume
        ? `<div class="file-card"><div class="ico">${icon('file')}</div><div class="grow"><div class="title">${esc(pr.resume_name)}</div>
            <div class="small muted">${fmtBytes(pr.resume_size)} · uploaded ${timeAgo(pr.resume_uploaded_at).toLowerCase()}</div></div></div>
           <div class="chips" style="margin-top:14px"><a class="btn btn-sm" href="/api/profile/resume">${icon('download')}Download</a>
           <button class="btn btn-sm btn-danger" data-action="remove-resume">Remove</button></div>
           <p class="small muted" style="margin:18px 0 10px">Replace it with a newer version:</p>${dropzoneHtml()}`
        : `<p class="muted small" style="margin-bottom:14px">Upload your resume once — it's attached automatically whenever you apply.</p>${dropzoneHtml()}`;
      wireDropzone(panel, async (file, input) => {
        const err = validateResume(file);
        if (err) { input.value = ''; return toast(err, 'error'); }
        const zone = $('[data-dropzone]', panel);
        zone.innerHTML = '<span class="spinner" style="margin:6px auto"></span><strong>Uploading…</strong>';
        try {
          const out = await uploadResume(file);
          toast('Resume uploaded');
          renderResume(out.profile);
          updateChecks(out.completeness);
        } catch (e) { toast(e.message, 'error'); renderResume(pr); }
      });
    };
    function updateChecks(c2) {
      $('#pct').textContent = c2.percent + '%';
      $('#pbar').style.width = c2.percent + '%';
      $('#checks').innerHTML = checks(c2);
    }
    renderResume(p);
    view.dataset.profile = '1';

    $('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      showFieldErrors(form, {});
      await withBusy($('button[type=submit]', form), async () => {
        try {
          const out = await api('/api/profile', { method: 'PUT', body: formValues(form) });
          toast('Profile saved');
          updateChecks(out.completeness);
        } catch (err) { showFieldErrors(form, err.fields, err.message); }
      });
    });
    view._renderResume = renderResume;
    view._updateChecks = updateChecks;
  }
  const checks = (c) => c.checks.map((k) => `<li class="${k.ok ? 'ok' : ''}"><span class="tick">${icon('check')}</span>${esc(k.label)}</li>`).join('');

  /* ======================================================================
     EMPLOYER VIEWS
     ====================================================================== */
  async function employerOverview() {
    const d = await api('/api/employer/overview');
    const s = d.stats;
    const keys = ['applied', 'reviewing', 'shortlisted', 'interview', 'hired', 'rejected'];
    const total = keys.reduce((n, k) => n + d.pipeline[k], 0);
    view.innerHTML = head(`Welcome back, ${esc(firstName)}`, 'Your hiring activity at a glance.', '<a class="btn btn-primary" href="#post">' + icon('plus') + 'Post a job</a>') +
      `<div class="stats">
        ${stat('Open jobs', s.openJobs, `${s.totalJobs} posted in total`)}
        ${stat('Applicants', s.applicants, 'across all jobs')}
        ${stat('To review', s.toReview, 'new applications')}
        ${stat('Shortlisted', s.shortlisted, 'shortlisted or interviewing')}
      </div>
      <div class="cols"><div>
        <section class="card panel"><div class="panel-head"><h2>Recent applicants</h2><a class="btn btn-sm" href="#applicants">View all</a></div>
          ${d.recent.length ? `<div class="rows">${d.recent.map((a) => `<div class="row">${avatar(a.name)}
            <div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${esc(a.job_title)} · ${timeAgo(a.created_at).toLowerCase()}</div></div>
            ${statusBadge(a.status)}<button class="btn btn-sm" data-action="view-applicant" data-id="${a.id}">View</button></div>`).join('')}</div>`
            : empty('No applicants yet', 'Applications will appear here as soon as candidates apply.', '<a class="btn btn-primary" href="#post">Post a job</a>')}
        </section>
        <section class="card panel"><div class="panel-head"><h2>Jobs by applicants</h2><a class="btn btn-sm" href="#jobs">Manage jobs</a></div>
          ${d.topJobs.length ? `<div class="rows">${d.topJobs.map((j) => `<div class="row"><div class="grow"><div class="title">${esc(j.title)}</div><div class="sub">${esc(j.location)} · ${esc(j.type)}</div></div>
            ${statusBadge(j.status)}<a class="btn btn-sm" href="#applicants/${j.id}">${j.applicants} applicant${j.applicants === 1 ? '' : 's'}</a></div>`).join('')}</div>`
            : empty('No jobs yet', 'Post your first role to start receiving applications.')}
        </section>
      </div><div>
        <section class="card panel"><div class="panel-head"><h2>Hiring pipeline</h2></div>
          ${total ? `<div class="pipeline" role="img" aria-label="Applicants by stage">${keys.filter((k) => d.pipeline[k]).map((k) => `<i style="flex:${d.pipeline[k]};background:${PIPE_COLORS[k]}"></i>`).join('')}</div>
          <div class="legend">${keys.map((k) => `<div><span><i style="background:${PIPE_COLORS[k]}"></i>${esc(META.statuses[k])}</span><strong>${d.pipeline[k]}</strong></div>`).join('')}</div>`
            : '<p class="muted">Your pipeline will appear once candidates apply.</p>'}
        </section></div></div>`;
  }

  async function employerJobs() {
    const { jobs } = await api('/api/employer/jobs');
    view.innerHTML = head('My jobs', 'Create, edit and close your openings.', `<a class="btn btn-primary" href="#post">${icon('plus')}Post a job</a>`) +
      (jobs.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Role</th><th>Status</th><th>Applicants</th><th>Posted</th><th></th></tr></thead><tbody>
        ${jobs.map((j) => `<tr><td><div class="strong">${esc(j.title)}</div><div class="muted small">${esc(j.location)} · ${esc(j.type)} · ${esc(j.work_mode)}</div></td>
          <td>${statusBadge(j.status)}</td><td><a href="#applicants/${j.id}">${j.applicants}</a></td><td>${fmtDate(j.created_at)}</td>
          <td><div class="actions"><button class="btn btn-sm" data-job="${j.id}" title="Preview">${icon('eye')}</button>
            <a class="btn btn-sm" href="#post/${j.id}">${icon('edit')}Edit</a>
            <button class="btn btn-sm" data-action="toggle-job" data-id="${j.id}" data-status="${j.status === 'open' ? 'closed' : 'open'}">${j.status === 'open' ? 'Close' : 'Reopen'}</button>
            <button class="btn btn-sm btn-danger btn-icon" data-action="delete-job" data-id="${j.id}" data-title="${esc(j.title)}" aria-label="Delete ${esc(j.title)}">${icon('trash')}</button></div></td></tr>`).join('')}
        </tbody></table></div>`
        : empty('No jobs posted yet', 'Describe a role, set a pay range and publish it in a couple of minutes.', '<a class="btn btn-primary" href="#post">Post your first job</a>'));
  }

  async function postJob(editId) {
    let j = { currency: 'USD', type: 'Full-time', work_mode: 'On-site' };
    if (editId) j = (await api(`/api/jobs/${Number(editId)}`)).job;
    const opts = (list, cur) => list.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
    view.innerHTML = head(editId ? 'Edit job' : 'Post a job', editId ? 'Changes are visible to candidates immediately.' : 'Candidates will see this on the job board as soon as you publish.') +
      `<section class="card panel" style="max-width:860px"><form id="job-form" novalidate><div class="form-grid">
        <div class="field full"><label for="j-title">Job title</label><input class="input" id="j-title" name="title" maxlength="120" value="${esc(j.title)}" placeholder="e.g. Senior Product Designer"></div>
        <div class="field"><label for="j-category">Field</label><select class="input" id="j-category" name="category"><option value="">Choose a field</option>${opts(META.categories, j.category)}</select></div>
        <div class="field"><label for="j-type">Employment type</label><select class="input" id="j-type" name="type">${opts(META.jobTypes, j.type)}</select></div>
        <div class="field"><label for="j-mode">Work mode</label><select class="input" id="j-mode" name="work_mode">${opts(META.workModes, j.work_mode)}</select></div>
        <div class="field"><label for="j-location">Location</label><input class="input" id="j-location" name="location" maxlength="100" value="${esc(j.location)}" placeholder="City, Country (or Anywhere)"></div>
        <div class="field"><label for="j-currency">Currency</label><select class="input" id="j-currency" name="currency">${opts(META.currencies, j.currency)}</select></div>
        <div class="field"><span class="field-label">Pay range</span><div class="form-grid" style="gap:10px"><input class="input" name="salary_min" type="number" min="0" step="any" value="${j.salary_min ?? ''}" placeholder="Minimum" aria-label="Minimum pay"><input class="input" name="salary_max" type="number" min="0" step="any" value="${j.salary_max ?? ''}" placeholder="Maximum" aria-label="Maximum pay"></div><span class="hint">Per year, or per month for contracts. Optional.</span></div>
        <div class="field full"><label for="j-desc">Description</label><textarea class="input" id="j-desc" name="description" style="min-height:180px" maxlength="8000" placeholder="What will this person do, and what will they own in their first months?">${esc(j.description)}</textarea></div>
        <div class="field full"><label for="j-req">Requirements</label><textarea class="input" id="j-req" name="requirements" maxlength="4000" placeholder="One requirement per line">${esc(j.requirements)}</textarea><span class="hint">Put each requirement on its own line.</span></div>
      </div><div class="chips"><button class="btn btn-primary" type="submit">${editId ? 'Save changes' : 'Publish job'}</button><a class="btn" href="#jobs">Cancel</a></div></form></section>`;

    $('#job-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      showFieldErrors(form, {});
      await withBusy($('button[type=submit]', form), async () => {
        try {
          await api(editId ? `/api/employer/jobs/${Number(editId)}` : '/api/employer/jobs', { method: editId ? 'PUT' : 'POST', body: formValues(form) });
          toast(editId ? 'Job updated' : 'Job published');
          location.hash = '#jobs';
        } catch (err) { showFieldErrors(form, err.fields, err.message); }
      });
    });
  }

  async function employerApplicants(jobId) {
    const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
    const qs = new URLSearchParams();
    if (jobId) qs.set('job_id', jobId);
    if (status) qs.set('status', status);
    const [{ applicants }, { jobs }] = await Promise.all([api(`/api/employer/applicants?${qs}`), api('/api/employer/jobs')]);
    applicantsCache = applicants;
    view.innerHTML = head('Applicants', 'Review resumes and move candidates through your pipeline.') +
      `<div class="toolbar"><select class="input" id="flt-job" aria-label="Filter by job"><option value="">All jobs</option>${jobs.map((j) => `<option value="${j.id}"${String(j.id) === String(jobId) ? ' selected' : ''}>${esc(j.title)}</option>`).join('')}</select>
        <select class="input" id="flt-status" aria-label="Filter by status"><option value="">Any status</option>${Object.entries(META.statuses).map(([k, v]) => `<option value="${k}"${k === status ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>` +
      (applicants.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Candidate</th><th>Applied for</th><th>Applied</th><th>Status</th><th></th></tr></thead><tbody>
        ${applicants.map((a) => `<tr><td><div class="row" style="border:0;padding:0">${avatar(a.name)}<div class="grow"><div class="strong">${esc(a.name)}</div><div class="muted small">${esc(a.headline || a.email)}</div></div></div></td>
          <td>${esc(a.job_title)}</td><td>${timeAgo(a.created_at)}</td><td>${statusControl(a)}</td>
          <td><div class="actions">${a.has_resume ? `<a class="btn btn-sm" href="/api/applications/${a.id}/resume" aria-label="Download resume of ${esc(a.name)}">${icon('download')}Resume</a>` : ''}
          <button class="btn btn-sm" data-action="view-applicant" data-id="${a.id}">View</button></div></td></tr>`).join('')}
        </tbody></table></div>`
        : empty('No applicants match', jobId || status ? 'Try a different job or status.' : 'Applications will appear here once candidates apply to your jobs.'));
    const go = () => {
      const q = new URLSearchParams();
      if ($('#flt-status').value) q.set('status', $('#flt-status').value);
      location.hash = `#applicants${$('#flt-job').value ? '/' + $('#flt-job').value : ''}${q.toString() ? '?' + q : ''}`;
    };
    $('#flt-job').addEventListener('change', go);
    $('#flt-status').addEventListener('change', go);
  }
  const statusControl = (a) => a.status === 'withdrawn'
    ? statusBadge('withdrawn')
    : `<select class="input" data-action="status" data-id="${a.id}" aria-label="Status for ${esc(a.name)}" style="min-width:150px;padding:8px 34px 8px 12px;font-size:.875rem">
        ${Object.entries(META.statuses).filter(([k]) => k !== 'withdrawn').map(([k, v]) => `<option value="${k}"${k === a.status ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;

  async function companyProfile() {
    const { company: c } = await api('/api/company');
    view.innerHTML = head('Company profile', 'Candidates see this on every job you post.') +
      `<section class="card panel" style="max-width:860px"><form id="company-form" novalidate><div class="form-grid">
        <div class="field full"><label for="c-name">Company name</label><input class="input" id="c-name" name="name" value="${esc(c.name)}" required></div>
        <div class="field"><label for="c-industry">Industry</label><input class="input" id="c-industry" name="industry" value="${esc(c.industry)}" placeholder="e.g. Software, Healthcare"></div>
        <div class="field"><label for="c-size">Company size</label><select class="input" id="c-size" name="size"><option value="">Select size</option>${META.companySizes.map((s) => `<option value="${s}"${s === c.size ? ' selected' : ''}>${s} people</option>`).join('')}</select></div>
        <div class="field"><label for="c-website">Website</label><input class="input" id="c-website" name="website" value="${esc(c.website)}" placeholder="https://yourcompany.com"></div>
        <div class="field"><label for="c-location">Headquarters</label><input class="input" id="c-location" name="location" value="${esc(c.location)}" placeholder="City, Country"></div>
        <div class="field full"><label for="c-about">About the company</label><textarea class="input" id="c-about" name="about" style="min-height:150px" maxlength="3000" placeholder="What you do, who you serve and what it's like to work with you.">${esc(c.about)}</textarea></div>
      </div><button class="btn btn-primary" type="submit">Save changes</button></form></section>`;
    $('#company-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      showFieldErrors(form, {});
      await withBusy($('button[type=submit]', form), async () => {
        try { await api('/api/company', { method: 'PUT', body: formValues(form) }); toast('Company profile saved'); }
        catch (err) { showFieldErrors(form, err.fields, err.message); }
      });
    });
  }

  /* ---------- Applicant drawer ---------- */
  function openApplicant(a) {
    const skills = (a.skills || '').split(',').map((s) => s.trim()).filter(Boolean);
    const d = openDrawer({
      label: 'Applicant details',
      head: `<h2>${esc(a.name)}</h2><p class="muted" style="margin-top:6px">${esc(a.headline || 'No headline added')}</p>`,
      body: `<div class="chips">${statusBadge(a.status)}<span class="chip">Applied ${esc(timeAgo(a.created_at).toLowerCase())}</span></div>
        <h4>Applied for</h4><p style="color:var(--silver-100);font-weight:600">${esc(a.job_title)}</p>
        <h4>Contact</h4><dl class="kv"><dt>Email</dt><dd><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></dd>
          ${a.phone ? `<dt>Phone</dt><dd>${esc(a.phone)}</dd>` : ''}${a.location ? `<dt>Location</dt><dd>${esc(a.location)}</dd>` : ''}</dl>
        ${skills.length ? `<h4>Skills</h4><div class="chips">${skills.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
        ${a.about ? `<h4>Summary</h4><p class="prose">${esc(a.about)}</p>` : ''}
        <h4>Cover note</h4><p class="prose">${a.cover_note ? esc(a.cover_note) : '<span class="muted">No cover note was included.</span>'}</p>
        <h4>Resume</h4>${a.has_resume ? `<div class="file-card"><div class="ico">${icon('file')}</div><div class="grow"><div class="title">${esc(a.resume_name)}</div></div>
          <a class="btn btn-sm" href="/api/applications/${a.id}/resume">${icon('download')}Download</a></div>` : '<p class="muted">No resume attached.</p>'}`,
      foot: a.status === 'withdrawn' ? '<span class="muted small">The candidate withdrew this application.</span>'
        : `<label class="field-label" for="drawer-status" style="align-self:center">Status</label>${statusControl({ ...a, name: a.name }).replace('data-action="status"', 'id="drawer-status" data-action="status"')}`
    });
    return d;
  }

  /* ---------- Event delegation ---------- */
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'SELECT') return;
    const { action, id } = el.dataset;
    try {
      if (action === 'reload') render();
      else if (action === 'withdraw') {
        if (!confirm('Withdraw this application? The employer will see it as withdrawn.')) return;
        await api(`/api/applications/${id}/withdraw`, { method: 'POST' });
        toast('Application withdrawn');
        render(true);
      } else if (action === 'remove-resume') {
        if (!confirm('Remove your resume? You will need to upload one again before applying.')) return;
        const out = await api('/api/profile/resume', { method: 'DELETE' });
        toast('Resume removed');
        view._renderResume?.(out.profile); view._updateChecks?.(out.completeness);
      } else if (action === 'toggle-job') {
        await api(`/api/employer/jobs/${id}/status`, { method: 'POST', body: { status: el.dataset.status } });
        toast(el.dataset.status === 'open' ? 'Job reopened' : 'Job closed');
        render(true);
      } else if (action === 'delete-job') {
        if (!confirm(`Delete “${el.dataset.title}”? Its applications will be removed too. This can't be undone.`)) return;
        await api(`/api/employer/jobs/${id}`, { method: 'DELETE' });
        toast('Job deleted');
        render(true);
      } else if (action === 'view-applicant') {
        const a = applicantsCache.find((x) => String(x.id) === id) || (await api('/api/employer/applicants')).applicants.find((x) => String(x.id) === id);
        if (a) { if (!applicantsCache.includes(a)) applicantsCache.push(a); openApplicant(a); }
      }
    } catch (err) { toast(err.message, 'error'); }
  });

  document.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-action="status"]');
    if (!sel) return;
    const id = sel.dataset.id;
    try {
      await api(`/api/applications/${id}/status`, { method: 'POST', body: { status: sel.value } });
      const a = applicantsCache.find((x) => String(x.id) === id);
      if (a) a.status = sel.value;
      toast(`Status updated to ${META.statuses[sel.value]}`);
      // keep any other control for the same applicant in sync (table row <-> drawer)
      $$(`select[data-action="status"][data-id="${id}"]`).forEach((s) => { s.value = sel.value; });
    } catch (err) {
      toast(err.message, 'error');
      const a = applicantsCache.find((x) => String(x.id) === id);
      if (a) sel.value = a.status;
    }
  });

  render();
}
