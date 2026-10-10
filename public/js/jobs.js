import { api, META, $, esc, icon } from './common.js';
import { jobCard, jobCardSkeletons, openJobDrawer } from './jobview.js';

const form = $('#filter-form');
const results = $('#results');
const fill = (sel, items) => items.forEach((v) => sel.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`));
fill(form.elements.category, META.categories);
fill(form.elements.type, META.jobTypes);
fill(form.elements.mode, META.workModes);

// Restore filters from the URL
const params = new URLSearchParams(location.search);
for (const k of ['q', 'location', 'category', 'type', 'mode']) if (params.get(k)) form.elements[k].value = params.get(k);
let page = Math.max(1, parseInt(params.get('page')) || 1);

$('#filter-toggle').innerHTML = `${icon('filter')}Filters`;
$('#filter-toggle').addEventListener('click', () => $('#filters').classList.toggle('show'));

let seq = 0;
async function load() {
  const mine = ++seq;
  const qs = new URLSearchParams();
  for (const [k, v] of new FormData(form)) if (v) qs.set(k, v);
  if (page > 1) qs.set('page', page);
  history.replaceState(null, '', qs.toString() ? `?${qs}` : location.pathname);
  results.innerHTML = jobCardSkeletons(5);
  try {
    const data = await api(`/api/jobs?${qs}`);
    if (mine !== seq) return;
    $('#count').textContent = data.total === 1 ? '1 open role' : `${data.total.toLocaleString()} open roles`;
    results.innerHTML = data.jobs.length
      ? data.jobs.map((j) => jobCard(j)).join('')
      : `<div class="empty"><h3>No jobs match those filters</h3><p>Try a broader keyword, or clear a filter.</p><button class="btn" id="empty-reset">Clear filters</button></div>`;
    $('#empty-reset')?.addEventListener('click', reset);
    const pager = $('#pager');
    pager.hidden = data.pages <= 1;
    pager.innerHTML = `<button class="btn btn-sm" ${data.page <= 1 ? 'disabled' : ''} data-p="${data.page - 1}">Previous</button>
      <span class="muted small">Page ${data.page} of ${data.pages}</span>
      <button class="btn btn-sm" ${data.page >= data.pages ? 'disabled' : ''} data-p="${data.page + 1}">Next</button>`;
  } catch (err) {
    results.innerHTML = `<div class="empty"><h3>Couldn't load jobs</h3><p>${esc(err.message)}</p><button class="btn" id="retry">Try again</button></div>`;
    $('#retry').addEventListener('click', load);
  }
}

function reset() { form.reset(); page = 1; load(); }
$('#filters-reset').addEventListener('click', reset);
$('#pager').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (b) { page = Number(b.dataset.p); load(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});
form.addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });
form.addEventListener('change', () => { page = 1; load(); });
let timer;
form.addEventListener('input', (e) => {
  if (e.target.tagName !== 'INPUT') return;
  clearTimeout(timer);
  timer = setTimeout(() => { page = 1; load(); }, 300);
});
document.addEventListener('jc:changed', load);

await load();
if (params.get('job')) openJobDrawer(params.get('job'));
