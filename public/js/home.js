import { api, $, esc, ringsSvg, initial, fmtSalary, timeAgo } from './common.js';
import { jobCard, jobCardSkeletons } from './jobview.js';

$('#hero-rings').innerHTML = ringsSvg();
$('#latest').innerHTML = jobCardSkeletons(4);

const nf = new Intl.NumberFormat('en');
const [stats, cats, hero, latest] = await Promise.all([
  api('/api/stats'), api('/api/categories'), api('/api/jobs?limit=3'), api('/api/jobs?limit=6')
]);

$('#livebar').innerHTML = `
  <span><i class="dot"></i><strong>${nf.format(stats.openJobs)}</strong>open roles</span>
  <span><strong>${nf.format(stats.companies)}</strong>hiring companies</span>
  <span><strong>${nf.format(stats.candidates)}</strong>candidates</span>
  <span><strong>${nf.format(stats.applications)}</strong>applications sent</span>`;

$('#hero-stack').innerHTML = hero.jobs.map((j) => `
  <a class="job-mini" href="/jobs?job=${j.id}" data-job="${j.id}">
    <span class="mono-tile" aria-hidden="true">${esc(initial(j.company_name))}</span>
    <span><span class="t">${esc(j.title)}</span><br><span class="s">${esc(j.company_name)} · ${esc(j.work_mode)}${fmtSalary(j) ? ' · ' + esc(fmtSalary(j)) : ''} · ${timeAgo(j.created_at)}</span></span>
  </a>`).join('');

$('#categories').innerHTML = cats.map((c) => `
  <a class="category" href="/jobs?category=${encodeURIComponent(c.name)}"><b>${esc(c.name)}</b><span>${c.count} open</span></a>`).join('');

$('#latest').innerHTML = latest.jobs.length
  ? latest.jobs.map((j) => jobCard(j)).join('')
  : '<div class="empty"><h3>No openings yet</h3><p>Check back soon, or post the first role as an employer.</p></div>';
