import { $, favicon, h, host, safeUrl, send } from './common.js';

let timer = null;

async function search() {
  const text = $('#q').value.trim();
  const { remote, local } = await send('searchHistory', { text });
  // Merge, newest visit per URL, labelled by where it came from.
  const byUrl = new Map();
  for (const e of local) byUrl.set(e.u, { ...e, src: 'This device' });
  for (const e of remote) {
    const cur = byUrl.get(e.u);
    if (!cur || e.v > cur.v) byUrl.set(e.u, { u: e.u, t: e.t || cur?.t, v: e.v, src: cur ? 'All devices' : 'Other device' });
  }
  const rows = [...byUrl.values()].filter((e) => safeUrl(e.u)).sort((a, b) => b.v - a.v).slice(0, 400);
  const out = [];
  let day = '';
  for (const e of rows) {
    const d = new Date(e.v);
    const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
    if (label !== day) {
      day = label;
      out.push(h('div', { class: 'day' }, label));
    }
    out.push(
      h(
        'a',
        { class: 'entry', href: e.u, title: e.u },
        h('time', {}, d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
        h('img', { class: 'fav', src: favicon(e.u), alt: '' }),
        h('span', { class: 'grow ellipsis' }, e.t || e.u),
        h('span', { class: 'host ellipsis' }, host(e.u)),
        e.src !== 'This device' ? h('span', { class: 'src' }, e.src) : null,
      ),
    );
  }
  if (!out.length) out.push(h('p', { class: 'muted', style: 'margin-top:24px' }, text ? 'No matches.' : 'Nothing synced yet.'));
  $('#results').replaceChildren(...out);
}

$('#q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(search, 150);
});
search();
