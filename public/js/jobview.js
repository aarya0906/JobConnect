/* Job cards + job detail drawer (including the apply + resume upload flow). */
import {
  api, user, esc, $, icon, initial, timeAgo, fmtSalary, fmtBytes, openDrawer, toast, statusBadge,
  dropzoneHtml, wireDropzone, validateResume, uploadResume, withBusy, showFieldErrors
} from './common.js';

export function jobCard(job, { active = false } = {}) {
  const salary = fmtSalary(job);
  return `<button type="button" class="job-card${active ? ' active' : ''}" data-job="${job.id}">
    <span class="mono-tile" aria-hidden="true">${esc(initial(job.company_name))}</span>
    <div>
      <h3>${esc(job.title)}</h3>
      <div class="co">${esc(job.company_name)} · ${esc(job.location)}</div>
      <div class="meta"><span class="chip">${esc(job.type)}</span><span class="chip">${esc(job.work_mode)}</span><span class="chip">${esc(job.category)}</span></div>
    </div>
    <div class="side">
      ${salary ? `<span class="salary">${esc(salary)}</span>` : ''}
      <span class="ago">${timeAgo(job.created_at)}</span>
      ${job.applied ? statusBadge('applied') : ''}
    </div></button>`;
}

export const jobCardSkeletons = (n = 4) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');

/** Open a job in the side drawer. */
export async function openJobDrawer(id) {
  const d = openDrawer({ label: 'Job details', head: '<h2>Loading…</h2>', body: '<div class="skeleton"></div>' });
  try {
    const { job } = await api(`/api/jobs/${id}`);
    renderJob(d, job);
  } catch (err) {
    d.setHead('<h2>Job unavailable</h2>');
    d.body.innerHTML = `<div class="empty"><h3>${esc(err.message)}</h3><a class="btn" href="/jobs">Browse other jobs</a></div>`;
  }
}

function renderJob(d, job) {
  const salary = fmtSalary(job);
  d.setHead(`<h2>${esc(job.title)}</h2><p class="muted" style="margin-top:6px">${esc(job.company_name)} · ${esc(job.location)}</p>`);
  const reqs = (job.requirements || '').split('\n').map((s) => s.trim()).filter(Boolean);

  d.body.innerHTML = `
    <div class="chips">
      <span class="chip">${esc(job.type)}</span><span class="chip">${esc(job.work_mode)}</span><span class="chip">${esc(job.category)}</span>
      ${salary ? `<span class="chip" style="color:var(--silver-100)">${esc(salary)}</span>` : ''}
      <span class="chip">Posted ${timeAgo(job.created_at).toLowerCase()}</span>
    </div>
    <h4>About the role</h4><p class="prose">${esc(job.description)}</p>
    ${reqs.length ? `<h4>What we're looking for</h4><ul class="bullets">${reqs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <h4>About ${esc(job.company_name)}</h4>
    <p class="prose">${esc(job.company_about || 'This company has not added a description yet.')}</p>
    <dl class="kv" style="margin-top:14px">
      ${job.company_industry ? `<dt>Industry</dt><dd>${esc(job.company_industry)}</dd>` : ''}
      ${job.company_size ? `<dt>Team size</dt><dd>${esc(job.company_size)} people</dd>` : ''}
      ${job.company_website ? `<dt>Website</dt><dd><a href="${esc(job.company_website)}" target="_blank" rel="noopener noreferrer">${esc(job.company_website.replace(/^https?:\/\//, ''))}</a></dd>` : ''}
    </dl>
    <div id="apply-slot"></div>`;

  const slot = $('#apply-slot', d.body);
  const next = encodeURIComponent(`/jobs?job=${job.id}`);

  if (!user) {
    slot.innerHTML = `<div class="apply-box"><h3>Apply to this role</h3><p class="muted" style="margin-bottom:16px">Create a free account to upload your resume and apply in under a minute.</p>
      <div class="chips"><a class="btn btn-primary" href="/register?next=${next}">Create account</a><a class="btn" href="/login?next=${next}">Log in</a></div></div>`;
    d.setFoot('');
    return;
  }
  if (user.role === 'employer') {
    slot.innerHTML = `<div class="note" style="margin-top:28px">${icon('info')}<span>You're signed in as an employer, so you can view jobs but not apply. Manage your own listings from the dashboard.</span></div>`;
    d.setFoot('');
    return;
  }
  setupSeekerActions(d, job, slot);
}

