// Turns the recording from record.mjs into lightweight README media:
//   node test/demo/encode.mjs DEMO_DIR ASSETS_DIR
// Writes ASSETS_DIR/demo-live-sync.gif (real time) and
// ASSETS_DIR/demo-slowmo.gif (one action at quarter speed, frame counter).
//
// Captions are placed where each action becomes visible: the offset between
// the script clock and the video is found from the frames themselves.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [dir, assets] = process.argv.slice(2).map((p) => path.resolve(p));
const raw = path.join(dir, 'raw.mp4');
const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FPS = 30;

// Per-frame hashes of each window's browser chrome (tabs, toolbar, bookmarks).
function chromeChanges(x, h = 92) {
  const w = 790;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', raw, '-vf', `crop=${w}:${h}:${x}:0,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const n = w * h;
  const out = [];
  let prev = '';
  for (let i = 0; i * n < buf.length; i++) {
    const hsh = crypto.createHash('md5').update(buf.subarray(i * n, (i + 1) * n)).digest('hex');
    if (i && hsh !== prev) out.push(i / FPS);
    prev = hsh;
  }
  return out;
}
const left = chromeChanges(0);
const right = chromeChanges(805);

// Offset: the first visible change after the first action.
const first = timeline[0];
const actorFirst = (first.text.startsWith('Left') ? left : right).find((t) => t > first.at);
const offset = actorFirst - first.at;
console.log(`video offset ${offset.toFixed(2)} s`);

// Measured from the video: frames between the two windows' changes.
for (const step of timeline) {
  const start = step.at + offset - 0.1;
  const l = left.find((t) => t >= start);
  const r = right.find((t) => t >= start);
  step.video = Math.round(Math.abs(r - l) * 1000);
  console.log(`${step.text}   (on screen: ${Math.round(Math.abs(r - l) * FPS)} frames apart)`);
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const tmp = fs.mkdtempSync(path.join(dir, 'enc-'));

function gif(out, filters, extra = []) {
  const pal = `split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...extra, '-i', raw, '-filter_complex', `${filters},${pal}`, out]);
  console.log(out, Math.round(fs.statSync(out).size / 1024), 'KiB');
}

// 1. Real-time side-by-side: device labels on top, captions below.
const CROP_H = 330;
const TOP = 34;
const BOTTOM = 50;
let f = `[0:v]fps=15,crop=1600:${CROP_H}:0:0,pad=1600:${CROP_H + TOP + BOTTOM}:0:${TOP}:color=0x18181b`;
f += `,drawtext=fontfile=${BOLD}:text='MacBook Pro':fontcolor=white:fontsize=17:x=400-tw/2:y=9`;
f += `,drawtext=fontfile=${BOLD}:text='Linux desktop':fontcolor=white:fontsize=17:x=1200-tw/2:y=9`;
f += `,drawbox=x=799:y=0:w=2:h=${TOP}:color=0x3f3f46:t=fill`;
const capY = TOP + CROP_H + 14;
timeline.forEach((step, i) => {
  const s = step.at + offset;
  const e = i + 1 < timeline.length ? timeline[i + 1].at + offset : 99;
  const file = path.join(tmp, `c${i}.txt`);
  fs.writeFileSync(file, step.text);
  f += `,drawtext=fontfile=${FONT}:textfile='${esc(file)}':fontcolor=0xf0abfc:fontsize=20:x=(w-tw)/2:y=${capY}:enable='between(t,${s.toFixed(2)},${e.toFixed(2)})'`;
});
f += `,drawtext=fontfile=${FONT}:text='Real Helium, real time, synced through a self-hosted Helium Sync server':fontcolor=0xa1a1aa:fontsize=17:x=(w-tw)/2:y=${capY + 2}:enable='lt(t,${(timeline[0].at + offset).toFixed(2)})'`;
gif(path.join(assets, 'demo-live-sync.gif'), f);

// 2. Slow motion of one action (opening a tab), with a millisecond clock.
// The tab-open whose two windows changed furthest apart shows the order best.
const opens = timeline.filter((s) => s.text.includes('open a tab'));
const pick = opens.sort((a, b) => b.video - a.video)[0] || timeline[0];
// Zero = first change of the acting window's tab strip (not its toolbar).
const actorStrip = chromeChanges(pick.text.startsWith('Left') ? 0 : 805, 30);
const s0 = Math.max(0, actorStrip.find((t) => t >= pick.at + offset - 0.1) - 0.2);
console.log(`slow motion: ${pick.text} (${pick.video} ms apart on screen)`);
const SLOW = 4;
let g = `[0:v]trim=start=${s0.toFixed(3)}:duration=0.9,setpts=(PTS-STARTPTS)*${SLOW},fps=15,crop=1600:${92}:0:0,pad=1600:${92 + TOP + BOTTOM}:0:${TOP}:color=0x18181b`;
g += `,drawtext=fontfile=${BOLD}:text='MacBook Pro':fontcolor=white:fontsize=17:x=400-tw/2:y=9`;
g += `,drawtext=fontfile=${BOLD}:text='Linux desktop':fontcolor=white:fontsize=17:x=1200-tw/2:y=9`;
// A plain clock: read off when each window changes.
g += `,drawtext=fontfile=${FONT}:text='4× slower  ·  clock\\: %{eif\\:t*1000/${SLOW}\\:d} ms':fontcolor=0xf0abfc:fontsize=20:x=(w-tw)/2:y=${TOP + 92 + 14}`;
gif(path.join(assets, 'demo-slowmo.gif'), g);

fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline, null, 2));