function setupSeekerActions(d, job, slot) {
  let saved = job.saved;
  const footHtml = () => `
    <button class="btn" id="save-btn" aria-pressed="${saved}">${icon('bookmark')}${saved ? 'Saved' : 'Save job'}</button>
    ${job.applied ? `<span class="badge" data-status="applied" style="align-self:center">You applied</span>`
      : `<button class="btn btn-primary" id="goto-apply">Apply now</button>`}`;
  d.setFoot(footHtml());

  const wireFoot = () => {
    $('#save-btn', d.foot)?.addEventListener('click', async (e) => {
      const { saved: s } = await api(`/api/jobs/${job.id}/save`, { method: 'POST' }).catch((er) => (toast(er.message, 'error'), { saved }));
      saved = s;
      toast(saved ? 'Job saved' : 'Removed from saved jobs');
      d.setFoot(footHtml());
      wireFoot();
      document.dispatchEvent(new CustomEvent('jc:changed'));
    });
    $('#goto-apply', d.foot)?.addEventListener('click', () => {
      $('.apply-box', d.body)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('textarea', d.body)?.focus({ preventScroll: true });
    });
  };
  wireFoot();

  if (job.applied) {
    slot.innerHTML = `<div class="note" style="margin-top:28px">${icon('check')}<span>You've applied to this role. Track its progress under <a href="/dashboard#applications">My applications</a>.</span></div>`;
    return;
  }

  slot.innerHTML = `<form class="apply-box" novalidate><h3>Apply to ${esc(job.company_name)}</h3>
    <div class="field"><label for="cover">Cover note <span class="muted">(optional)</span></label>
      <textarea id="cover" name="coverNote" class="input" maxlength="3000" placeholder="Tell them why you're a good fit — two or three sentences is plenty."></textarea></div>
    <div class="field" id="resume-field"><span class="field-label">Resume</span><div id="resume-area"><div class="skeleton" style="height:84px"></div></div></div>
    <button class="btn btn-primary btn-block" type="submit">Submit application</button></form>`;
  const form = $('form', slot);
  const area = $('#resume-area', form);
  let pending = null; // newly chosen file

  const showPicker = (hasResume) => {
    area.innerHTML = dropzoneHtml();
    wireDropzone(area, (file) => {
      const err = validateResume(file);
      if (err) { pending = null; return showFieldErrors(form, { resume: err }); }
      pending = file;
      showFieldErrors(form, {});
      showChosen(file.name, file.size, hasResume);
    });
  };
  const showChosen = (name, size, replaceable, isNew = true) => {
    area.innerHTML = `<div class="file-card"><div class="ico">${icon('file')}</div>
      <div class="grow"><div class="title">${esc(name)}</div><div class="small muted">${fmtBytes(size)}${isNew ? ' · will be uploaded with your application' : ' · from your profile'}</div></div>
      <button type="button" class="btn btn-sm" id="change-file">Change</button></div>`;
    $('#change-file', area).addEventListener('click', () => { pending = null; showPicker(replaceable); });
  };

  api('/api/profile').then(({ profile }) => {
    if (profile.has_resume) showChosen(profile.resume_name, profile.resume_size, true, false);
    else showPicker(false);
  }).catch(() => showPicker(false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const hasSaved = !!$('.file-card', area) && !pending;
    if (!pending && !hasSaved) return showFieldErrors(form, { resume: 'Upload your resume to apply.' });
    await withBusy(btn, async () => {
      try {
        if (pending) await uploadResume(pending);
        await api(`/api/jobs/${job.id}/apply`, { method: 'POST', body: { coverNote: form.elements.coverNote.value } });
        job.applied = true;
        toast('Application sent. Good luck!');
        slot.innerHTML = `<div class="note" style="margin-top:28px">${icon('check')}<span>Application sent to ${esc(job.company_name)}. Track its progress under <a href="/dashboard#applications">My applications</a>.</span></div>`;
        d.setFoot(footHtml());
        wireFoot();
        document.dispatchEvent(new CustomEvent('jc:changed'));
      } catch (err) {
        showFieldErrors(form, {}, err.message);
        toast(err.message, 'error');
      }
    });
  });
}

/* Any element with [data-job] opens the drawer. */
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-job]');
  if (trigger && !e.target.closest('[data-no-job]')) {
    e.preventDefault();
    openJobDrawer(trigger.dataset.job);
  }
});
